import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import PostalMime, { type Address } from "postal-mime";
import {
  claimPageTokenReplay,
  type EmailDetail,
  type EmailPage,
  type ThreadPage,
} from "./gmail-service.js";

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
  before?: Date;
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
  if ((trimmed.match(/"/g)?.length ?? 0) % 2 !== 0) {
    throw new Error("Malformed Hostinger search query: unterminated quote");
  }

  const tokens: string[] = [];
  const tokenPattern = /[a-z_]+:"[^"]*"|\S+/gi;
  let cursor = 0;
  for (const match of trimmed.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (!/^\s*$/.test(trimmed.slice(cursor, index))) {
      throw new Error("Malformed Hostinger search query");
    }
    tokens.push(match[0]);
    cursor = index + match[0].length;
  }
  if (!/^\s*$/.test(trimmed.slice(cursor))) {
    throw new Error("Malformed Hostinger search query");
  }
  const search: ImapSearchQuery = {};
  const seenTokens = new Set<string>();
  const claim = (name: string) => {
    if (seenTokens.has(name)) {
      throw new Error(`Duplicate Hostinger search token: ${name}`);
    }
    seenTokens.add(name);
  };

  for (const token of tokens) {
    if (token.toLowerCase() === "is:unread") {
      if (seenTokens.has("read state")) {
        throw new Error("Duplicate or contradictory Hostinger read state token");
      }
      seenTokens.add("read state");
      search.seen = false;
      continue;
    }
    if (token.toLowerCase() === "is:read") {
      if (seenTokens.has("read state")) {
        throw new Error("Duplicate or contradictory Hostinger read state token");
      }
      seenTokens.add("read state");
      search.seen = true;
      continue;
    }

    const newerThan = token.match(/^newer_than:(\d+)d$/i);
    if (newerThan) {
      claim("after/newer_than");
      const days = Number(newerThan[1]);
      if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
        throw new Error(`Unsupported Hostinger search token: ${token}`);
      }
      search.since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      continue;
    }

    const after = token.match(/^after:(\d+)$/i);
    if (after) {
      claim("after");
      if (seenTokens.has("after/newer_than")) {
        throw new Error("Conflicting Hostinger after and newer_than tokens");
      }
      seenTokens.add("after/newer_than");
      const epochSeconds = Number(after[1]);
      if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) {
        throw new Error(`Unsupported Hostinger search token: ${token}`);
      }
      search.since = new Date(epochSeconds * 1000);
      continue;
    }

    const before = token.match(/^before:(\d+)$/i);
    if (before) {
      claim("before");
      const epochSeconds = Number(before[1]);
      if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) {
        throw new Error(`Unsupported Hostinger search token: ${token}`);
      }
      search.before = new Date(epochSeconds * 1000);
      continue;
    }

    const from = token.match(/^from:(.+)$/i);
    if (from) {
      claim("from");
      search.from = unquote(from[1]);
      continue;
    }

    const subject = token.match(/^subject:(.+)$/i);
    if (subject) {
      claim("subject");
      search.subject = unquote(subject[1]);
      continue;
    }

    throw new Error(`Unsupported Hostinger search token: ${token}`);
  }

  if (search.since && search.before && search.since >= search.before) {
    throw new Error("Hostinger after bound must be earlier than before bound");
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

interface ImapPageToken {
  version: 2;
  provider: "hostinger-imap";
  accountBinding: string;
  mailbox: "INBOX";
  uidValidity: string;
  queryHash: string;
  upperUid: number;
  beforeUid: number;
  signature: string;
}

class HostingerCompletenessError extends Error {}

function imapQueryHash(query?: string): string {
  return createHash("sha256").update((query ?? "").trim()).digest("base64url");
}

type UnsignedImapPageToken = Omit<ImapPageToken, "signature">;

function signImapPageToken(value: UnsignedImapPageToken, key: string): string {
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("base64url");
}

function encodeImapPageToken(value: UnsignedImapPageToken, key: string): string {
  return Buffer.from(JSON.stringify({
    ...value,
    signature: signImapPageToken(value, key),
  }), "utf8").toString("base64url");
}

function decodeImapPageToken(
  token: string,
  key: string,
  accountBinding: string
): ImapPageToken {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== token) {
      throw new Error("non-canonical");
    }
    const value = JSON.parse(decoded) as Partial<ImapPageToken>;
    if (
      value.version !== 2 ||
      value.provider !== "hostinger-imap" ||
      value.accountBinding !== accountBinding ||
      value.mailbox !== "INBOX" ||
      typeof value.uidValidity !== "string" || !/^\d+$/.test(value.uidValidity) ||
      typeof value.queryHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.queryHash) ||
      !Number.isSafeInteger(value.upperUid) || Number(value.upperUid) < 1 ||
      !Number.isSafeInteger(value.beforeUid) || Number(value.beforeUid) < 1 ||
      Number(value.beforeUid) > Number(value.upperUid) ||
      typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.signature) ||
      Object.keys(value).sort().join(",") !==
        "accountBinding,beforeUid,mailbox,provider,queryHash,signature,uidValidity,upperUid,version"
    ) {
      throw new Error("shape");
    }
    const { signature, ...unsigned } = value as ImapPageToken;
    const expected = signImapPageToken(unsigned, key);
    const providedBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (
      providedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(providedBytes, expectedBytes)
    ) {
      throw new Error("signature");
    }
    return value as ImapPageToken;
  } catch {
    throw new HostingerCompletenessError("Invalid Hostinger page token");
  }
}

