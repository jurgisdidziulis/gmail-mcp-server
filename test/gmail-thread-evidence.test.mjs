import assert from "node:assert/strict";
import { test } from "node:test";
import { GmailService } from "../src/gmail-service.ts";

function message(id, threadId, attachment = null) {
  return {
    id,
    threadId,
    snippet: `Snippet ${id}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: attachment ? "multipart/mixed" : "text/plain",
      headers: [
        { name: "Subject", value: `Subject ${id}` },
        { name: "From", value: "Sender <sender@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Date", value: "Sun, 30 Aug 2026 17:00:00 +0000" },
      ],
      body: attachment
        ? {}
        : { data: Buffer.from(`Body ${id}`).toString("base64url") },
      parts: attachment
        ? [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from(`Body ${id}`).toString("base64url") },
            },
            attachment,
          ]
        : undefined,
    },
  };
}

function serviceWithMock(mockGmail) {
  const service = new GmailService("test-token");
  service.gmail = mockGmail;
  return service;
}

test("getThreadEvidence proves complete identity for a no-attachment thread", async () => {
  const messages = [message("message-1", "thread-1"), message("message-2", "thread-1")];
  const service = serviceWithMock({
    users: {
      messages: { get: async () => ({ data: { id: "message-1", threadId: "thread-1" } }) },
      threads: { get: async () => ({ data: { id: "thread-1", messages } }) },
    },
  });

  const evidence = await service.getThreadEvidence("message-1", 50);
  assert.equal(evidence.success, true);
  assert.equal(evidence.status, "complete");
  assert.equal(evidence.message_count, 2);
  assert.equal(evidence.attachment_count, 0);
  assert.equal(evidence.pdf_count, 0);
  assert.deepEqual(evidence.failures, []);
});

test("getThreadEvidence fails closed when Gmail omits PDF attachment data", async () => {
  const pdf = {
    partId: "1",
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    body: { attachmentId: "attachment-1", size: 1234 },
  };
  const messages = [message("message-1", "thread-1", pdf)];
  const service = serviceWithMock({
    users: {
      messages: {
        get: async () => ({ data: { id: "message-1", threadId: "thread-1" } }),
        attachments: { get: async () => ({ data: {} }) },
      },
      threads: { get: async () => ({ data: { id: "thread-1", messages } }) },
    },
  });

  const evidence = await service.getThreadEvidence("message-1", 50);
  assert.equal(evidence.success, false);
  assert.equal(evidence.status, "incomplete_stop");
  assert.equal(evidence.pdf_count, 1);
  assert.equal(evidence.pdfs[0].status, "failed");
  assert.deepEqual(evidence.failures, ["pdf_extraction_complete"]);
});
