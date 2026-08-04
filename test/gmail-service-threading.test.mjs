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
