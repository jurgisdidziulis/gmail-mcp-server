import { ImapFlow, type ImapFlowOptions } from "imapflow";
import PostalMime, { type Address } from "postal-mime";
import type { EmailDetail, EmailSummary } from "./gmail-service.js";

export interface HostingerImapConfig {
  account: string;
  password: string;
  host: "imap.hostinger.com";
  port: 993;
  secure: true;
}

type Environment = Record<string, string | undefined>;

export function getHostingerImapConfig(
  env: Environment = process.env
): HostingerImapConfig | null {
  if (env.HOSTINGER_IMAP_ENABLED?.trim().toLowerCase() !== "true") {
    return null;
  }

  const account = env.HOSTINGER_IMAP_ACCOUNT?.trim().toLowerCase();
  if (!account) {
    throw new Error("HOSTINGER_IMAP_ACCOUNT is required when Hostinger IMAP is enabled");
  }
  if (account !== "jurgis@in.lt") {
    throw new Error("HOSTINGER_IMAP_ACCOUNT must be jurgis@in.lt");
  }
  const password = env.HOSTINGER_IMAP_PASSWORD;
  if (!password) {
    throw new Error("HOSTINGER_IMAP_PASSWORD is required when Hostinger IMAP is enabled");
  }

  return {
    account,
    password,
    host: "imap.hostinger.com",
    port: 993,
    secure: true,
  };
}

export interface ImapSearchQuery {
  all?: true;
  seen?: boolean;
  since?: Date;
  from?: string;
  subject?: string;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

export function toImapSearch(
  query = "",
  now = new Date()
): ImapSearchQuery {
  const trimmed = query.trim();
  if (!trimmed) return { all: true };

  const tokens = trimmed.match(/[a-z_]+:"[^"]*"|\S+/gi) ?? [];
  const search: ImapSearchQuery = {};

  for (const token of tokens) {
    if (token.toLowerCase() === "is:unread") {
      search.seen = false;
      continue;
    }
    if (token.toLowerCase() === "is:read") {
      search.seen = true;
      continue;
    }

    const newerThan = token.match(/^newer_than:(\d+)d$/i);
    if (newerThan) {
      const days = Number(newerThan[1]);
      if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
        throw new Error(`Unsupported Hostinger search token: ${token}`);
      }
      search.since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      continue;
    }

    const from = token.match(/^from:(.+)$/i);
    if (from) {
      search.from = unquote(from[1]);
      continue;
    }

    const subject = token.match(/^subject:(.+)$/i);
    if (subject) {
      search.subject = unquote(subject[1]);
      continue;
    }

    throw new Error(`Unsupported Hostinger search token: ${token}`);
  }

  return search;
}

interface EncodedMessageId {
  mailbox: "INBOX";
  uidValidity: string;
  uid: number;
}

export function encodeImapMessageId(
  uidValidity: string,
  uid: number
): string {
  return `imap:${Buffer.from(
    JSON.stringify({ mailbox: "INBOX", uidValidity, uid }),
    "utf8"
  ).toString("base64url")}`;
}

export function decodeImapMessageId(messageId: string): EncodedMessageId {
  try {
    if (!messageId.startsWith("imap:")) throw new Error("prefix");
    const value = JSON.parse(
      Buffer.from(messageId.slice("imap:".length), "base64url").toString("utf8")
    ) as Partial<EncodedMessageId>;
    if (
      value.mailbox !== "INBOX" ||
      typeof value.uidValidity !== "string" ||
      !/^\d+$/.test(value.uidValidity) ||
      !Number.isSafeInteger(value.uid) ||
      Number(value.uid) < 1
    ) {
      throw new Error("shape");
    }
    return value as EncodedMessageId;
  } catch {
    throw new Error("Invalid Hostinger message ID");
  }
}

interface ImapClientLike {
  mailbox?:
    | {
        uidValidity: bigint;
        exists?: number;
        path?: string;
        readOnly?: boolean;
      }
    | false;
  connect(): Promise<unknown>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<unknown>;
  search(query: ImapSearchQuery, options: { uid: true }): Promise<number[] | false>;
  fetchAll(
    range: string,
    query: {
      uid: true;
      envelope: true;
      flags: true;
      internalDate: true;
    },
    options: { uid: true }
  ): Promise<
    Array<{
      uid: number;
      envelope?: {
        subject?: string;
        from?: Array<{ name?: string; address?: string }>;
        date?: Date;
      };
      flags?: Set<string>;
      internalDate?: Date | string;
    }>
  >;
  fetchOne(
    uid: number,
    query: {
      uid: true;
      envelope: true;
      flags: true;
      internalDate: true;
      source: true;
    },
    options: { uid: true }
  ): Promise<
    | {
        uid: number;
        source?: Buffer;
        flags?: Set<string>;
        internalDate?: Date | string;
      }
    | false
  >;
  logout(): Promise<unknown>;
}

interface ImapReadServiceDependencies {
  clientFactory?: (config: ImapFlowOptions) => ImapClientLike;
}

function formatAddress(address?: { name?: string; address?: string }): string {
  if (!address) return "";
  if (address.name && address.address) return `${address.name} <${address.address}>`;
  return address.address ?? address.name ?? "";
}

