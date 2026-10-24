import { legacyMimeParameters } from './mime-parameters.js';
import { readAdminThreadShadow, stripAttachments } from "./admin-shadow.js";
import { reconcileOriginalBom } from './gmail-bom-evidence.js';
import { inspectSendRaw } from './delegated-send.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { google, gmail_v1 } from "googleapis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  labelIds: string[];
}

export interface EmailPage {
  emails: EmailSummary[];
  nextPageToken: string | null;
  paginationComplete: boolean;
}

export interface ThreadPage {
  account: string | null;
  provider: "gmail" | "hostinger-imap";
  threadId: string;
  messages: EmailDetail[];
  nextPageToken: string | null;
  threadComplete: boolean;
  attachmentComplete: boolean;
}

interface ThreadPageToken {
  version: 2;
  provider: "gmail";
  account_binding: string;
  thread_id: string;
  offset: number;
  bounds_hash: string;
  traversal: string;
  signature: string;
}

interface ListPageToken {
  version: 2;
  provider: "gmail";
  account_binding: string;
  query: string;
  max_results: number;
  provider_page_token: string;
  nonce: string;
  signature: string;
}

function replayStoreRoot(): string {
  const configured = process.env.GMAIL_THREAD_TOKEN_REPLAY_DIR?.trim();
  return resolve(configured || join(homedir(), ".local", "state", "gmail-mcp-server", "thread-token-replay"));
}

function ensurePrivateReplayStore(root: string): void {
  if (!isAbsolute(root)) throw new Error("Gmail thread replay store must be absolute");
  const rootPrefix = parse(root).root;
  let current = rootPrefix;
  for (const part of root.slice(rootPrefix.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Gmail thread replay store path is unsafe");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  chmodSync(root, 0o700);
}

export function claimPageTokenReplay(token: string, context: string): void {
  const root = replayStoreRoot();
  ensurePrivateReplayStore(root);
  const marker = join(root, createHash("sha256").update(token).digest("hex"));
  try {
    writeFileSync(marker, "consumed\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Gmail ${context} page token replay rejected`);
    }
    throw new Error(`Gmail ${context} page token replay state unavailable`);
  }
}

function threadBoundsHash(messageIds: string[]): string {
  return createHash("sha256").update(JSON.stringify(messageIds)).digest("hex");
}

type UnsignedThreadPageToken = Omit<ThreadPageToken, "signature">;

function signThreadPageToken(value: UnsignedThreadPageToken, key: string): string {
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("base64url");
}

function encodeThreadPageToken(value: UnsignedThreadPageToken, key: string): string {
  const signed: ThreadPageToken = {
    ...value,
    signature: signThreadPageToken(value, key),
  };
  return Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
}

function decodeThreadPageToken(
  token: string,
  key: string,
  accountBinding: string
): ThreadPageToken {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== token) {
      throw new Error("non-canonical");
    }
    const value = JSON.parse(decoded) as Partial<ThreadPageToken>;
    if (
      value.version !== 2 ||
      value.provider !== "gmail" ||
      value.account_binding !== accountBinding ||
      typeof value.thread_id !== "string" || !value.thread_id ||
      !Number.isSafeInteger(value.offset) || Number(value.offset) < 1 ||
      typeof value.bounds_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.bounds_hash) ||
      typeof value.traversal !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value.traversal) ||
      typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.signature) ||
      Object.keys(value).sort().join(",") !==
        "account_binding,bounds_hash,offset,provider,signature,thread_id,traversal,version"
    ) {
      throw new Error("shape");
    }
    const { signature, ...unsigned } = value as ThreadPageToken;
    const expected = signThreadPageToken(unsigned, key);
    const providedBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (
      providedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(providedBytes, expectedBytes)
    ) {
      throw new Error("signature");
    }
    return value as ThreadPageToken;
  } catch {
    throw new Error("Invalid Gmail thread page token");
  }
}

type UnsignedListPageToken = Omit<ListPageToken, "signature">;

function signListPageToken(value: UnsignedListPageToken, key: string): string {
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("base64url");
}

function encodeListPageToken(value: Omit<ListPageToken, "signature" | "nonce">, key: string): string {
  const unsigned: UnsignedListPageToken = {
    ...value,
    nonce: randomBytes(16).toString("hex"),
  };
  return Buffer.from(JSON.stringify({
    ...unsigned,
    signature: signListPageToken(unsigned, key),
  }), "utf8").toString("base64url");
}

function decodeListPageToken(token: string, key: string, accountBinding: string): ListPageToken {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== token) throw new Error("non-canonical");
    const value = JSON.parse(decoded) as Partial<ListPageToken>;
    if (
      value.version !== 2 || value.provider !== "gmail" || value.account_binding !== accountBinding ||
      typeof value.query !== "string" ||
      !Number.isSafeInteger(value.max_results) || Number(value.max_results) < 1 || Number(value.max_results) > 500 ||
      typeof value.provider_page_token !== "string" || !value.provider_page_token ||
      typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce) ||
      typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.signature) ||
      Object.keys(value).sort().join(",") !==
        "account_binding,max_results,nonce,provider,provider_page_token,query,signature,version"
    ) throw new Error("shape");
    const { signature, ...unsigned } = value as ListPageToken;
    const expected = Buffer.from(signListPageToken(unsigned, key), "base64url");
    const provided = Buffer.from(signature, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error("signature");
    return value as ListPageToken;
  } catch {
    throw new Error("Invalid Gmail list page token");
  }
}

