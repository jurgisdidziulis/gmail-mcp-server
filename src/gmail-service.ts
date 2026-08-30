import { google, gmail_v1 } from "googleapis";
import { PDFParse } from "pdf-parse";

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

export interface EmailListPage {
  emails: EmailSummary[];
  nextPageToken: string | null;
  resultSizeEstimate: number | null;
  paginationComplete: boolean;
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
  attachments: AttachmentSummary[];
  unsubscribeLinks: string[];
}

export interface AttachmentSummary {
  filename: string;
  mimeType: string;
  attachmentId?: string;
  size?: number;
  partId?: string;
}

export interface ThreadEvidence {
  capability: "mail.evidence.read";
  contract_version: "1.0.0";
  success: boolean;
  status: "complete" | "incomplete_stop";
  account?: string;
  anchor_message_id: string;
  thread_id: string | null;
  message_count: number;
  messages: EmailDetail[];
  attachment_count: number;
  attachments: EvidenceAttachment[];
  pdf_count: number;
  pdfs: EvidencePdf[];
  completeness: {
    anchor_message_complete: boolean;
    thread_complete: boolean;
    attachments_enumerated: boolean;
    pdf_extraction_complete: boolean;
    reply_context_complete: boolean;
  };
  failures: string[];
}

export interface EvidenceAttachment {
  source_message_id: string;
  field: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
  is_pdf: boolean;
  attachment_id?: string;
}

export interface EvidencePdf extends EvidenceAttachment {
  status: "complete" | "needs_ocr" | "password_required" | "failed";
  text: string;
  text_character_count: number;
  page_count: number | null;
  error: string | null;
}

interface PreservedAttachment extends AttachmentSummary {
  data: string;
}

export interface UnsubscribeResult {
  success: boolean;
  method: "header-mailto" | "header-http" | "body-link" | "none";
  detail: string;
}

export interface DraftResult {
  draftId: string;
  messageId?: string;
  threadId?: string;
  replyMessageId?: string;
  threaded: boolean;
  attachmentPreservation?: {
    preserved: boolean;
    count: number;
    filenames: string[];
  };
  threadVerification?: {
    method: "gmail.threads.get";
    expectedThreadId: string;
    draftMessageId?: string;
    memberMessageIds: string[];
    draftInThread: boolean;
  };
}

export interface DraftDetail extends EmailDetail {
  draftId: string;
  threadVerification?: DraftResult["threadVerification"];
}

export interface GmailLabelSummary {
  id: string;
  name: string;
  type: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
}