function formatPostalAddress(address?: Address): string {
  if (!address) return "";
  if (Array.isArray(address.group)) {
    return address.group.map((member) => formatPostalAddress(member)).join(", ");
  }
  const mailbox = address as { name: string; address: string };
  if (mailbox.name && mailbox.address) {
    return `${mailbox.name} <${mailbox.address}>`;
  }
  return mailbox.address ?? mailbox.name ?? "";
}

class StaleHostingerMessageIdError extends Error {
  constructor() {
    super("Hostinger message ID is stale; list the mailbox again");
  }
}

export class ImapReadService {
  private readonly clientFactory: (config: ImapFlowOptions) => ImapClientLike;

  constructor(
    private readonly config: HostingerImapConfig,
    dependencies: ImapReadServiceDependencies = {}
  ) {
    this.clientFactory =
      dependencies.clientFactory ??
      ((options) => new ImapFlow(options) as unknown as ImapClientLike);
  }

  async checkConnection(): Promise<{
    account: string;
    provider: "hostinger-imap";
    mailbox: "INBOX";
    read_only: true;
    messages: number;
  }> {
    const client = this.clientFactory({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.account, pass: this.config.password },
      tls: { rejectUnauthorized: true },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      maxLineLength: 1024 * 1024,
      maxLiteralSize: 25 * 1024 * 1024,
    });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      await client.mailboxOpen("INBOX", { readOnly: true });
      if (!client.mailbox) throw new Error("mailbox unavailable");
      return {
        account: this.config.account,
        provider: "hostinger-imap",
        mailbox: "INBOX",
        read_only: true,
        messages: client.mailbox.exists ?? 0,
      };
    } catch {
      throw new Error("Hostinger IMAP connection failed");
    } finally {
      if (connected) await client.logout().catch(() => undefined);
    }
  }

  async listEmails(
    query?: string,
    maxResults = 20
  ): Promise<EmailSummary[]> {
    const client = this.clientFactory({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.account,
        pass: this.config.password,
      },
      tls: { rejectUnauthorized: true },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      maxLineLength: 1024 * 1024,
      maxLiteralSize: 25 * 1024 * 1024,
    });

    let connected = false;
    try {
      await client.connect();
      connected = true;
      await client.mailboxOpen("INBOX", { readOnly: true });
      if (!client.mailbox) {
        throw new Error("mailbox unavailable");
      }
      const uidValidity = client.mailbox.uidValidity.toString();
      const matches = await client.search(toImapSearch(query), { uid: true });
      if (!matches || matches.length === 0) return [];

      const limit = Math.max(1, Math.min(Math.floor(maxResults), 100));
      const selected = matches.slice(-limit).reverse();
      const messages = await client.fetchAll(
        selected.join(","),
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
        },
        { uid: true }
      );

      return messages
        .sort((left, right) => right.uid - left.uid)
        .map((message) => {
          const id = encodeImapMessageId(uidValidity, message.uid);
          const date = message.envelope?.date ?? message.internalDate;
          return {
            id,
            threadId: id,
            subject: message.envelope?.subject ?? "",
            from: formatAddress(message.envelope?.from?.[0]),
            date: date ? new Date(date).toISOString() : "",
            snippet: "",
            labelIds: [...(message.flags ?? [])],
          };
        });
    } catch {
      throw new Error("Hostinger IMAP connection failed");
    } finally {
      if (connected) {
        await client.logout().catch(() => undefined);
      }
    }
  }

  async getEmail(messageId: string): Promise<EmailDetail> {
    const decoded = decodeImapMessageId(messageId);
    const client = this.clientFactory({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.account,
        pass: this.config.password,
      },
      tls: { rejectUnauthorized: true },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      maxLineLength: 1024 * 1024,
      maxLiteralSize: 25 * 1024 * 1024,
    });

    let connected = false;
    try {
      await client.connect();
      connected = true;
      await client.mailboxOpen("INBOX", { readOnly: true });
      if (!client.mailbox) throw new Error("mailbox unavailable");
      if (client.mailbox.uidValidity.toString() !== decoded.uidValidity) {
        throw new StaleHostingerMessageIdError();
      }

      const message = await client.fetchOne(
        decoded.uid,
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          source: true,
        },
        { uid: true }
      );
      if (!message || !message.source) {
        throw new Error("message unavailable");
      }

      const parsed = await PostalMime.parse(message.source, {
        attachmentEncoding: "arraybuffer",
        maxNestingDepth: 10,
        maxHeadersSize: 256 * 1024,
      });
      const headers: Record<string, string> = {};
      for (const header of parsed.headers) {
        headers[header.originalKey] = header.value;
      }
      const date = parsed.date ?? message.internalDate;
      const id = encodeImapMessageId(decoded.uidValidity, decoded.uid);

      return {
        id,
        threadId: id,
        subject: parsed.subject ?? "",
        from: formatPostalAddress(parsed.from),
        to: (parsed.to ?? []).map((address) => formatPostalAddress(address)).join(", "),
        date: date ? new Date(date).toISOString() : "",
        snippet: "",
        body: parsed.text ?? parsed.html ?? "",
        labelIds: [...(message.flags ?? [])],
        headers,
        attachments: [],
        unsubscribeLinks: [],
      };
    } catch (error) {
      if (error instanceof StaleHostingerMessageIdError) throw error;
      throw new Error("Hostinger IMAP connection failed");
    } finally {
      if (connected) {
        await client.logout().catch(() => undefined);
      }
    }
  }

  async batchProcess(query: string, maxResults = 20): Promise<EmailSummary[]> {
    return this.listEmails(query, maxResults);
  }
}