export interface EmailDetail {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  body: string;
  labelIds: string[];
  headers: Record<string, string>;
  unsubscribeLinks: string[];
  attachments: Array<{
    filename: string;
    mime_type: string;
    size: number;
    attachment_id: string | null;
  }>;
}

export interface UnsubscribeResult {
  success: boolean;
  method: "header-mailto" | "header-http" | "body-link" | "none";
  detail: string;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeHeader(value: string): string {
  const sanitized = sanitizeHeader(value);
  return /[^\x20-\x7e]/.test(sanitized)
    ? `=?UTF-8?B?${Buffer.from(sanitized, "utf8").toString("base64")}?=`
    : sanitized;
}

function extractAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return sanitizeHeader(match?.[1] ?? value);
}

function buildPlainTextMessage(options: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    "MIME-Version: 1.0",
    `To: ${sanitizeHeader(options.to)}`,
    `Subject: ${encodeHeader(options.subject)}`,
  ];

  if (options.inReplyTo) {
    headers.push(`In-Reply-To: ${sanitizeHeader(options.inReplyTo)}`);
  }
  if (options.references) {
    headers.push(`References: ${sanitizeHeader(options.references)}`);
  }

  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 8bit");

  return [...headers, "", options.body].join("\r\n");
}

function buildMultipartMessage(options: {
  to: string;
  subject: string;
  body: string;
  attachment: { filename: string; mimeType: string; data: Buffer };
}): string {
  const boundary = `office_${randomBytes(18).toString("hex")}`;
  const encoded = options.attachment.data.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return [
    "MIME-Version: 1.0",
    `To: ${sanitizeHeader(options.to)}`,
    `Subject: ${encodeHeader(options.subject)}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    options.body,
    `--${boundary}`,
    `Content-Type: ${sanitizeHeader(options.attachment.mimeType)}; name="${sanitizeHeader(options.attachment.filename)}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${sanitizeHeader(options.attachment.filename)}"`,
    "",
    encoded,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

// ---------------------------------------------------------------------------
// Gmail Service — one instance per access token (per session)
// ---------------------------------------------------------------------------

export class GmailService {
  private gmail: gmail_v1.Gmail;
  private readonly shadowIdentity: () => Promise<{data: any}>;
  private readonly threadTokenKey: string;
  private readonly accountBinding: string;

  constructor(
    accessToken: string,
    private readonly expectedAccount?: string,
    private readonly signingKey?: string,
  ) {
    // Bind and sign page tokens with STABLE material, not the rotating ~1h
    // OAuth access token. Deriving both account_binding and the HMAC key from
    // the access token invalidated every list/thread page token whenever Google
    // rotated the token between requests, which broke pagination (the consumer
    // saw "empty, not complete, no cursor" and failed closed).
    this.threadTokenKey = signingKey ?? accessToken;
    this.accountBinding = createHash("sha256")
      .update(expectedAccount ?? accessToken)
      .digest("hex");
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.gmail = google.gmail({ version: "v1", auth });
    this.shadowIdentity = () => google.oauth2({version:"v2", auth}).userinfo.get({}, {timeout:10000});
  }

  // -----------------------------------------------------------------------
  // list_emails
  // -----------------------------------------------------------------------

  async getAdminThreadShadow(account: string, threadId: string) {
    if (this.expectedAccount !== "admin@jurgisdid.com" || account !== this.expectedAccount) {
      throw new Error("Exact admin service identity required for shadow read");
    }
    return readAdminThreadShadow({
      identity: this.shadowIdentity,
      profile: () => this.gmail.users.getProfile({userId:"me"}, {timeout:10000}),
      thread: (id) => this.gmail.users.threads.get(
        {userId:"me",id,format:"full"},
        {timeout:15000,maxContentLength:8*1024*1024})
    }, account, threadId);
  }

  async listEmails(
    query?: string,
    maxResults: number = 20,
    pageToken?: string
  ): Promise<EmailPage> {
    const requested = Math.max(1, Math.min(Math.floor(maxResults), 500));
    const normalizedQuery = query || "";
    const decodedToken = pageToken
      ? decodeListPageToken(pageToken, this.threadTokenKey, this.accountBinding)
      : null;
    if (decodedToken && (decodedToken.query !== normalizedQuery || decodedToken.max_results !== requested)) {
      throw new Error("Gmail list page token does not match the requested query and bounds");
    }
    // Signed read cursors are retriable; only the durable consumer commits progress.
    const res = await this.gmail.users.messages.list({
      userId: "me",
      q: query || undefined,
      maxResults: requested,
      pageToken: decodedToken?.provider_page_token,
    });
    const messageIds = res.data.messages ?? [];
    if (messageIds.some((message) => typeof message.id !== "string" || !message.id)) {
      throw new Error("Malformed Gmail message list response: every message requires an id");
    }
    const providerNextPageToken = res.data.nextPageToken ?? null;
    if (providerNextPageToken !== null && (typeof providerNextPageToken !== "string" || !providerNextPageToken)) {
      throw new Error("Malformed Gmail message list response: invalid continuation token");
    }
    const nextPageToken = providerNextPageToken === null ? null : encodeListPageToken({
      version: 2,
      provider: "gmail",
      account_binding: this.accountBinding,
      query: normalizedQuery,
      max_results: requested,
      provider_page_token: providerNextPageToken,
    }, this.threadTokenKey);

    const summaries = await Promise.all(
      messageIds.map((message) => this.getEmailSummary(message.id!))
    );

    return {
      emails: summaries,
      nextPageToken,
      paginationComplete: nextPageToken === null,
    };
  }

  private async getEmailSummary(messageId: string): Promise<EmailSummary> {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"],
    });
    if (!res.data.id || !res.data.threadId || !res.data.payload) {
      throw new Error("Malformed Gmail message summary response: id, threadId, and payload are required");
    }
    if (res.data.id !== messageId) {
      throw new Error("Gmail message summary identity did not match the requested message");
    }

    const headers = res.data.payload.headers ?? [];
    const hdr = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";

    return {
      id: res.data.id!,
      threadId: res.data.threadId!,
      subject: hdr("Subject"),
      from: hdr("From"),
      date: hdr("Date"),
      snippet: res.data.snippet ?? "",
      labelIds: res.data.labelIds ?? [],
    };
  }

  // -----------------------------------------------------------------------
  // get_email
  // -----------------------------------------------------------------------

  async getEmail(messageId: string): Promise<EmailDetail> {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    if (!res.data.id || !res.data.threadId || !res.data.payload) {
      throw new Error("Malformed Gmail message response: id, threadId, and payload are required");
    }
    if (res.data.id !== messageId) {
      throw new Error("Gmail message identity did not match the requested message");
    }

    let safePayload: gmail_v1.Schema$MessagePart;
    try {
      safePayload = stripAttachments(res.data.payload, true);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Admin shadow: incomplete/noncanonical body') throw error;
      // Never tolerate arbitrary size discrepancies. Prove the single observed
      // provider transformation against the same original message/history.
      if (!this.expectedAccount || !res.data.historyId) throw error;
      const profile = await this.gmail.users.getProfile({ userId: 'me' });
      if (profile.data.emailAddress?.toLowerCase() !== this.expectedAccount.toLowerCase()) throw error;
      const original = await this.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'raw' },
        { timeout: 15000, maxContentLength: 8 * 1024 * 1024 });
      if (original.data.id !== messageId || original.data.threadId !== res.data.threadId ||
        original.data.historyId !== res.data.historyId || typeof original.data.raw !== 'string') throw error;
      safePayload = stripAttachments(reconcileOriginalBom(res.data.payload, original.data.raw), true);
    }
    const headers: gmail_v1.Schema$MessagePartHeader[] = safePayload.headers ?? [];
    for (const name of ["from", "subject", "date", "message-id"]) {
      if (headers.filter((h) => h.name?.toLowerCase() === name).length > 1) {
        throw new Error("Ambiguous Gmail source headers");
      }
    }
    const hdr = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";

    const headersMap: Record<string, string> = {};
    for (const h of headers) {
      if (h.name && h.value) headersMap[h.name] = h.value;
    }

    const body = this.extractBody(safePayload);
    const unsubscribeLinks = this.parseUnsubscribeLinks(headersMap, body);
    const attachments = this.extractAttachments(res.data.payload ?? {});
    if (attachments.some((attachment) => !attachment.attachment_id)) {
      throw new Error("Malformed Gmail attachment evidence: attachment id is required");
    }

    return {
      id: res.data.id!,
      threadId: res.data.threadId!,
      subject: hdr("Subject"),
      from: hdr("From"),
      to: hdr("To"),
      date: hdr("Date"),
      snippet: body.slice(0, 200), // never substitute provider preview for excluded body evidence
      body,
      labelIds: res.data.labelIds ?? [],
      headers: headersMap,
      unsubscribeLinks,
      attachments,
    };
  }

  // -----------------------------------------------------------------------
  // get_attachment — source-bound original bytes for one Gmail attachment
  // -----------------------------------------------------------------------

  async getAttachment(messageId: string, attachmentId: string, expectedFilename?: string) {
    const message = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    if (message.data.id !== messageId || !message.data.payload) {
      throw new Error("Gmail provider message identity did not match the requested attachment source");
    }
    const idMatches: gmail_v1.Schema$MessagePart[] = [];
    const filenameMatches: gmail_v1.Schema$MessagePart[] = [];
    const visit = (part: gmail_v1.Schema$MessagePart) => {
      if (part.body?.attachmentId === attachmentId) idMatches.push(part);
      if (expectedFilename && part.filename === expectedFilename) filenameMatches.push(part);
      for (const child of part.parts ?? []) visit(child);
    };
    visit(message.data.payload);
    // Prefer an exact ID match; fall back to the stable filename (Gmail attachment
    // IDs are not stable across reads, see office-gateway-build-deploy skill).
    const part =
      idMatches.length === 1
        ? idMatches[0]
        : filenameMatches.length === 1
          ? filenameMatches[0]
          : undefined;
    if (!part || (idMatches.length === 0 && filenameMatches.length !== 1)) {
      throw new Error("Gmail attachment ID/filename was absent or ambiguous in the source message");
    }
    const realAttachmentId = part.body?.attachmentId;
    const filename = part.filename?.trim() ?? "";
    const mimeType = part.mimeType?.trim() ?? "";
    const declaredSize = part.body?.size;
    if (!realAttachmentId || !filename || !mimeType || !Number.isSafeInteger(declaredSize) || Number(declaredSize) <= 0) {
      throw new Error("Gmail attachment metadata is incomplete");
    }
    const attachment = await this.gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: realAttachmentId,
    });
    // Gmail's attachments.get does not always round-trip body.attachmentId / body.size
    // from messages.get; validate on the decoded bytes themselves instead.
    const encoded = attachment.data.data;
    if (!encoded) throw new Error("Gmail provider returned metadata without original attachment bytes");
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length === 0) throw new Error("Gmail provider attachment bytes were empty");
    // Independent provider-size verification: the decoded byte length must equal
    // the provider-declared attachment size (messages.get part.body.size). A
    // regenerated size/hash only proves transport consistency; comparing the
    // decoded length to the provider-declared size proves the fetch was not
    // truncated at the source and fails closed on any mismatch.
    if (bytes.length !== Number(declaredSize)) {
      throw new Error(
        `Gmail attachment decoded size (${bytes.length}) does not match the provider-declared size (${declaredSize}); the fetch may be truncated.`,
      );
    }
    return {
      source_message_id: messageId,
      attachment_id: realAttachmentId,
      filename,
      mime_type: mimeType,
      byte_size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes_base64: bytes.toString("base64"),
    };
  }

  // -----------------------------------------------------------------------
  // get_thread — full evidence for every message in a material thread
  // -----------------------------------------------------------------------

  async getThread(
    threadId: string,
    maxResults: number = 20,
    pageToken?: string
  ): Promise<ThreadPage> {
    const limit = Math.max(1, Math.min(Math.floor(maxResults), 100));
    const decodedToken = pageToken === undefined
      ? null
      : decodeThreadPageToken(pageToken, this.threadTokenKey, this.accountBinding);
    if (decodedToken && decodedToken.thread_id !== threadId) {
      throw new Error("Gmail thread page token does not belong to the requested thread");
    }
    // Read retries still verify account, signature, thread identity and membership.
    let authoritativeAccount: string | null = null;
    if (this.expectedAccount) {
      const profile = await this.gmail.users.getProfile({ userId: "me" });
      authoritativeAccount = profile.data.emailAddress?.trim().toLowerCase() ?? null;
      if (!authoritativeAccount || authoritativeAccount !== this.expectedAccount.toLowerCase()) {
        throw new Error("Gmail provider account identity did not match the routed account");
      }
    }
    const thread = await this.gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "minimal",
    });
    if (thread.data.id !== threadId) {
      throw new Error("Gmail provider thread identity did not match the requested thread");
    }
    if (!Array.isArray(thread.data.messages)) {
      throw new Error("Malformed Gmail thread response: messages must be an array");
    }
    const rawMessages = thread.data.messages;
    if (rawMessages.some((message) => !message.id)) {
      throw new Error("Malformed Gmail thread response: every message requires an id");
    }
    const messageIds = rawMessages.map((message) => message.id as string);
    const boundsHash = threadBoundsHash(messageIds);
    if (decodedToken && decodedToken.bounds_hash !== boundsHash) {
      throw new Error("Gmail thread page token no longer matches the current thread bounds");
    }
    const offset = decodedToken?.offset ?? 0;
    if (decodedToken && offset >= messageIds.length) {
      throw new Error("Gmail thread page token no longer matches the current thread bounds");
    }
    const end = Math.min(offset + limit, messageIds.length);
    const messages = await Promise.all(
      messageIds.slice(offset, end).map((messageId) => this.getEmail(messageId))
    );
    if (messages.some((message) => message.threadId !== threadId)) {
      throw new Error("Gmail thread identity did not match the requested thread");
    }
    return {
      account: authoritativeAccount,
      provider: "gmail",
      threadId,
      messages,
      nextPageToken: end < messageIds.length
        ? encodeThreadPageToken({
          version: 2,
          provider: "gmail",
          account_binding: this.accountBinding,
          thread_id: threadId,
          offset: end,
          bounds_hash: boundsHash,
          traversal: decodedToken?.traversal ?? randomBytes(16).toString("base64url"),
        }, this.threadTokenKey)
        : null,
      threadComplete: end >= messageIds.length,
      attachmentComplete: true,
    };
  }

  async getDraftAttachment(draftId: string, filename: string) {
    const draft = await this.gmail.users.drafts.get({
      userId: "me",
      id: draftId,
      format: "full",
    });
    if (draft.data.id !== draftId) {
      throw new Error("Gmail provider draft identity did not match the requested draft.");
    }
    const message = draft.data.message;
    if (!message?.id || !message.payload) {
      throw new Error("Gmail draft read-back omitted the draft message.");
    }
    const matches: gmail_v1.Schema$MessagePart[] = [];
    const visit = (part: gmail_v1.Schema$MessagePart) => {
      if (part.filename === filename) matches.push(part);
      for (const child of part.parts ?? []) visit(child);
    };
    visit(message.payload);
    if (matches.length !== 1) {
      throw new Error(`Gmail draft must contain exactly one attachment named "${filename}".`);
    }
    const part = matches[0];
    const declaredSize = part.body?.size;
    if (!Number.isSafeInteger(declaredSize) || Number(declaredSize) <= 0) {
      throw new Error("Gmail draft attachment requires positive safe-integer size metadata.");
    }
    let encoded = part.body?.data ?? null;
    if (!encoded && part.body?.attachmentId) {
      const requestedAttachmentId = part.body.attachmentId;
      const attachment = await this.gmail.users.messages.attachments.get({
        userId: "me",
        messageId: message.id,
        id: requestedAttachmentId,
      });
      if (
        attachment.data.attachmentId !== requestedAttachmentId ||
        !Number.isSafeInteger(attachment.data.size) ||
        Number(attachment.data.size) !== declaredSize
      ) {
        throw new Error("Gmail provider attachment identity or size did not match the draft part.");
      }
      encoded = attachment.data.data ?? null;
    }
    if (!encoded) throw new Error("Gmail draft attachment bytes were unavailable.");
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length === 0 || bytes.length !== declaredSize) {
      throw new Error("Gmail draft attachment byte length did not match its metadata.");
    }
    return {
      source: "gmail-draft-readback" as const,
      draft_id: draftId,
      message_id: message.id,
      filename,
      mime_type: part.mimeType ?? "application/octet-stream",
      size: bytes.length,
      attachment_base64: bytes.toString("base64"),
      complete: true,
    };
  }

  // -----------------------------------------------------------------------
  // archive_email — remove INBOX label
  // -----------------------------------------------------------------------

  async archiveEmail(messageId: string): Promise<{ success: boolean }> {
    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        removeLabelIds: ["INBOX"],
      },
    });
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // apply_label — create if needed, then apply
  // -----------------------------------------------------------------------

  async applyLabel(
    messageId: string,
    labelName: string,
    expectedLabelId?: string
  ): Promise<{ success: boolean; labelId: string }> {
    const labelId = expectedLabelId === undefined ? await this.getOrCreateLabel(labelName)
      : await this.exactExistingLabelId(labelName, expectedLabelId);

    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: [labelId],
      },
    });

    return { success: true, labelId };
  }

  private async exactExistingLabelId(name: string, expectedId: string): Promise<string> {
    if (!expectedId || !name) throw new Error("Exact existing label binding required");
    const res = await this.gmail.users.labels.list({userId:"me"});
    const labels = res.data.labels;
    if (!Array.isArray(labels)) throw new Error("Provider label inventory unavailable");
    const matches = labels.filter(l=>l.name === name);
    if (matches.length !== 1 || matches[0].id !== expectedId || labels.filter(l=>l.id === expectedId).length !== 1) throw new Error("Approved label ID/name binding changed");
    return expectedId;
  }

  private async getOrCreateLabel(labelName: string): Promise<string> {
    // Check existing labels
    const res = await this.gmail.users.labels.list({ userId: "me" });
    const existing = (res.data.labels ?? []).find(
      (l) => l.name?.toLowerCase() === labelName.toLowerCase()
    );
    if (existing) return existing.id!;

    // Create new label
    const created = await this.gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    return created.data.id!;
  }

  // -----------------------------------------------------------------------
  // remove_label — remove a label from a message
  // -----------------------------------------------------------------------

  async removeLabel(messageId: string, labelName: string, expectedLabelId?: string): Promise<{ success: boolean; labelId?: string }> {
    if (expectedLabelId !== undefined) {
      const id = await this.exactExistingLabelId(labelName,expectedLabelId);
      await this.gmail.users.messages.modify({userId:"me",id:messageId,requestBody:{removeLabelIds:[id]}});
      return {success:true,labelId:id};
    }
    const res = await this.gmail.users.labels.list({ userId: "me" });
    const label = (res.data.labels ?? []).find(
      (l) => l.name?.toLowerCase() === labelName.toLowerCase()
    );
    const removeLabelIds = label?.id ? [label.id] : [labelName];
    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds },
    });
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // list_labels
  // -----------------------------------------------------------------------

  async listLabels(): Promise<{ labels: Array<{ id: string; name: string }>; paginationComplete: boolean }> {
    const res = await this.gmail.users.labels.list({ userId: "me" });
    return {
      labels: (res.data.labels ?? []).map((l) => ({ id: l.id ?? "", name: l.name ?? "" })),
      paginationComplete: true,
    };
  }

  // -----------------------------------------------------------------------
  // create_label
  // -----------------------------------------------------------------------

  async createLabel(name: string): Promise<{ success: boolean; labelId: string }> {
    const labelId = await this.getOrCreateLabel(name);
    return { success: true, labelId };
  }

  // -----------------------------------------------------------------------
  // delete_label
  // -----------------------------------------------------------------------

  async deleteLabel(labelId: string): Promise<{ success: boolean }> {
    await this.gmail.users.labels.delete({ userId: "me", id: labelId });
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // migrate_label_messages — move messages from one label to another
  // -----------------------------------------------------------------------

  async migrateLabelMessages(
    sourceLabelId: string,
    destinationLabelName: string,
    maxResults: number
  ): Promise<{ success: boolean; migrated: number; paginationComplete: boolean }> {
    const destLabelId = await this.getOrCreateLabel(destinationLabelName);
    let migrated = 0;
    let pageToken: string | undefined;
    let paginationComplete = true;
    const cap = Math.max(1, Math.min(Math.floor(maxResults), 500));
    do {
      const res = await this.gmail.users.messages.list({
        userId: "me",
        labelIds: [sourceLabelId],
        maxResults: cap,
        pageToken,
      });
      const ids = (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
      if (ids.length) {
        await this.gmail.users.messages.batchModify({
          userId: "me",
          requestBody: { ids, addLabelIds: [destLabelId] },
        });
        migrated += ids.length;
      }
      if (migrated >= maxResults) {
        paginationComplete = !res.data.nextPageToken && ids.length < cap;
        break;
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return { success: true, migrated, paginationComplete };
  }

  // -----------------------------------------------------------------------
  // list_drafts
  // -----------------------------------------------------------------------

  async listDrafts(
    query?: string,
    maxResults = 20
  ): Promise<{ drafts: Array<{ id: string; thread_id: string }>; paginationComplete: boolean }> {
    const res = await this.gmail.users.drafts.list({
      userId: "me",
      q: query || undefined,
      maxResults: Math.max(1, Math.min(Math.floor(maxResults), 500)),
    });
    return {
      drafts: (res.data.drafts ?? []).map((d) => ({ id: d.id ?? "", thread_id: d.message?.threadId ?? "" })),
      paginationComplete: !res.data.nextPageToken,
    };
  }

  async prepareDraftSend(draftId: string) {
    const result = await this.gmail.users.drafts.get({userId: 'me', id: draftId, format: 'raw'});
    return inspectSendRaw(this.expectedAccount ?? '', draftId, result.data.message?.raw ?? '', result.data.message?.threadId ?? '');
  }

  async sendDraftSnapshot(draftId: string, expectedFingerprint: string, beforeSend: () => void = () => {}) {
    const snapshot = await this.prepareDraftSend(draftId);
    if (snapshot.fingerprint !== expectedFingerprint) throw new Error('SEND_DRAFT_CHANGED');
    beforeSend();
    const result = await this.gmail.users.messages.send({userId:'me', requestBody:{raw:snapshot.raw, ...(snapshot.thread_id ? {threadId:snapshot.thread_id} : {})}}, {retry:false});
    if (!result.data.id) throw new Error('SEND_OUTCOME_UNKNOWN');
    const readback = await this.gmail.users.messages.get({userId:'me', id:result.data.id, format:'metadata'});
    if (!readback.data.labelIds?.includes('SENT')) throw new Error('SEND_READBACK_UNCONFIRMED');
    return {sent:true, message_id:result.data.id, thread_id:result.data.threadId, fingerprint:expectedFingerprint, account:this.expectedAccount, draft_retained:true};
  }

  // -----------------------------------------------------------------------
  // get_draft
  // -----------------------------------------------------------------------

  async getDraft(draftId: string): Promise<Record<string, unknown>> {
    const res = await this.gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
    return { draft: res.data };
  }

  // -----------------------------------------------------------------------
  // delete_draft
  // -----------------------------------------------------------------------

  async deleteDraft(draftId: string): Promise<{ success: boolean }> {
    await this.gmail.users.drafts.delete({ userId: "me", id: draftId });
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // update_draft — rewrite an existing draft's headers/body/thread
  // -----------------------------------------------------------------------

  async updateDraft(options: {
    draftId: string;
    to?: string;
    subject?: string;
    body?: string;
    threadId?: string;
    replyMessageId?: string;
  }): Promise<{ success: boolean; draftId: string }> {
    const current = await this.gmail.users.drafts.get({
      userId: "me",
      id: options.draftId,
      format: "full",
    });
    const existing = current.data.message ?? {};
    const headers = existing.payload?.headers ?? [];
    const getHeader = (n: string) =>
      headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
    const to = options.to ?? getHeader("To");
    const subject = options.subject ?? getHeader("Subject");
    const body = options.body ?? "";
    const threadId = options.threadId ?? existing.threadId ?? undefined;
    const raw = Buffer.from(
      buildPlainTextMessage({ to, subject, body }),
      "utf8"
    ).toString("base64url");
    const requestBody: gmail_v1.Schema$Draft = { message: { raw } };
    if (threadId) requestBody.message!.threadId = threadId;
    const res = await this.gmail.users.drafts.update({
      userId: "me",
      id: options.draftId,
      requestBody,
    });
    return { success: true, draftId: res.data.id ?? options.draftId };
  }

  // -----------------------------------------------------------------------
  // unsubscribe_email
  // -----------------------------------------------------------------------

  async unsubscribeEmail(messageId: string): Promise<UnsubscribeResult> {
    const email = await this.getEmail(messageId);
    const listUnsubscribe = email.headers["List-Unsubscribe"] ?? "";

    // 1. Try HTTP link from List-Unsubscribe header
    const httpLinks = this.extractHttpLinks(listUnsubscribe);
    for (const link of httpLinks) {
      try {
        const resp = await fetch(link, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          return {
            success: true,
            method: "header-http",
            detail: `Successfully requested unsubscribe via header link: ${link}`,
          };
        }
      } catch {
        // Try next link
      }
    }

    // 2. Try POST to List-Unsubscribe with List-Unsubscribe-Post header
    const postHeader = email.headers["List-Unsubscribe-Post"];
    if (postHeader && httpLinks.length > 0) {
      for (const link of httpLinks) {
        try {
          const resp = await fetch(link, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: postHeader,
            redirect: "follow",
            signal: AbortSignal.timeout(10000),
          });
          if (resp.ok) {
            return {
              success: true,
              method: "header-http",
              detail: `Successfully POSTed unsubscribe via RFC 8058: ${link}`,
            };
          }
        } catch {
          // Try next
        }
      }
    }

    // 3. Try mailto from List-Unsubscribe header
    const mailtoMatch = listUnsubscribe.match(/mailto:([^>,\s]+)/i);
    if (mailtoMatch) {
      const mailtoAddr = mailtoMatch[1];
      try {
        await this.sendUnsubscribeMail(mailtoAddr);
        return {
          success: true,
          method: "header-mailto",
          detail: `Sent unsubscribe email to ${mailtoAddr}`,
        };
      } catch (err) {
        // Fall through
      }
    }

    // 4. Scan body for unsubscribe links
    const bodyLinks = this.extractUnsubscribeLinksFromBody(email.body);
    for (const link of bodyLinks) {
      try {
        const resp = await fetch(link, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          return {
            success: true,
            method: "body-link",
            detail: `Visited unsubscribe link found in email body: ${link}`,
          };
        }
      } catch {
        // Try next
      }
    }

    // 5. Nothing worked — return the links we found so Claude can inform the user
    const allLinks = [...httpLinks, ...bodyLinks];
    return {
      success: false,
      method: "none",
      detail:
        allLinks.length > 0
          ? `Could not auto-unsubscribe. Found these links the user can try manually:\n${allLinks.join("\n")}`
          : "No unsubscribe mechanism found in this email.",
    };
  }

  private async sendUnsubscribeMail(toAddress: string): Promise<void> {
    // Compose a minimal unsubscribe email
    const raw = Buffer.from(
      [
        `To: ${toAddress}`,
        `Subject: Unsubscribe`,
        `Content-Type: text/plain; charset="UTF-8"`,
        "",
        "Unsubscribe",
      ].join("\r\n")
    )
      .toString("base64url");

    await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
  }

  // -----------------------------------------------------------------------
  // create_draft — save a draft in the Drafts folder
  // -----------------------------------------------------------------------

  async createDraft(options: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    replyMessageId?: string;
  }): Promise<{ draftId: string; threadId?: string }> {
    const replyTo = options.replyMessageId
      ? await this.getEmail(options.replyMessageId)
      : null;

    const to = options.to || (replyTo ? extractAddress(replyTo.from) : "");
    const subject =
      options.subject ||
      (replyTo?.subject
        ? /^re:/i.test(replyTo.subject)
          ? replyTo.subject
          : `Re: ${replyTo.subject}`
        : "");
    const threadId = options.threadId ?? replyTo?.threadId;
    const messageIdHeader = replyTo?.headers["Message-ID"];
    const referencesHeader = replyTo
      ? [replyTo.headers.References, messageIdHeader].filter(Boolean).join(" ")
      : undefined;

    const raw = Buffer.from(
      buildPlainTextMessage({
        to,
        subject,
        body: options.body,
        inReplyTo: messageIdHeader,
        references: referencesHeader,
      }),
      "utf8"
    ).toString("base64url");

    const requestBody: gmail_v1.Schema$Draft = {
      message: { raw },
    };
    if (threadId) {
      requestBody.message!.threadId = threadId;
    }

    const res = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody,
    });

    return {
      draftId: res.data.id!,
      threadId: res.data.message?.threadId ?? undefined,
    };
  }

  // -----------------------------------------------------------------------
  // send_email — send a new email or reply in a thread
  // -----------------------------------------------------------------------

  async sendEmail(options: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    replyMessageId?: string;
    attachment?: { filename: string; mimeType: string; data: Buffer };
  }): Promise<{ messageId: string; threadId?: string }> {
    const replyTo = options.replyMessageId
      ? await this.getEmail(options.replyMessageId)
      : null;

    const to = options.to || (replyTo ? extractAddress(replyTo.from) : "");
    const subject =
      options.subject ||
      (replyTo?.subject
        ? /^re:/i.test(replyTo.subject)
          ? replyTo.subject
          : `Re: ${replyTo.subject}`
        : "");
    const threadId = options.threadId ?? replyTo?.threadId;
    const messageIdHeader = replyTo?.headers["Message-ID"];
    const referencesHeader = replyTo
      ? [replyTo.headers.References, messageIdHeader].filter(Boolean).join(" ")
      : undefined;

    const message = options.attachment
      ? buildMultipartMessage({to, subject, body: options.body, attachment: options.attachment})
      : buildPlainTextMessage({to, subject, body: options.body, inReplyTo: messageIdHeader, references: referencesHeader});
    const raw = Buffer.from(message, "utf8").toString("base64url");

    const requestBody: gmail_v1.Schema$Message = { raw };
    if (threadId) {
      requestBody.threadId = threadId;
    }

    const res = await this.gmail.users.messages.send({
      userId: "me",
      requestBody,
    });

    return {
      messageId: res.data.id!,
      threadId: res.data.threadId ?? undefined,
    };
  }

  // -----------------------------------------------------------------------
  // batch_process — fetch structured data for Claude to decide on
  // -----------------------------------------------------------------------

  async batchProcess(
    query: string,
    maxResults: number = 20,
    pageToken?: string
  ): Promise<EmailPage> {
    return this.listEmails(query, maxResults, pageToken);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private extractBody(payload: gmail_v1.Schema$MessagePart): string {
    // Called only after stripAttachments validates/fences the entire MIME tree.
    const decode = (part: gmail_v1.Schema$MessagePart): string => {
      const bytes = Buffer.from(part.body?.data ?? "", "base64url");
      const contentType = (part.headers ?? []).find(h => h.name?.toLowerCase() === "content-type")?.value ?? "";
      const charset = (legacyMimeParameters(contentType || part.mimeType || 'text/plain').get('charset') ?? 'utf-8').toLowerCase().replace(/_/g, '-');
      if (charset === "utf-8" || charset === "utf8") return new TextDecoder("utf-8", {fatal:true, ignoreBOM:true}).decode(bytes);
      if (charset === "ascii" || charset === "us-ascii") {
        if (bytes.some(b => b > 127)) throw new Error("Non-ASCII Gmail body bytes");
        return bytes.toString("ascii");
      }
      if (charset === "iso-8859-1") return bytes.toString("latin1");
      if (charset === "windows-1252") {
        if (bytes.some(b => [0x81,0x8d,0x8f,0x90,0x9d].includes(b))) throw new Error("Undefined Gmail body character");
        return new TextDecoder("windows-1252", {fatal:true}).decode(bytes);
      }
      throw new Error("Unsupported Gmail body encoding");
    };
    // Prefer text/plain, fall back to text/html
    if (payload.mimeType === "text/plain" && payload.body?.data) {
      return decode(payload);
    }

    if (payload.mimeType === "text/html" && payload.body?.data) {
      return decode(payload);
    }

    // Multipart: recurse
    if (payload.parts) {
      // Try text/plain first
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return decode(part);
        }
      }
      // Fall back to text/html
      for (const part of payload.parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
          return decode(part);
        }
      }
      // Recurse into nested multipart
      for (const part of payload.parts) {
        const result = this.extractBody(part);
        if (result) return result;
      }
    }

    return "";
  }

  private extractAttachments(payload: gmail_v1.Schema$MessagePart) {
    const attachments: EmailDetail["attachments"] = [];
    const visit = (part: gmail_v1.Schema$MessagePart) => {
      if (part.filename) {
        const attachmentId = part.body?.attachmentId;
        const size = part.body?.size;
        if (
          typeof attachmentId !== "string" || !attachmentId ||
          !Number.isSafeInteger(size) || Number(size) <= 0
        ) {
          throw new Error(
            "Malformed Gmail attachment evidence: attachment id and positive safe-integer size are required"
          );
        }
        attachments.push({
          filename: part.filename,
          mime_type: part.mimeType ?? "application/octet-stream",
          size: size as number,
          attachment_id: attachmentId,
        });
      }
      for (const child of part.parts ?? []) visit(child);
    };
    visit(payload);
    return attachments;
  }

  private parseUnsubscribeLinks(
    headers: Record<string, string>,
    body: string
  ): string[] {
    const links: string[] = [];

    // From List-Unsubscribe header
    const listUnsub = headers["List-Unsubscribe"] ?? "";
    links.push(...this.extractHttpLinks(listUnsub));

    const mailtoMatch = listUnsub.match(/mailto:([^>,\s]+)/i);
    if (mailtoMatch) links.push(`mailto:${mailtoMatch[1]}`);

    // From body
    links.push(...this.extractUnsubscribeLinksFromBody(body));

    return [...new Set(links)];
  }

  private extractHttpLinks(text: string): string[] {
    const matches = text.match(/https?:\/\/[^>,\s<]+/gi);
    return matches ?? [];
  }

  private extractUnsubscribeLinksFromBody(body: string): string[] {
    const links: string[] = [];
    // Match href links near "unsubscribe" text
    const hrefPattern =
      /href\s*=\s*["']?(https?:\/\/[^"'\s>]+(?:unsubscribe|opt.?out|remove|manage.?preferences)[^"'\s>]*)["']?/gi;
    let match;
    while ((match = hrefPattern.exec(body)) !== null) {
      links.push(match[1]);
    }
    // Also match plain URLs with unsubscribe keywords
    const urlPattern =
      /(https?:\/\/\S+(?:unsubscribe|opt.?out|remove|manage.?preferences)\S*)/gi;
    while ((match = urlPattern.exec(body)) !== null) {
      if (!links.includes(match[1])) {
        links.push(match[1]);
      }
    }
    return [...new Set(links)];
  }
}
