import assert from "node:assert/strict";
import { test } from "node:test";
import { GmailService } from "../src/gmail-service.ts";

function serviceWithMock(mockGmail) {
  const service = new GmailService("test-token");
  service.gmail = mockGmail;
  return service;
}

function replyMessage(threadId = "thread-1") {
  return {
    data: {
      id: "reply-message-1",
      threadId,
      snippet: "",
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "Subject", value: "Original subject" },
          { name: "From", value: "Client <client@example.com>" },
          { name: "To", value: "me@example.com" },
          { name: "Date", value: "Tue, 4 Aug 2026 10:00:00 +0000" },
          { name: "Message-ID", value: "<reply-message-1@example.com>" },
          { name: "References", value: "<prior@example.com>" },
        ],
        body: { data: "" },
      },
    },
  };
}

function draftMessage(threadId = "thread-1", id = "draft-message-1") {
  return {
    data: {
      id: "draft-1",
      message: {
        id,
        threadId,
        snippet: "Draft body",
        labelIds: ["DRAFT"],
        payload: {
          headers: [
            { name: "Subject", value: "Re: Original subject" },
            { name: "From", value: "Me <me@example.com>" },
            { name: "To", value: "Client <client@example.com>" },
            { name: "Date", value: "Tue, 4 Aug 2026 10:05:00 +0000" },
            { name: "In-Reply-To", value: "<reply-message-1@example.com>" },
            { name: "References", value: "<prior@example.com> <reply-message-1@example.com>" },
          ],
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("Draft body").toString("base64url") },
            },
            {
              partId: "1",
              filename: "invoice.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: "attachment-1", size: 1234 },
            },
          ],
        },
      },
    },
  };
}

test("listEmails returns Gmail pagination metadata and accepts page tokens", async () => {
  let observedList;
  const service = serviceWithMock({
    users: {
      messages: {
        list: async (request) => {
          observedList = request;
          return {
            data: {
              messages: [{ id: "message-1" }],
              nextPageToken: "next-page-token",
              resultSizeEstimate: 101,
            },
          };
        },
        get: async () => ({
          data: {
            id: "message-1",
            threadId: "thread-1",
            snippet: "Snippet",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "Subject", value: "Subject" },
                { name: "From", value: "Sender <sender@example.com>" },
                { name: "Date", value: "Sat, 22 Aug 2026 19:00:00 +0000" },
              ],
            },
          },
        }),
      },
    },
  });

  const page = await service.listEmails("newer_than:30d", 100, "current-page-token");

  assert.equal(observedList.q, "newer_than:30d");
  assert.equal(observedList.maxResults, 100);
  assert.equal(observedList.pageToken, "current-page-token");
  assert.equal(page.emails.length, 1);
  assert.equal(page.nextPageToken, "next-page-token");
  assert.equal(page.resultSizeEstimate, 101);
  assert.equal(page.paginationComplete, false);
});

test("createDraft rejects mismatched thread_id and reply_message_id before draft creation", async () => {
  let draftCreateCalls = 0;
  const service = serviceWithMock({
    users: {
      messages: {
        get: async () => replyMessage("provider-thread"),
      },
      drafts: {
        create: async () => {
          draftCreateCalls += 1;
          throw new Error("must not create draft");
        },
      },
      threads: {
        get: async () => {
          throw new Error("must not verify thread");
        },
      },
    },
  });

  await assert.rejects(
    service.createDraft({
      to: "",
      subject: "",
      body: "Draft body",
      threadId: "client-supplied-thread",
      replyMessageId: "reply-message-1",
    }),
    /thread_id does not match/
  );
  assert.equal(draftCreateCalls, 0);
});

test("createDraft fails when Gmail threads.get does not include the draft message", async () => {
  const service = serviceWithMock({
    users: {
      messages: {
        get: async () => replyMessage("thread-1"),
      },
      drafts: {
        create: async () => ({
          data: {
            id: "draft-1",
            message: { id: "draft-message-1", threadId: "thread-1" },
          },
        }),
      },
      threads: {
        get: async () => ({
          data: {
            messages: [{ id: "reply-message-1" }],
          },
        }),
      },
    },
  });

  await assert.rejects(
    service.createDraft({
      to: "",
      subject: "",
      body: "Draft body",
      threadId: "thread-1",
      replyMessageId: "reply-message-1",
    }),
    /threads\.get does not show it/
  );
});