export interface LabelMessageSummary {
  id: string;
  threadId: string;
  labelIds: string[];
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

function quoteMimeValue(value: string): string {
  return sanitizeHeader(value).replace(/["\\]/g, "\\$&");
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function buildPlainTextMessageWithAttachments(options: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments: PreservedAttachment[];
}): string {
  const boundary = `office-draft-update-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
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

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts = [
    ...headers,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    options.body,
  ];

  for (const attachment of options.attachments) {
    const filename = quoteMimeValue(attachment.filename || "attachment");
    const mimeType = sanitizeHeader(attachment.mimeType || "application/octet-stream");
    parts.push(
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      wrapBase64(attachment.data)
    );
  }

  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

// ---------------------------------------------------------------------------
// Gmail Service — one instance per access token (per session)
// ---------------------------------------------------------------------------

export class GmailService {
  private gmail: gmail_v1.Gmail;

  constructor(accessToken: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.gmail = google.gmail({ version: "v1", auth });
  }

  // -----------------------------------------------------------------------
  // list_emails
  // -----------------------------------------------------------------------

  async listEmails(
    query?: string,
    maxResults: number = 20,
    pageToken?: string
  ): Promise<EmailListPage> {
    const res = await this.gmail.users.messages.list({
      userId: "me",
      q: query || undefined,
      maxResults: Math.min(maxResults, 100),
      pageToken: pageToken || undefined,
    });

    const messageIds = res.data.messages ?? [];
    if (messageIds.length === 0) {
      return {
        emails: [],
        nextPageToken: res.data.nextPageToken ?? null,
        resultSizeEstimate: typeof res.data.resultSizeEstimate === "number" ? res.data.resultSizeEstimate : null,
        paginationComplete: !res.data.nextPageToken,
      };
    }

    // Fetch headers for each message in parallel (batched)
    const summaries = await Promise.all(
      messageIds.map((m) => this.getEmailSummary(m.id!))
    );

    return {
      emails: summaries,
      nextPageToken: res.data.nextPageToken ?? null,
      resultSizeEstimate: typeof res.data.resultSizeEstimate === "number" ? res.data.resultSizeEstimate : null,
      paginationComplete: !res.data.nextPageToken,
    };
  }

  private async getEmailSummary(messageId: string): Promise<EmailSummary> {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"],
    });

    const headers = res.data.payload?.headers ?? [];
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

    return this.emailDetailFromMessage(res.data);
  }

  async getThreadEvidence(
    anchorMessageId: string,
    maxPdfPages: number = 50
  ): Promise<ThreadEvidence> {
    const anchor = await this.gmail.users.messages.get({
      userId: "me",
      id: anchorMessageId,
      format: "metadata",
    });
    const threadId = anchor.data.threadId;
    if (!threadId) {
      throw new Error(`Gmail message ${anchorMessageId} omitted threadId`);
    }

    const thread = await this.gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });
    const rawMessages = thread.data.messages ?? [];
    const messages = rawMessages.map((message) => this.emailDetailFromMessage(message));
    const attachments = rawMessages.flatMap((message) =>
      this.evidenceAttachmentsFromMessage(message)
    );
    const pdfs: EvidencePdf[] = [];

    for (const attachment of attachments.filter((item) => item.is_pdf)) {
      pdfs.push(await this.extractEvidencePdf(attachment, maxPdfPages));
    }

    const threadIds = new Set(messages.map((message) => message.threadId));
    const completeness = {
      anchor_message_complete: messages.some((message) => message.id === anchorMessageId),
      thread_complete:
        messages.length === rawMessages.length &&
        messages.length > 0 &&
        threadIds.size === 1 &&
        threadIds.has(threadId),
      attachments_enumerated: true,
      pdf_extraction_complete: pdfs.every((pdf) => pdf.status === "complete"),
      reply_context_complete: messages.some(
        (message) => message.id === anchorMessageId && message.threadId === threadId
      ),
    };
    const failures = Object.entries(completeness)
      .filter(([, complete]) => !complete)
      .map(([name]) => name);
    const success = failures.length === 0;

    return {
      capability: "mail.evidence.read",
      contract_version: "1.0.0",
      success,
      status: success ? "complete" : "incomplete_stop",
      anchor_message_id: anchorMessageId,
      thread_id: threadIds.size === 1 ? threadId : null,
      message_count: messages.length,
      messages,
      attachment_count: attachments.length,
      attachments,
      pdf_count: pdfs.length,
      pdfs,
      completeness,
      failures,
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
    labelName: string
  ): Promise<{ success: boolean; labelId: string }> {
    const labelId = await this.getOrCreateLabel(labelName);

    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: [labelId],
      },
    });

    return { success: true, labelId };
  }

  async removeLabel(
    messageId: string,
    labelName: string
  ): Promise<{ success: boolean; labelId: string }> {
    const labelId = await this.getOrCreateLabel(labelName);

    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        removeLabelIds: [labelId],
      },
    });

    return { success: true, labelId };
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
  // label administration
  // -----------------------------------------------------------------------

  async createLabel(labelName: string): Promise<{ success: boolean; label: GmailLabelSummary }> {
    const labelId = await this.getOrCreateLabel(labelName);
    const full = await this.gmail.users.labels.get({ userId: "me", id: labelId });
    return { success: true, label: this.toLabelSummary(full.data) };
  }

  async listLabels(): Promise<GmailLabelSummary[]> {
    const res = await this.gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels ?? [];
    const detailed = await Promise.all(
      labels.map(async (label) => {
        const id = label.id!;
        try {
          const full = await this.gmail.users.labels.get({ userId: "me", id });
          return this.toLabelSummary(full.data);
        } catch {
          return this.toLabelSummary(label);
        }
      })
    );
    return detailed.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listLabelMessages(
    labelId: string,
    maxResults: number = 500
  ): Promise<{
    labelId: string;
    messages: LabelMessageSummary[];
    paginationComplete: boolean;
  }> {
    const messages: LabelMessageSummary[] = [];
    let pageToken: string | undefined;
    const limit = Math.min(Math.max(maxResults, 1), 500);

    while (messages.length < limit) {
      const res = await this.gmail.users.messages.list({
        userId: "me",
        labelIds: [labelId],
        maxResults: Math.min(100, limit - messages.length),
        pageToken,
      });
      const ids = res.data.messages ?? [];
      const page = await Promise.all(
        ids.map(async (message) => {
          const full = await this.gmail.users.messages.get({
            userId: "me",
            id: message.id!,
            format: "metadata",
          });
          return {
            id: full.data.id!,
            threadId: full.data.threadId!,
            labelIds: full.data.labelIds ?? [],
          };
        })
      );
      messages.push(...page);
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken || ids.length === 0) break;
    }

    return {
      labelId,
      messages,
      paginationComplete: !pageToken,
    };
  }

  async migrateLabelMessages(
    labelId: string,
    destinationLabelName: string,
    maxResults: number = 500
  ): Promise<{
    success: boolean;
    sourceLabelId: string;
    destinationLabelId: string;
    migratedMessageIds: string[];
    paginationComplete: boolean;
  }> {
    const destinationLabelId = await this.getOrCreateLabel(destinationLabelName);
    const listed = await this.listLabelMessages(labelId, maxResults);
    const messageIds = listed.messages.map((message) => message.id);

    for (let index = 0; index < messageIds.length; index += 100) {
      const batch = messageIds.slice(index, index + 100);
      if (batch.length === 0) continue;
      await this.gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids: batch,
          addLabelIds: [destinationLabelId],
          removeLabelIds: [labelId],
        },
      });
    }

    return {
      success: true,
      sourceLabelId: labelId,
      destinationLabelId,
      migratedMessageIds: messageIds,
      paginationComplete: listed.paginationComplete,
    };
  }

  async updateLabel(options: {
    labelId: string;
    name?: string;
    labelListVisibility?: string;
    messageListVisibility?: string;
  }): Promise<{ success: boolean; label: GmailLabelSummary }> {
    const requestBody: gmail_v1.Schema$Label = {};
    if (options.name) requestBody.name = options.name;
    if (options.labelListVisibility) {
      requestBody.labelListVisibility = options.labelListVisibility;
    }
    if (options.messageListVisibility) {
      requestBody.messageListVisibility = options.messageListVisibility;
    }
    const res = await this.gmail.users.labels.patch({
      userId: "me",
      id: options.labelId,
      requestBody,
    });
    return { success: true, label: this.toLabelSummary(res.data) };
  }

  async deleteLabel(labelId: string): Promise<{ success: boolean; labelId: string }> {
    await this.gmail.users.labels.delete({ userId: "me", id: labelId });
    return { success: true, labelId };
  }

  private toLabelSummary(label: gmail_v1.Schema$Label): GmailLabelSummary {
    return {
      id: label.id ?? "",
      name: label.name ?? "",
      type: label.type ?? "",
      messageListVisibility: label.messageListVisibility ?? undefined,
      labelListVisibility: label.labelListVisibility ?? undefined,
      messagesTotal: label.messagesTotal ?? undefined,
      messagesUnread: label.messagesUnread ?? undefined,
      threadsTotal: label.threadsTotal ?? undefined,
      threadsUnread: label.threadsUnread ?? undefined,
    };
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
  }): Promise<DraftResult> {
    if (options.threadId && !options.replyMessageId) {
      throw new Error("reply_message_id is required when thread_id is supplied.");
    }

    const replyTo = options.replyMessageId
      ? await this.getEmail(options.replyMessageId)
      : null;

    if (options.threadId && replyTo?.threadId && options.threadId !== replyTo.threadId) {
      throw new Error(
        "thread_id does not match the provider thread for reply_message_id."
      );
    }

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

    const draftId = res.data.id!;
    const draftMessageId =
      res.data.message?.id ??
      (draftId
        ? (
            await this.gmail.users.drafts.get({
              userId: "me",
              id: draftId,
              format: "metadata",
            })
          ).data.message?.id ?? undefined
        : undefined);
    const returnedThreadId = res.data.message?.threadId ?? undefined;

    if (!threadId) {
      return {
        draftId,
        messageId: draftMessageId,
        threadId: returnedThreadId,
        threaded: false,
      };
    }

    const verification = await this.verifyDraftThreadMembership(
      threadId,
      draftMessageId
    );

    if (!verification.draftInThread) {
      throw new Error(
        "Draft was created but Gmail threads.get does not show it in the requested thread."
      );
    }

    return {
      draftId,
      messageId: draftMessageId,
      threadId: returnedThreadId,
      replyMessageId: options.replyMessageId,
      threaded: true,
      threadVerification: verification,
    };
  }

  async listDrafts(
    query?: string,
    maxResults: number = 20
  ): Promise<DraftDetail[]> {
    const res = await this.gmail.users.drafts.list({
      userId: "me",
      q: query || undefined,
      maxResults: Math.min(maxResults, 100),
    });

    const drafts = res.data.drafts ?? [];
    return Promise.all(
      drafts.map((draft) => this.getDraft(draft.id!))
    );
  }

  async getDraft(
    draftId: string,
    expectedThreadId?: string
  ): Promise<DraftDetail> {
    const res = await this.gmail.users.drafts.get({
      userId: "me",
      id: draftId,
      format: "full",
    });
    const message = res.data.message;
    if (!message?.id) {
      throw new Error(`Draft ${draftId} did not contain a Gmail message.`);
    }

    const detail = this.emailDetailFromMessage(message);
    const threadVerification = expectedThreadId
      ? await this.verifyDraftThreadMembership(expectedThreadId, message.id)
      : undefined;

    return {
      draftId,
      ...detail,
      threadVerification,
    };
  }

  async updateDraft(options: {
    draftId: string;
    to?: string;
    subject?: string;
    body: string;
    threadId?: string;
    replyMessageId?: string;
  }): Promise<DraftResult> {
    if (options.threadId && !options.replyMessageId) {
      throw new Error("reply_message_id is required when thread_id is supplied.");
    }

    const existingDraftRes = await this.gmail.users.drafts.get({
      userId: "me",
      id: options.draftId,
      format: "full",
    });
    const existingDraftMessage = existingDraftRes.data.message;
    if (!existingDraftMessage?.id) {
      throw new Error(`Draft ${options.draftId} did not contain a Gmail message.`);
    }
    const existingDraft: DraftDetail = {
      draftId: options.draftId,
      ...this.emailDetailFromMessage(existingDraftMessage),
    };
    const preservedAttachments = await this.fetchPreservedAttachments(
      existingDraftMessage
    );
    const replyTo = options.replyMessageId
      ? await this.getEmail(options.replyMessageId)
      : null;

    if (options.threadId && replyTo?.threadId && options.threadId !== replyTo.threadId) {
      throw new Error(
        "thread_id does not match the provider thread for reply_message_id."
      );
    }

    const threadId = options.threadId ?? replyTo?.threadId ?? existingDraft.threadId;
    const to = options.to || (replyTo ? extractAddress(replyTo.from) : existingDraft.to);
    const subject =
      options.subject ||
      (replyTo?.subject
        ? /^re:/i.test(replyTo.subject)
          ? replyTo.subject
          : `Re: ${replyTo.subject}`
        : existingDraft.subject);
    const messageIdHeader = replyTo?.headers["Message-ID"];
    const referencesHeader = replyTo
      ? [replyTo.headers.References, messageIdHeader].filter(Boolean).join(" ")
      : existingDraft.headers.References;

    const rawMessage =
      preservedAttachments.length > 0
        ? buildPlainTextMessageWithAttachments({
            to,
            subject,
            body: options.body,
            inReplyTo: messageIdHeader ?? existingDraft.headers["In-Reply-To"],
            references: referencesHeader,
            attachments: preservedAttachments,
          })
        : buildPlainTextMessage({
            to,
            subject,
            body: options.body,
            inReplyTo: messageIdHeader ?? existingDraft.headers["In-Reply-To"],
            references: referencesHeader,
          });

    const raw = Buffer.from(rawMessage, "utf8").toString("base64url");

    const requestBody: gmail_v1.Schema$Draft = {
      id: options.draftId,
      message: { raw },
    };
    if (threadId) {
      requestBody.message!.threadId = threadId;
    }

    const res = await this.gmail.users.drafts.update({
      userId: "me",
      id: options.draftId,
      requestBody,
    });

    const draftMessageId =
      res.data.message?.id ??
      (
        await this.gmail.users.drafts.get({
          userId: "me",
          id: options.draftId,
          format: "metadata",
        })
      ).data.message?.id ?? undefined;
    const returnedThreadId = res.data.message?.threadId ?? threadId;

    const verification = threadId
      ? await this.verifyDraftThreadMembership(threadId, draftMessageId)
      : undefined;

    if (threadId && !verification?.draftInThread) {
      throw new Error(
        "Draft was updated but Gmail threads.get does not show it in the requested thread."
      );
    }

    return {
      draftId: options.draftId,
      messageId: draftMessageId,
      threadId: returnedThreadId,
      replyMessageId: options.replyMessageId,
      threaded: Boolean(threadId),
      attachmentPreservation: {
        preserved: preservedAttachments.length > 0,
        count: preservedAttachments.length,
        filenames: preservedAttachments.map((attachment) => attachment.filename),
      },
      threadVerification: verification,
    };
  }

  async deleteDraft(draftId: string): Promise<{ success: boolean; draftId: string }> {
    await this.gmail.users.drafts.delete({
      userId: "me",
      id: draftId,
    });
    return { success: true, draftId };
  }

  async verifyDraftThreadMembership(
    expectedThreadId: string,
    draftMessageId?: string
  ): Promise<NonNullable<DraftResult["threadVerification"]>> {
    const thread = await this.gmail.users.threads.get({
      userId: "me",
      id: expectedThreadId,
      format: "metadata",
    });
    const memberMessageIds = (thread.data.messages ?? [])
      .map((message) => message.id)
      .filter((id): id is string => Boolean(id));
    return {
      method: "gmail.threads.get",
      expectedThreadId,
      draftMessageId,
      memberMessageIds,
      draftInThread: Boolean(
        draftMessageId && memberMessageIds.includes(draftMessageId)
      ),
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
  ): Promise<EmailListPage> {
    return this.listEmails(query, maxResults, pageToken);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emailDetailFromMessage(message: gmail_v1.Schema$Message): EmailDetail {
    const headers = message.payload?.headers ?? [];
    const hdr = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";

    const headersMap: Record<string, string> = {};
    for (const h of headers) {
      if (h.name && h.value) headersMap[h.name] = h.value;
    }

    const body = this.extractBody(message.payload ?? {});
    const unsubscribeLinks = this.parseUnsubscribeLinks(headersMap, body);

    return {
      id: message.id!,
      threadId: message.threadId!,
      subject: hdr("Subject"),
      from: hdr("From"),
      to: hdr("To"),
      date: hdr("Date"),
      snippet: message.snippet ?? "",
      body,
      labelIds: message.labelIds ?? [],
      headers: headersMap,
      attachments: this.extractAttachments(message.payload),
      unsubscribeLinks,
    };
  }

  private extractAttachments(
    payload?: gmail_v1.Schema$MessagePart
  ): AttachmentSummary[] {
    if (!payload) return [];
    const attachments: AttachmentSummary[] = [];
    const visit = (part: gmail_v1.Schema$MessagePart) => {
      const filename = part.filename ?? "";
      const attachmentId = part.body?.attachmentId ?? undefined;
      if (filename || attachmentId) {
        attachments.push({
          filename,
          mimeType: part.mimeType ?? "",
          attachmentId,
          size: part.body?.size ?? undefined,
          partId: part.partId ?? undefined,
        });
      }
      for (const child of part.parts ?? []) visit(child);
    };
    visit(payload);
    return attachments;
  }

  private evidenceAttachmentsFromMessage(
    message: gmail_v1.Schema$Message
  ): EvidenceAttachment[] {
    if (!message.id || !message.payload) return [];
    const attachments: EvidenceAttachment[] = [];
    const visit = (part: gmail_v1.Schema$MessagePart) => {
      const filename = part.filename ?? "";
      const attachmentId = part.body?.attachmentId ?? undefined;
      if (filename || attachmentId) {
        const mimeType = part.mimeType ?? "application/octet-stream";
        attachments.push({
          source_message_id: message.id!,
          field: part.partId ?? attachmentId ?? filename,
          filename: filename || attachmentId || "attachment",
          mime_type: mimeType,
          size_bytes: part.body?.size ?? null,
          is_pdf:
            mimeType.toLowerCase() === "application/pdf" ||
            filename.toLowerCase().endsWith(".pdf"),
          attachment_id: attachmentId,
        });
      }
      for (const child of part.parts ?? []) visit(child);
    };
    visit(message.payload);
    return attachments;
  }

  private async extractEvidencePdf(
    attachment: EvidenceAttachment,
    maxPdfPages: number
  ): Promise<EvidencePdf> {
    const base = {
      ...attachment,
      text: "",
      text_character_count: 0,
      page_count: null as number | null,
      error: null as string | null,
    };
    if (!attachment.attachment_id) {
      return { ...base, status: "failed", error: "Gmail omitted attachment data id" };
    }

    let parser: PDFParse | null = null;
    try {
      const response = await this.gmail.users.messages.attachments.get({
        userId: "me",
        messageId: attachment.source_message_id,
        id: attachment.attachment_id,
      });
      if (!response.data.data) {
        throw new Error("Gmail omitted PDF attachment data");
      }
      const bytes = Buffer.from(response.data.data, "base64url");
      const maxBytes = Number(process.env.MAIL_EVIDENCE_MAX_PDF_BYTES ?? 20 * 1024 * 1024);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.length > maxBytes) {
        throw new Error(`PDF exceeds the configured ${maxBytes}-byte evidence limit`);
      }
      parser = new PDFParse({ data: bytes });
      const result = await parser.getText({ first: maxPdfPages });
      const text = result.text ?? "";
      return {
        ...base,
        status: text.trim() ? "complete" : "needs_ocr",
        text,
        text_character_count: text.length,
        page_count: result.total || null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        status: /password|encrypted/i.test(message) ? "password_required" : "failed",
        error: message,
      };
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  }

  private async fetchPreservedAttachments(
    message: gmail_v1.Schema$Message
  ): Promise<PreservedAttachment[]> {
    if (!message.id || !message.payload) return [];
    const attachments: PreservedAttachment[] = [];

    const visit = async (part: gmail_v1.Schema$MessagePart): Promise<void> => {
      const filename = part.filename ?? "";
      const attachmentId = part.body?.attachmentId ?? undefined;
      const inlineData = part.body?.data ?? undefined;

      if (filename || attachmentId) {
        let data = inlineData;
        if (!data && attachmentId) {
          const attachment = await this.gmail.users.messages.attachments.get({
            userId: "me",
            messageId: message.id!,
            id: attachmentId,
          });
          data = attachment.data.data ?? undefined;
        }

        if (!data) {
          throw new Error(
            `Draft ${message.id} contains attachment ${filename || attachmentId} but Gmail did not return attachment data.`
          );
        }

        attachments.push({
          filename,
          mimeType: part.mimeType ?? "application/octet-stream",
          attachmentId,
          size: part.body?.size ?? undefined,
          partId: part.partId ?? undefined,
          data: Buffer.from(data, "base64url").toString("base64"),
        });
      }

      for (const child of part.parts ?? []) {
        await visit(child);
      }
    };

    await visit(message.payload);
    return attachments;
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart): string {
    // Prefer text/plain, fall back to text/html
    if (payload.mimeType === "text/plain" && payload.body?.data) {
      return Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }

    if (payload.mimeType === "text/html" && payload.body?.data) {
      return Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }

    // Multipart: recurse
    if (payload.parts) {
      // Try text/plain first
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64url").toString("utf-8");
        }
      }
      // Fall back to text/html
      for (const part of payload.parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
          return Buffer.from(part.body.data, "base64url").toString("utf-8");
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