function assertFetchedUidsExactly(
  selected: number[],
  messages: Array<{ uid: number }>
): void {
  const selectedSet = new Set(selected);
  const fetchedUids = messages.map((message) => message.uid);
  const fetchedSet = new Set(fetchedUids);
  if (
    selectedSet.size !== selected.length ||
    fetchedSet.size !== fetchedUids.length ||
    fetchedUids.length !== selected.length ||
    fetchedUids.some((uid) => !selectedSet.has(uid))
  ) {
    throw new HostingerCompletenessError(
      "Hostinger fetched UIDs did not exactly match selected UIDs"
    );
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
  private readonly pageTokenAccountBinding: string;

  constructor(
    private readonly config: HostingerImapConfig,
    dependencies: ImapReadServiceDependencies = {}
  ) {
    this.pageTokenAccountBinding = createHash("sha256")
      .update(`hostinger-imap\0${config.account}`)
      .digest("hex");
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
    maxResults = 20,
    pageToken?: string
  ): Promise<EmailPage> {
    const decodedPageToken = pageToken
      ? decodeImapPageToken(
        pageToken,
        this.config.password,
        this.pageTokenAccountBinding,
      )
      : null;
    const queryHash = imapQueryHash(query);
    if (decodedPageToken && decodedPageToken.queryHash !== queryHash) {
      throw new HostingerCompletenessError(
        "Hostinger page token does not match the requested query"
      );
    }
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
      if (decodedPageToken && decodedPageToken.uidValidity !== uidValidity) {
        throw new HostingerCompletenessError(
          "Hostinger page token is stale; list the mailbox again"
        );
      }
      if (pageToken) {
        try {
          claimPageTokenReplay(pageToken, "Hostinger");
        } catch (error) {
          const replay = error instanceof Error && /replay rejected/i.test(error.message);
          throw new HostingerCompletenessError(
            replay
              ? "Hostinger page token replay rejected"
              : "Hostinger page token replay state unavailable"
          );
        }
      }
      const matches = await client.search(toImapSearch(query), { uid: true });
      if (!matches || matches.length === 0) {
        if (decodedPageToken) {
          throw new HostingerCompletenessError(
            "Hostinger page token is outside the current result bounds"
          );
        }
        return { emails: [], nextPageToken: null, paginationComplete: true };
      }
      if (
        matches.some((uid) => !Number.isSafeInteger(uid) || uid < 1) ||
        new Set(matches).size !== matches.length
      ) {
        throw new HostingerCompletenessError(
          "Hostinger search returned invalid or duplicate UIDs"
        );
      }

      const limit = Math.max(1, Math.min(Math.floor(maxResults), 500));
      const afterEpoch = /(?:^|\s)after:(\d+)(?:\s|$)/i.exec(query ?? "");
      const beforeEpoch = /(?:^|\s)before:(\d+)(?:\s|$)/i.exec(query ?? "");
      const exactWindow = Boolean(afterEpoch || beforeEpoch);
      if (exactWindow && matches.length > 10_000) {
        throw new HostingerCompletenessError("Hostinger exact-window candidate cap exceeded");
      }

      const upperUid = decodedPageToken?.upperUid ?? Math.max(...matches);
      const eligible = matches.filter((uid) =>
        uid <= upperUid && (!decodedPageToken || uid < decodedPageToken.beforeUid)
      );
      if (decodedPageToken && eligible.length === 0) {
        throw new HostingerCompletenessError(
          "Hostinger page token is outside the current result bounds"
        );
      }
      const selected = exactWindow
        ? eligible
        : [...eligible].sort((left, right) => right - left).slice(0, limit);
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
      assertFetchedUidsExactly(selected, messages);

      const boundedMessages = messages.filter((message) => {
        if (!exactWindow) return true;
        const rawDate = message.envelope?.date ?? message.internalDate;
        if (!rawDate) {
          throw new HostingerCompletenessError("Hostinger exact-window candidate has no date");
        }
        const timestamp = new Date(rawDate).getTime();
        if (Number.isNaN(timestamp)) {
          throw new HostingerCompletenessError(
            "Hostinger exact-window candidate has an invalid date"
          );
        }
        if (afterEpoch && timestamp <= Number(afterEpoch[1]) * 1000) return false;
        if (beforeEpoch && timestamp >= Number(beforeEpoch[1]) * 1000) return false;
        return true;
      });

      const orderedMessages = boundedMessages.sort((left, right) => right.uid - left.uid);
      const pageMessages = orderedMessages.slice(0, limit);
      const hasMore = exactWindow
        ? orderedMessages.length > limit
        : eligible.length > limit;
      const emails = pageMessages.map((message) => {
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
      return {
        emails,
        nextPageToken: hasMore
          ? encodeImapPageToken({
            version: 2,
            provider: "hostinger-imap",
            accountBinding: this.pageTokenAccountBinding,
            mailbox: "INBOX",
            uidValidity,
            queryHash,
            upperUid,
            beforeUid: pageMessages.at(-1)!.uid,
          }, this.config.password)
          : null,
        paginationComplete: !hasMore,
      };
    } catch (error) {
      if (error instanceof HostingerCompletenessError) throw error;
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
        throw new HostingerCompletenessError("Hostinger message was not found");
      }
      if (!Number.isSafeInteger(message.uid) || Number(message.uid) !== decoded.uid) {
        throw new HostingerCompletenessError(
          "Hostinger provider message identity did not match the requested UID"
        );
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
      const attachments = (parsed.attachments ?? []).map((attachment, index) => {
        const content = typeof attachment.content === "string"
          ? Buffer.from(attachment.content)
          : attachment.content instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(attachment.content))
            : Buffer.from(attachment.content ?? new Uint8Array());
        if (content.byteLength < 1) {
          throw new HostingerCompletenessError(
            "Hostinger attachment evidence has no authoritative bytes"
          );
        }
        const contentHash = createHash("sha256").update(content).digest("hex");
        const attachmentId = createHmac("sha256", this.config.password)
          .update([
            "hostinger-imap",
            this.config.account,
            decoded.uidValidity,
            String(decoded.uid),
            String(index),
            contentHash,
          ].join("\0"))
          .digest("base64url");
        return {
          filename: attachment.filename ?? "unnamed-attachment",
          mime_type: attachment.mimeType ?? "application/octet-stream",
          size: content.byteLength,
          attachment_id: `hostinger:${attachmentId}`,
        };
      });

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
        unsubscribeLinks: [],
        attachments,
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

  async getThread(
    threadId: string,
    _maxResults: number = 20,
    pageToken?: string
  ): Promise<ThreadPage> {
    if (pageToken) throw new Error("Hostinger thread pagination tokens are not supported");
    return {
      account: this.config.account,
      provider: "hostinger-imap",
      threadId,
      messages: [await this.getEmail(threadId)],
      nextPageToken: null,
      threadComplete: true,
      attachmentComplete: true,
    };
  }

  async batchProcess(
    query: string,
    maxResults = 20,
    pageToken?: string
  ): Promise<EmailPage> {
    return this.listEmails(query, maxResults, pageToken);
  }
}
