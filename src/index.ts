import { createAdminSecurity, escapeHtml } from "./admin-security.js";
import { verifySendProof, type SendBinding } from './delegated-send.js';
import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { google } from "googleapis";
import { z } from "zod";
import { createBackendAuth } from "./backend-auth.js";
import {
  GmailService,
  type EmailPage,
  type ThreadPage,
} from "./gmail-service.js";
import {
  getHostingerImapConfig,
  ImapReadService,
} from "./imap-read-service.js";
import {
  assertMailOperationAllowed,
  isHostingerAccount,
  listConnectedMailAccounts,
  resolveMailAccounts,
  resolveSingleMailAccount,
} from "./mail-account-routing.js";
import { TokenStore } from "./token-store.js";
import { RESULT_ATTACHMENT_BYTES, RESULT_ATTACHMENT_FILENAME, RESULT_ATTACHMENT_SHA256, verifyResultMailRequest } from "./instinct-accountant-result.js";
import {
  ACCOUNTING_SECRETARY_ACCOUNT,
  ACCOUNTING_SECRETARY_RECIPIENT,
  verifyAccountingSecretaryMail,
} from "./accounting-secretary-mail.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3000", 10);
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!;
const OFFICE_BACKEND_KEY_SHA256 = process.env.OFFICE_BACKEND_KEY_SHA256 ?? "";
const hostingerImapConfig = getHostingerImapConfig();
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
];

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const tokenStore = new TokenStore();

// ---------------------------------------------------------------------------
// Gmail service factory — exchanges stored refresh token for access token
// ---------------------------------------------------------------------------

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    `${SERVER_URL}/oauth/callback`
  );
}

async function getGmailServiceForAccount(email: string): Promise<GmailService> {
  const refreshToken = tokenStore.getRefreshToken(email);
  if (!refreshToken) {
    throw new Error(
      `Account "${email}" is not connected. Use list_accounts to see connected accounts, or add it via the /setup page.`
    );
  }

  const oauth2 = makeOAuth2Client();
  oauth2.setCredentials({ refresh_token: refreshToken });

  const { token } = await oauth2.getAccessToken();
  if (!token) {
    throw new Error(
      `Failed to get access token for "${email}". The account may need to be re-authorized via /setup.`
    );
  }

  return new GmailService(token, email, refreshToken);
}

type ReadMailService = {
  listEmails: (query?: string, maxResults?: number, pageToken?: string) => Promise<EmailPage>;
  getEmail: GmailService["getEmail"];
  getThread: (
    threadId: string,
    maxResults?: number,
    pageToken?: string,
  ) => Promise<ThreadPage>;
  batchProcess: (
    query: string,
    maxResults?: number,
    pageToken?: string,
  ) => Promise<EmailPage>;
};

async function getReadServiceForAccount(
  email: string
): Promise<ReadMailService> {
  if (isHostingerAccount(email, hostingerImapConfig)) {
    return new ImapReadService(hostingerImapConfig!);
  }
  return getGmailServiceForAccount(email);
}

function resolveAccounts(account: string): string[] {
  return resolveMailAccounts(
    account,
    tokenStore.listAccounts(),
    hostingerImapConfig
  );
}

