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
    maxResults: number = 20
  ): Promise<EmailSummary[]> {
    const res = await this.gmail.users.messages.list({
      userId: "me",
      q: query || undefined,
      maxResults: Math.min(maxResults, 100),
    });

    const messageIds = res.data.messages ?? [];
    if (messageIds.length === 0) return [];

    // Fetch headers for each message in parallel (batched)
    const summaries = await Promise.all(
      messageIds.map((m) => this.getEmailSummary(m.id!))
    );

    return summaries;
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

    const headers = res.data.payload?.headers ?? [];
    const hdr = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";

    const headersMap: Record<string, string> = {};
    for (const h of headers) {
      if (h.name && h.value) headersMap[h.name] = h.value;
    }

    const body = this.extractBody(res.data.payload ?? {});
    const unsubscribeLinks = this.parseUnsubscribeLinks(headersMap, body);

    return {
      id: res.data.id!,
      threadId: res.data.threadId!,
      subject: hdr("Subject"),
      from: hdr("From"),
      to: hdr("To"),
      date: hdr("Date"),
      snippet: res.data.snippet ?? "",
      body,
      labelIds: res.data.labelIds ?? [],
      headers: headersMap,
      unsubscribeLinks,
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

    const existingDraft = await this.getDraft(options.draftId);
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

    const raw = Buffer.from(
      buildPlainTextMessage({
        to,
        subject,
        body: options.body,
        inReplyTo: messageIdHeader ?? existingDraft.headers["In-Reply-To"],
        references: referencesHeader,
      }),
      "utf8"
    ).toString("base64url");

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
    maxResults: number = 20
  ): Promise<EmailSummary[]> {
    return this.listEmails(query, maxResults);
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
      unsubscribeLinks,
    };
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