test("createDraft returns provider verification when draft is a thread member", async () => {
  const service = serviceWithMock({
    users: {
      messages: {
        get: async () => replyMessage("thread-1"),
      },
      drafts: {
        create: async () => ({
          data: {
            id: "draft-1",
            message: { id: "draft-message-1", threadId: "thread-1" },
          },
        }),
      },
      threads: {
        get: async () => ({
          data: {
            messages: [{ id: "reply-message-1" }, { id: "draft-message-1" }],
          },
        }),
      },
    },
  });

  const result = await service.createDraft({
    to: "",
    subject: "",
    body: "Draft body",
    threadId: "thread-1",
    replyMessageId: "reply-message-1",
  });

  assert.equal(result.draftId, "draft-1");
  assert.equal(result.messageId, "draft-message-1");
  assert.equal(result.threaded, true);
  assert.equal(result.threadVerification?.method, "gmail.threads.get");
  assert.equal(result.threadVerification?.draftInThread, true);
});

test("updateDraft updates in place and verifies provider thread membership", async () => {
  let updatedDraftId = "";
  let updatedRaw = "";
  const service = serviceWithMock({
    users: {
      messages: {
        get: async () => replyMessage("thread-1"),
        attachments: {
          get: async ({ messageId, id }) => {
            assert.equal(messageId, "draft-message-2");
            assert.equal(id, "attachment-1");
            return {
              data: {
                data: Buffer.from("%PDF- preserved attachment").toString("base64url"),
              },
            };
          },
        },
      },
      drafts: {
        get: async () => draftMessage("thread-1", "draft-message-2"),
        update: async ({ id, requestBody }) => {
          updatedDraftId = id;
          updatedRaw = Buffer.from(
            requestBody.message.raw,
            "base64url"
          ).toString("utf8");
          return {
            data: {
              id,
              message: { id: "draft-message-2", threadId: "thread-1" },
            },
          };
        },
      },
      threads: {
        get: async () => ({
          data: {
            messages: [{ id: "reply-message-1" }, { id: "draft-message-2" }],
          },
        }),
      },
    },
  });

  const result = await service.updateDraft({
    draftId: "draft-1",
    body: "Updated body",
    threadId: "thread-1",
    replyMessageId: "reply-message-1",
  });

  assert.equal(updatedDraftId, "draft-1");
  assert.equal(result.draftId, "draft-1");
  assert.equal(result.threadVerification?.draftInThread, true);
  assert.equal(result.attachmentPreservation?.preserved, true);
  assert.equal(result.attachmentPreservation?.count, 1);
  assert.deepEqual(result.attachmentPreservation?.filenames, ["invoice.pdf"]);
  assert.match(updatedRaw, /Content-Type: multipart\/mixed/);
  assert.match(updatedRaw, /Updated body/);
  assert.match(updatedRaw, /Content-Disposition: attachment; filename="invoice.pdf"/);
  assert.match(
    updatedRaw,
    new RegExp(Buffer.from("%PDF- preserved attachment").toString("base64"))
  );
});

test("deleteDraft deletes only the exact draft ID", async () => {
  let deletedDraftId = "";
  const service = serviceWithMock({
    users: {
      drafts: {
        delete: async ({ id }) => {
          deletedDraftId = id;
          return {};
        },
      },
    },
  });

  const result = await service.deleteDraft("draft-to-delete");
  assert.equal(deletedDraftId, "draft-to-delete");
  assert.equal(result.success, true);
});

test("getDraft exposes attachment metadata for read-back", async () => {
  const service = serviceWithMock({
    users: {
      drafts: {
        get: async () => draftMessage("thread-1", "draft-message-1"),
      },
    },
  });

  const result = await service.getDraft("draft-1");
  assert.deepEqual(result.attachments, [
    {
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      attachmentId: "attachment-1",
      size: 1234,
      partId: "1",
    },
  ]);
});