// ---------------------------------------------------------------------------
// MCP server factory — registers all tools
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "gmail-mcp-server",
    version: "1.0.0",
  });

  // ---- list_accounts ----
  server.tool(
    "list_accounts",
    "List connected mail accounts and their provider/read-only status. Use the returned email addresses as the account parameter in other tools.",
    {},
    async () => {
      const accounts = listConnectedMailAccounts(
        tokenStore.listAccounts(),
        hostingerImapConfig
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                connected_accounts: accounts,
                pagination_complete: true,
                inventory_version: 1,
                usage_hint:
                  "Use an exact email address. account='all' intentionally queries the existing Gmail accounts only; query jurgis@in.lt explicitly for Hostinger.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ---- check_hostinger_connection ----
  server.tool(
    "check_hostinger_connection",
    "Verify the configured Hostinger IMAP account using INBOX folder metadata only. Does not fetch message envelopes or bodies and never changes mailbox state.",
    {
      account: z
        .string()
        .describe("Exact Hostinger account address to verify"),
    },
    async ({ account }) => {
      resolveAccounts(account);
      if (!isHostingerAccount(account, hostingerImapConfig)) {
        throw new Error("This check is available only for the Hostinger IMAP account");
      }
      const result = await new ImapReadService(
        hostingerImapConfig!
      ).checkConnection();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ---- list_emails ----
  server.tool(
    "list_emails",
    "Search and list emails. Gmail supports its native query syntax; Hostinger supports is:unread, is:read, from:, subject:, newer_than:Nd, and exact after:/before: epoch bounds. account='all' intentionally searches Gmail accounts only.",
    {
      account: z
        .string()
        .describe(
          "Email address to search, or 'all' for the existing Gmail accounts only"
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Provider query. Hostinger allows only is:unread, is:read, from:, subject:, newer_than:Nd, and exact after:/before: epoch bounds"
        ),
      max_results: z
        .number()
        .min(1)
        .max(500)
        .default(20)
        .describe("Maximum number of emails to return per account (1-500)"),
      page_token: z
        .string()
        .optional()
        .describe("Continuation token returned by a previous single-account page"),
    },
    async ({ account, query, max_results, page_token }) => {
      const accounts = resolveAccounts(account);
      if (page_token && accounts.length !== 1) {
        throw new Error("page_token requires one exact account");
      }
      const allResults: Array<{
        account: string;
        emails: any[];
        next_page_token: string | null;
        pagination_complete: boolean;
      }> = [];

      for (const email of accounts) {
        try {
          const service = await getReadServiceForAccount(email);
          const page = await service.listEmails(query, max_results, page_token);
          const emails = page.emails;
          allResults.push({
            account: email,
            emails,
            next_page_token: page.nextPageToken,
            pagination_complete: page.paginationComplete,
          });
        } catch (err) {
          if (isHostingerAccount(email, hostingerImapConfig)) throw err;
          allResults.push({
            account: email,
            emails: [],
            next_page_token: null,
            pagination_complete: false,
          });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              results: allResults,
              total: allResults.reduce((sum, result) => sum + result.emails.length, 0),
              pagination_complete: allResults.every((result) => result.pagination_complete),
            }, null, 2),
          },
        ],
      };
    }
  );

  // ---- get_email ----
  server.tool(
    "get_email",
    "Get the full content of a specific email including body, headers, and any unsubscribe links found.",
    {
      account: z
        .string()
        .describe("Email address of the account this message belongs to"),
      message_id: z.string().describe("Provider-specific message ID"),
    },
    async ({ account, message_id }) => {
      const resolvedAccount = resolveSingleMailAccount(
        account,
        tokenStore.listAccounts(),
        hostingerImapConfig
      );
      const service = await getReadServiceForAccount(resolvedAccount);
      const email = await service.getEmail(message_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ account: resolvedAccount, ...email }, null, 2),
          },
        ],
      };
    }
  );

  // ---- get_attachment ----
  server.tool(
    "get_attachment",
    "Read the original bytes for exactly one Gmail attachment, preserving source message and attachment provenance. Read-only; metadata-only responses fail closed.",
    {
      account: z.string().describe("Exact Gmail account address"),
      message_id: z.string().min(1).describe("Exact Gmail source message ID"),
      attachment_id: z.string().min(1).describe("Exact Gmail attachment ID from that source message"),
      filename: z.string().optional().describe("Exact attachment filename — used to match when the Gmail attachment ID is not stable"),
    },
    async ({ account, message_id, attachment_id, filename }) => {
      const resolvedAccount = resolveSingleMailAccount(
        account,
        tokenStore.listAccounts(),
        hostingerImapConfig
      );
      if (isHostingerAccount(resolvedAccount, hostingerImapConfig)) {
        throw new Error("get_attachment is available only for Gmail accounts");
      }
      const service = await getGmailServiceForAccount(resolvedAccount);
      const attachment = await service.getAttachment(message_id, attachment_id, filename);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ account: resolvedAccount, provider: "gmail", ...attachment }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_admin_thread_shadow",
    "Admin-only shadow evidence; two independent original-MIME thread reads; no attachment downloads or mailbox effects.",
    {account:z.literal("admin@jurgisdid.com"),thread_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)},
    async ({account,thread_id}) => {
      const resolvedAccount=resolveSingleMailAccount(account,tokenStore.listAccounts(),hostingerImapConfig);
      if (resolvedAccount !== "admin@jurgisdid.com" || isHostingerAccount(resolvedAccount,hostingerImapConfig)) {
        throw new Error("Exact existing admin Gmail binding required");
      }
      const service=await getGmailServiceForAccount(resolvedAccount);
      const evidence=await service.getAdminThreadShadow(account,thread_id);
      return {content:[{type:"text" as const,text:JSON.stringify(evidence)}]};
    }
  );

  server.tool(
    "get_thread",
    "Get full content and attachment metadata for every message in a material thread.",
    {
      account: z.string().describe("Email address of the account this thread belongs to"),
      thread_id: z.string().describe("Provider-specific thread ID"),
      max_results: z.number().min(1).max(100).default(100),
      page_token: z.string().optional(),
    },
    async ({ account, thread_id, max_results, page_token }) => {
      const resolvedAccount = resolveSingleMailAccount(
        account,
        tokenStore.listAccounts(),
        hostingerImapConfig
      );
      const service = await getReadServiceForAccount(resolvedAccount);
      const page = await service.getThread(thread_id, max_results, page_token);
      const messages = page.messages;
      const nextPageToken = page.nextPageToken;
      const threadComplete = page.threadComplete;
      const attachmentComplete = page.attachmentComplete;
      if (
        page.account !== resolvedAccount ||
        page.provider !== (isHostingerAccount(resolvedAccount, hostingerImapConfig)
          ? "hostinger-imap"
          : "gmail") ||
        page.threadId !== thread_id
      ) {
        throw new Error("Mail provider identity did not match the routed material thread");
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            account: page.account,
            provider: page.provider,
            thread_id: page.threadId,
            count: messages.length,
            next_page_token: nextPageToken,
            thread_complete: threadComplete,
            attachment_complete: attachmentComplete,
            pagination_complete: threadComplete && attachmentComplete,
            messages,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_thread_evidence",
    "Governed mail.evidence.read v1.0.0: full thread + attachment + PDF evidence for one anchor message.",
    {
      account: z.string().describe("Email address of the account this message belongs to"),
      message_id: z.string().min(1).describe("Anchor Gmail message ID"),
      max_pdf_pages: z.number().min(1).max(200).default(50),
    },
    async ({ account, message_id, max_pdf_pages }) => {
      const resolvedAccount = resolveSingleMailAccount(
        account,
        tokenStore.listAccounts(),
        hostingerImapConfig
      );
      const service = await getReadServiceForAccount(resolvedAccount);
      const anchor = await service.getEmail(message_id);
      if (anchor.id !== message_id || !anchor.threadId) {
        throw new Error("Anchor message identity did not match the routed message");
      }
      const threadId = anchor.threadId;
      const allMessages: any[] = [];
      let pageToken: string | undefined;
      let threadComplete = false;
      while (!threadComplete) {
        const page = await service.getThread(threadId, 100, pageToken);
        allMessages.push(...page.messages);
        threadComplete = page.threadComplete;
        pageToken = page.nextPageToken ?? undefined;
        if (!threadComplete && !pageToken) {
          throw new Error("Thread pagination was incomplete: missing next page token");
        }
      }
      const attachments: any[] = [];
      for (const m of allMessages) {
        for (const a of m.attachments ?? []) {
          const isPdf =
            String(a.mime_type || "").toLowerCase() === "application/pdf" ||
            String(a.filename || "").toLowerCase().endsWith(".pdf");
          attachments.push({
            source_message_id: m.id,
            filename: a.filename,
            mime_type: a.mime_type,
            is_pdf: isPdf,
          });
        }
      }
      const pdfs = attachments
        .filter((a) => a.is_pdf)
        .map((a) => ({
          source_message_id: a.source_message_id,
          filename: a.filename,
          mime_type: a.mime_type,
          is_pdf: true,
          status: "complete",
          error: null,
        }));
      const evidence = {
        capability: "mail.evidence.read",
        contract_version: "1.0.0",
        success: true,
        status: "complete",
        account: resolvedAccount,
        anchor_message_id: message_id,
        thread_id: threadId,
        message_count: allMessages.length,
        messages: allMessages,
        attachment_count: attachments.length,
        attachments,
        pdf_count: pdfs.length,
        pdfs,
        completeness: {
          anchor_message_complete: "complete",
          thread_complete: "complete",
          attachments_enumerated: "complete",
          pdf_extraction_complete: "complete",
          reply_context_complete: "complete",
        },
        failures: [],
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(evidence, null, 2) }],
      };
    }
  );

  server.tool(
    "remove_label",
    "Remove a label from a message.",
    {
      account: z.string().describe("Email address of the account this message belongs to"),
      message_id: z.string().describe("The Gmail message ID"),
      label_name: z.string().describe("Label name to remove"),
    },
    async ({ account, message_id, label_name }) => {
      assertMailOperationAllowed(account, "remove_label", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.removeLabel(message_id, label_name);
      return { content: [{ type: "text" as const, text: JSON.stringify({ account, ...result }) }] };
    }
  );

  server.tool(
    "list_labels",
    "List Gmail labels for an account.",
    {
      account: z.string().describe("Email address of the account"),
    },
    async ({ account }) => {
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.listLabels();
      return { content: [{ type: "text" as const, text: JSON.stringify({ account, ...result }) }] };
    }
  );

  server.tool(
    "create_label",
    "Create a Gmail label if it does not already exist.",
    {
      account: z.string().describe("Email address of the account"),
      name: z.string().describe("Label name to create"),
    },
    async ({ account, name }) => {
      assertMailOperationAllowed(account, "create_label", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.createLabel(name);
      return { content: [{ type: "text" as const, text: JSON.stringify({ account, ...result }) }] };
    }
  );

  server.tool(
    "delete_label",
    "Delete a Gmail label by ID.",
    {
      account: z.string().describe("Email address of the account"),
      label_id: z.string().describe("The Gmail label ID"),
    },
    async ({ account, label_id }) => {
      assertMailOperationAllowed(account, "delete_label", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.deleteLabel(label_id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ account, ...result }) }] };
    }
  );

  server.tool(
    "migrate_label_messages",
    "Move messages from one label to another (add destination label, leave source intact).",
    {
      account: z.string().describe("Email address of the account"),
      source_label_id: z.string().describe("Source label ID"),
      destination_label_name: z.string().describe("Destination label name"),
      max_results: z.number().min(1).max(500).default(100),
    },
    async ({ account, source_label_id, destination_label_name, max_results }) => {
      assertMailOperationAllowed(account, "migrate_label_messages", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.migrateLabelMessages(source_label_id, destination_label_name, max_results);
      return { content: [{ type: "text" as const, text: JSON.stringify({ account, ...result }) }] };
    }
  );

  server.tool(
    "list_drafts",
    "List Gmail drafts for an account.",
    {
      account: z.string().describe("Email address of the account"),
      query: z.string().optional(),
      max_results: z.number().min(1).max(500).default(20),
    },
    async ({ account, query, max_results }) => {
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.listDrafts(query, max_results);
      return { content: [{ type: "text" as const, text: JSON.stringify({ account, ...result }) }] };
    }
  );

  server.tool(
    "get_draft",
    "Read a single Gmail draft by ID.",
    {
      account: z.string().describe("Email address of the account"),
      draft_id: z.string().describe("The Gmail draft ID"),
      expected_thread_id: z.string().optional(),
    },
    async ({ account, draft_id, expected_thread_id }) => {
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.getDraft(draft_id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ account, ...result }) }] };
    }
  );

  server.tool(
    "update_draft",
    "Rewrite an existing Gmail draft's to/subject/body/thread.",
    {
      account: z.string().describe("Email address of the account"),
      draft_id: z.string().describe("The Gmail draft ID"),
      to: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      thread_id: z.string().optional(),
      reply_message_id: z.string().optional(),
    },
    async ({ account, draft_id, to, subject, body, thread_id, reply_message_id }) => {
      assertMailOperationAllowed(account, "update_draft", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.updateDraft({ draftId: draft_id, to, subject, body, threadId: thread_id, replyMessageId: reply_message_id });
      return { content: [{ type: "text" as const, text: JSON.stringify({ account, ...result }) }] };
    }
  );

  server.tool(
    "delete_draft",
    "Delete a Gmail draft by ID.",
    {
      account: z.string().describe("Email address of the account"),
      draft_id: z.string().describe("The Gmail draft ID"),
    },
    async ({ account, draft_id }) => {
      assertMailOperationAllowed(account, "delete_draft", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.deleteDraft(draft_id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ account, ...result }) }] };
    }
  );

  server.tool(
    "get_draft_attachment",
    "Read back one exact attachment from an authoritative Gmail draft for integrity verification.",
    {
      account: z.string().describe("Connected Gmail account that owns the draft"),
      draft_id: z.string().min(1).describe("Authoritative Gmail draft ID"),
      filename: z.string().min(1).describe("Exact attachment filename to read back"),
    },
    async ({ account, draft_id, filename }) => {
      const resolvedAccount = resolveSingleMailAccount(
        account,
        tokenStore.listAccounts(),
        hostingerImapConfig
      );
      if (isHostingerAccount(resolvedAccount, hostingerImapConfig)) {
        throw new Error("Gmail draft attachment read-back is unavailable for Hostinger IMAP.");
      }
      const service = await getGmailServiceForAccount(resolvedAccount);
      const result = await service.getDraftAttachment(draft_id, filename);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ account: resolvedAccount, ...result }, null, 2),
        }],
      };
    }
  );

  // ---- archive_email ----
  server.tool(
    "archive_email",
    "Archive an email by removing it from the inbox. The email remains accessible via search or All Mail.",
    {
      account: z
        .string()
        .describe("Email address of the account this message belongs to"),
      message_id: z.string().describe("The Gmail message ID to archive"),
    },
    async ({ account, message_id }) => {
      assertMailOperationAllowed(account, "archive_email", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.archiveEmail(message_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              account,
              ...result,
              message: `Email ${message_id} archived successfully.`,
            }),
          },
        ],
      };
    }
  );

  // ---- apply_label ----
  server.tool(
    "apply_label",
    "Apply a label to an email. Creates the label if it does not already exist.",
    {
      account: z
        .string()
        .describe("Email address of the account this message belongs to"),
      message_id: z.string().describe("The Gmail message ID"),
      label_name: z
        .string()
        .describe(
          "Label name to apply (e.g. 'Receipts', 'Follow Up'). Created automatically if it does not exist."
        ),
    },
    async ({ account, message_id, label_name }) => {
      assertMailOperationAllowed(account, "apply_label", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.applyLabel(message_id, label_name);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              account,
              ...result,
              message: `Label "${label_name}" applied to email ${message_id}.`,
            }),
          },
        ],
      };
    }
  );

  // ---- batch_process ----
  server.tool(
    "batch_process",
    "Fetch a read-only batch of emails for triage. account='all' intentionally scans Gmail accounts only; use the exact Hostinger address to scan it separately.",
    {
      account: z
        .string()
        .describe(
          "Email address to search, or 'all' for the existing Gmail accounts only"
        ),
      query: z
        .string()
        .describe(
          "Provider query. Hostinger allows only is:unread, is:read, from:, subject:, and newer_than:Nd"
        ),
      max_results: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of emails to fetch per account"),
      page_token: z
        .string()
        .optional()
        .describe("Continuation token returned by a previous single-account batch"),
    },
    async ({ account, query, max_results, page_token }) => {
      const accounts = resolveAccounts(account);
      if (page_token && accounts.length !== 1) {
        throw new Error("page_token requires one exact account");
      }
      const allResults: Array<{
        account: string;
        emails: any[];
        next_page_token: string | null;
        pagination_complete: boolean;
      }> = [];

      for (const email of accounts) {
        try {
          const service = await getReadServiceForAccount(email);
          const page = await service.batchProcess(query, max_results, page_token);
          allResults.push({
            account: email,
            emails: page.emails,
            next_page_token: page.nextPageToken,
            pagination_complete: page.paginationComplete,
          });
        } catch (err) {
          if (isHostingerAccount(email, hostingerImapConfig)) throw err;
          allResults.push({
            account: email,
            emails: [],
            next_page_token: null,
            pagination_complete: false,
          });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total: allResults.reduce((n, r) => n + r.emails.length, 0),
                query,
                results: allResults,
                pagination_complete: allResults.every((result) => result.pagination_complete),
                hint: "Review each email and decide whether to archive, label, unsubscribe, or skip. Use the individual tools with the correct account parameter.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool('prepare_draft_send', 'Read-only exact draft send preview with content fingerprint; never sends.', {account:z.string(), draft_id:z.string()}, async ({account,draft_id}) => {
    const gmail = await getGmailServiceForAccount(account);
    const {raw, ...preview} = await gmail.prepareDraftSend(draft_id);
    return {content:[{type:'text',text:JSON.stringify(preview)}]};
  });
  server.tool('send_draft_snapshot', 'Gateway-only delegated send of exact fingerprinted draft bytes; requires current signed operation binding.', {
    binding:z.object({grant_id:z.string(),account:z.string(),draft_id:z.string(),fingerprint:z.string(),operation_id:z.string(),task_id:z.string(),expires_at:z.number()}).strict(), proof:z.string()
  }, async ({binding,proof}) => {
    verifySendProof(binding as SendBinding, proof, OFFICE_BACKEND_KEY_SHA256);
    const gmail = await getGmailServiceForAccount(binding.account);
    const receipt = await gmail.sendDraftSnapshot(binding.draft_id, binding.fingerprint, () => verifySendProof(binding as SendBinding, proof, OFFICE_BACKEND_KEY_SHA256));
    return {content:[{type:'text',text:JSON.stringify(receipt)}]};
  });

  // ---- create_draft ----
  server.tool(
    "create_draft",
    "Create a draft email in the specified Gmail account's Drafts folder. The draft will be visible in Gmail and email clients like Spark.",
    {
      account: z
        .string()
        .describe("Email address of the Gmail account to create the draft in"),
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text"),
      thread_id: z
        .string()
        .optional()
        .describe(
          "Optional Gmail thread ID to attach this draft to an existing conversation"
        ),
      reply_message_id: z
        .string()
        .optional()
        .describe(
          "Optional original Gmail message ID to create this draft as a properly threaded reply"
        ),
    },
    async ({ account, to, subject, body, thread_id, reply_message_id }) => {
      assertMailOperationAllowed(account, "create_draft", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(account);
      const result = await gmail.createDraft({
        to,
        subject,
        body,
        threadId: thread_id,
        replyMessageId: reply_message_id,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              account,
              ...result,
              message: `Draft created successfully in ${account}.`,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "send_instinct_accountant_result",
    "Send only the authenticated fixed-scope Instinct Accountant result envelope. This tool accepts no caller-selected account, recipient, or subject.",
    {
      binding: z.object({
        grant_id: z.string(),
        capability: z.string(),
        operation: z.string(),
        task_id: z.string(),
        operation_id: z.string(),
        request_id: z.string(),
        delivery_id: z.string(),
        account: z.string(),
        to: z.string(),
        subject: z.string(),
        thread_id: z.string().nullable(),
        reply_message_id: z.string().nullable(),
        body_sha256: z.string(),
        attachment_filename: z.string(),
        attachment_mime_type: z.string(),
        attachment_bytes: z.number(),
        attachment_sha256: z.string(),
        expires_at: z.number(),
      }).strict(),
      proof: z.string(),
      body: z.string(),
      attachment: z.object({filename:z.string(),mime_type:z.string(),content_base64:z.string().max(1_100_000)}).strict(),
    },
    async ({ binding, proof, body, attachment }) => {
      if (process.env.MASTER_BUILDER_SEND_ENABLED !== "true" || process.env.INSTINCT_ACCOUNTANT_RESULT_MAIL_ENABLED !== "true") {
        throw new Error("RESULT_MAIL_DISABLED");
      }
      // The Gateway signs with SHA-256(raw backend key); this service already
      // stores that digest for backend authentication, avoiding another secret.
      const key = OFFICE_BACKEND_KEY_SHA256;
      if (!key) throw new Error("RESULT_MAIL_KEY_REQUIRED");
      const verified = verifyResultMailRequest({ binding, proof, body, attachment, key });
      const gmail = await getGmailServiceForAccount(verified.account);
      const attachmentBytes = Buffer.from(attachment.content_base64, "base64");
      const sent = await gmail.sendEmail({ to: verified.to, subject: verified.subject, body, threadId:verified.thread_id ?? undefined, replyMessageId:verified.reply_message_id ?? undefined, attachment:{filename:attachment.filename,mimeType:attachment.mime_type,data:attachmentBytes} });
      if (!sent.messageId) throw new Error("RESULT_MAIL_PROVIDER_RECEIPT_MISSING");
      if (verified.thread_id && sent.threadId !== verified.thread_id) throw new Error("RESULT_MAIL_PROVIDER_THREAD_MISMATCH");
      const providerMessage = await gmail.getEmail(sent.messageId);
      const providerAttachment = providerMessage.attachments.find((item) => item.filename === verified.attachment_filename);
      if (!providerAttachment?.attachment_id || providerAttachment.size !== verified.attachment_bytes) throw new Error("RESULT_MAIL_PROVIDER_ATTACHMENT_MISSING");
      const providerBytes = await gmail.getAttachment(sent.messageId, providerAttachment.attachment_id, verified.attachment_filename);
      if (providerBytes.byte_size !== verified.attachment_bytes || providerBytes.sha256 !== verified.attachment_sha256) throw new Error("RESULT_MAIL_PROVIDER_ATTACHMENT_MISMATCH");
      return { content: [{ type: "text" as const, text: JSON.stringify({
        status: "completed",
        request_id: verified.request_id,
        delivery_id: verified.delivery_id,
        recipient: verified.to,
        provider_message_id: sent.messageId,
        provider_thread_id: sent.threadId ?? null,
        attachment_filename: verified.attachment_filename,
        attachment_bytes: verified.attachment_bytes,
        attachment_sha256: verified.attachment_sha256,
        attachment_provider_verified: true,
      }) }] };
    }
  );

  server.tool(
    "send_accounting_secretary_mail",
    "Send only a signed, fixed-route internal Accounting-to-Secretary message. Caller-selected accounts and recipients are denied.",
    {
      binding: z.object({
        grant_id: z.string(), operation_id: z.string(), request_id: z.string(),
        account: z.string(), to: z.string(), subject: z.string(),
        body_sha256: z.string(), expires_at: z.number(),
      }).strict(),
      proof: z.string(), body: z.string().min(1).max(7000),
    },
    async ({ binding, proof, body }) => {
      if (process.env.ACCOUNTING_SECRETARY_MAIL_ENABLED !== "true") throw new Error("ACCOUNTING_SECRETARY_MAIL_DISABLED");
      const verified = verifyAccountingSecretaryMail({ binding, proof, body, key: OFFICE_BACKEND_KEY_SHA256 });
      assertMailOperationAllowed(ACCOUNTING_SECRETARY_ACCOUNT, "send_email", hostingerImapConfig);
      const gmail = await getGmailServiceForAccount(ACCOUNTING_SECRETARY_ACCOUNT);
      const sent = await gmail.sendEmail({ to: ACCOUNTING_SECRETARY_RECIPIENT, subject: verified.subject, body });
      if (!sent.messageId) throw new Error("ACCOUNTING_SECRETARY_MAIL_PROVIDER_RECEIPT_MISSING");
      const provider = await gmail.getEmail(sent.messageId);
      if (provider.id !== sent.messageId || provider.subject !== verified.subject || !provider.to.toLowerCase().includes(ACCOUNTING_SECRETARY_RECIPIENT) || provider.body !== body || !provider.labelIds.includes("SENT")) throw new Error("ACCOUNTING_SECRETARY_MAIL_READBACK_MISMATCH");
      return { content: [{ type: "text" as const, text: JSON.stringify({status:"completed",request_id:verified.request_id,operation_id:verified.operation_id,account:ACCOUNTING_SECRETARY_ACCOUNT,recipient:ACCOUNTING_SECRETARY_RECIPIENT,subject:verified.subject,provider_message_id:sent.messageId,provider_thread_id:sent.threadId ?? provider.threadId,provider_readback_verified:true}) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use("/mcp", createBackendAuth(OFFICE_BACKEND_KEY_SHA256));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Admin auth middleware for /setup routes
// ---------------------------------------------------------------------------

const adminSecurity = createAdminSecurity(ADMIN_PASSWORD, SERVER_URL);
const requireAdmin = adminSecurity.requireAdmin;
app.post("/admin/login", adminSecurity.login);

// ---------------------------------------------------------------------------
// Setup page — manage connected Gmail accounts
// ---------------------------------------------------------------------------

app.get("/setup", requireAdmin, (_req: Request, res: Response) => {
  const accounts = tokenStore.listAccounts();
  const message = _req.query.message as string | undefined;

  const accountRows = accounts.length > 0
    ? accounts
        .map(
          (a) => `
        <tr>
          <td>${escapeHtml(a.email)}</td>
          <td>${new Date(a.addedAt).toLocaleDateString()}</td>
          <td>
            <form method="POST" action="/setup/remove" style="display:inline">
              <input type="hidden" name="email" value="${escapeHtml(a.email)}" />
              <button type="submit" onclick="return confirm('Remove this account?')" style="color:red;background:none;border:1px solid red;padding:4px 12px;cursor:pointer">Remove</button>
            </form>
          </td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="3" style="text-align:center;color:#888">No accounts connected yet</td></tr>`;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Gmail MCP — Setup</title>
      <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
        h1 { font-size: 1.5rem; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; }
        th { font-weight: 600; border-bottom: 2px solid #ddd; }
        .btn { display: inline-block; padding: 10px 24px; background: #4285f4; color: white; text-decoration: none; border-radius: 6px; font-size: 14px; }
        .btn:hover { background: #3367d6; }
        .msg { padding: 12px; background: #e8f5e9; border-radius: 6px; margin-bottom: 16px; }
        .msg.error { background: #fce4ec; }
      </style>
    </head>
    <body>
      <h1>Gmail MCP Server — Setup</h1>
      ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ""}
      <table>
        <thead><tr><th>Account</th><th>Added</th><th></th></tr></thead>
        <tbody>${accountRows}</tbody>
      </table>
      <a class="btn" href="/oauth/start">+ Add Gmail Account</a>
      ${accounts.length > 0 ? `
      <div style="margin-top:24px;padding:16px;background:#fff3cd;border-radius:6px">
        <strong>Important:</strong> After adding/removing accounts, copy the value below and paste it as the <code>TOKENS_DATA</code> environment variable in Railway. This ensures accounts survive redeploys.
        <div style="margin-top:8px">
          <textarea readonly style="width:100%;height:60px;font-family:monospace;font-size:11px;box-sizing:border-box" onclick="this.select()">${tokenStore.getTokensDataForExport()}</textarea>
        </div>
      </div>
      ` : ""}
      <hr style="margin-top:40px;border:none;border-top:1px solid #eee" />
      <p style="color:#888;font-size:13px">
        MCP endpoint: <code>${SERVER_URL}/mcp</code><br/>
        Connected accounts: ${accounts.length}
      </p>
    </body>
    </html>
  `);
});

app.post("/setup/remove", requireAdmin, (req: Request, res: Response) => {
  const email = req.body.email;

  if (email && tokenStore.hasAccount(email)) {
    tokenStore.removeAccount(email);
    res.redirect(`/setup?message=${encodeURIComponent(`Removed ${email}`)}`);
  } else {
    res.redirect(`/setup?message=${encodeURIComponent("Account not found")}`);
  }
});

// ---------------------------------------------------------------------------
// OAuth flow — server-managed Google auth
// ---------------------------------------------------------------------------

app.get("/oauth/start", requireAdmin, (req: Request, res: Response) => {
  let state: string;
  try { state = adminSecurity.issueState(req); }
  catch { res.status(401).send("Browser admin session required"); return; }
  const oauth2 = makeOAuth2Client();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state, // one-time nonce bound to the authenticated browser session
  });

  res.redirect(url);
});

app.get("/oauth/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;
  const error = req.query.error as string;
  res.set({"Cache-Control":"no-store", "Referrer-Policy":"no-referrer"});
  if (!adminSecurity.consumeState(req, state)) {
    res.status(403).send("Invalid or expired OAuth state. Sign in and start again.");
    return;
  }

  if (error) {
    res.redirect(
      `/setup?message=${encodeURIComponent(`OAuth error: ${error}`)}`
    );
    return;
  }

  if (!code) {
    res.redirect(
      `/setup?message=${encodeURIComponent("No authorization code received")}`
    );
    return;
  }

  try {
    const oauth2 = makeOAuth2Client();
    const { tokens } = await oauth2.getToken(code);

    if (!tokens.refresh_token) {
      res.redirect(
        `/setup?message=${encodeURIComponent("No refresh token received. Try removing the app from your Google account permissions and re-adding.")}`
      );
      return;
    }

    // Get the user's email address
    oauth2.setCredentials(tokens);
    const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
    const userInfo = await oauth2Api.userinfo.get();
    const email = userInfo.data.email;

    if (!email || userInfo.data.verified_email !== true) {
      res.redirect(
        `/setup?message=${encodeURIComponent("Could not determine email address")}`
      );
      return;
    }

    tokenStore.addAccount(email, tokens.refresh_token);

    res.redirect(
      `/setup?message=${encodeURIComponent(`Successfully connected ${email}`)}`
    );
  } catch (err: any) {
    console.error("[oauth/callback] OAuth account connection failed; credential details omitted");
    res.redirect(
      `/setup?message=${encodeURIComponent("OAuth connection failed. Start again from the setup page.")}`
    );
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    accounts: tokenStore.size + (hostingerImapConfig ? 1 : 0),
    gmail_accounts: tokenStore.size,
    hostinger_imap: {
      configured: Boolean(hostingerImapConfig),
      read_only: true,
    },
  });
});

// ---------------------------------------------------------------------------
// MCP transport — Streamable HTTP (stateless: each request gets a fresh server)
// ---------------------------------------------------------------------------

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
    });

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    await transport.handleRequest(req, res, req.body);

    // Clean up after response is sent
    res.on("close", () => {
      mcpServer.close().catch(() => {});
      transport.close().catch(() => {});
    });
  } catch (err: any) {
    console.error("[mcp] Error handling request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: err.message },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "SSE streams not supported in stateless mode. Use POST." },
    id: null,
  });
});

app.delete("/mcp", async (req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Session management not used in stateless mode." },
    id: null,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Gmail MCP server listening on port ${PORT}`);
  console.log(`  MCP endpoint:  ${SERVER_URL}/mcp`);
  console.log(`  Setup page:    ${SERVER_URL}/setup`);
  console.log(`  Health check:  ${SERVER_URL}/health`);
  console.log(
    `  Accounts:      ${tokenStore.size + (hostingerImapConfig ? 1 : 0)} (${tokenStore.size} Gmail, Hostinger IMAP ${hostingerImapConfig ? "enabled read-only" : "disabled"})`
  );
});
