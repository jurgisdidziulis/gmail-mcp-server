import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeImapMessageId,
  encodeImapMessageId,
  getHostingerImapConfig,
  ImapReadService,
  toImapSearch,
} from "../dist/imap-read-service.js";

test("Hostinger IMAP configuration is disabled unless explicitly enabled", () => {
  assert.equal(getHostingerImapConfig({}), null);
});

test("Hostinger IMAP configuration uses the fixed official TLS endpoint", () => {
  const config = getHostingerImapConfig({
    HOSTINGER_IMAP_ENABLED: "true",
    HOSTINGER_IMAP_ACCOUNT: "jurgis@in.lt",
    HOSTINGER_IMAP_PASSWORD: "secret-not-logged",
  });

  assert.deepEqual(config, {
    account: "jurgis@in.lt",
    password: "secret-not-logged",
    host: "imap.hostinger.com",
    port: 993,
    secure: true,
  });
});

test("Hostinger IMAP configuration fails closed when credentials are incomplete", () => {
  assert.throws(
    () =>
      getHostingerImapConfig({
        HOSTINGER_IMAP_ENABLED: "true",
        HOSTINGER_IMAP_ACCOUNT: "jurgis@in.lt",
      }),
    /HOSTINGER_IMAP_PASSWORD is required/
  );
});

test("Hostinger IMAP configuration rejects any account outside the approved mailbox", () => {
  assert.throws(
    () =>
      getHostingerImapConfig({
        HOSTINGER_IMAP_ENABLED: "true",
        HOSTINGER_IMAP_ACCOUNT: "other@example.com",
        HOSTINGER_IMAP_PASSWORD: "not-a-real-secret",
      }),
    /must be jurgis@in\.lt/
  );
});

test("Hostinger query translation supports only the bounded read-only subset", () => {
  const now = new Date("2026-07-26T05:00:00Z");
  assert.deepEqual(
    toImapSearch(
      'is:unread newer_than:7d from:client@example.com subject:"Project update"',
      now
    ),
    {
      seen: false,
      since: new Date("2026-07-19T05:00:00Z"),
      from: "client@example.com",
      subject: "Project update",
    }
  );
});

test("Hostinger query translation supports is:read", () => {
  assert.deepEqual(toImapSearch("is:read"), { seen: true });
});

test("Hostinger query translation rejects unsupported Gmail syntax", () => {
  assert.throws(
    () => toImapSearch("is:unread category:promotions"),
    /Unsupported Hostinger search token: category:promotions/
  );
});

test("Hostinger message IDs preserve UIDVALIDITY and reject malformed values", () => {
  const id = encodeImapMessageId("987654321", 42);
  assert.deepEqual(decodeImapMessageId(id), {
    mailbox: "INBOX",
    uidValidity: "987654321",
    uid: 42,
  });
  assert.throws(() => decodeImapMessageId("42"), /Invalid Hostinger message ID/);
});

test("Hostinger list opens INBOX read-only and returns metadata without message bodies", async () => {
  const calls = [];
  const client = {
    mailbox: undefined,
    async connect() {
      calls.push(["connect"]);
    },
    async mailboxOpen(path, options) {
      calls.push(["mailboxOpen", path, options]);
      this.mailbox = { uidValidity: 77n };
    },
    async search(query, options) {
      calls.push(["search", query, options]);
      return [11, 12];
    },
    async fetchAll(sequence, query, options) {
      calls.push(["fetchAll", sequence, query, options]);
      return [
        {
          uid: 12,
          envelope: {
            subject: "Project update",
            from: [{ name: "Client", address: "client@example.com" }],
            date: new Date("2026-07-25T10:00:00Z"),
          },
          flags: new Set(),
        },
      ];
    },
    async logout() {
      calls.push(["logout"]);
    },
  };
  let capturedConfig;
  const service = new ImapReadService(
    {
      account: "jurgis@in.lt",
      password: "never-log-this",
      host: "imap.hostinger.com",
      port: 993,
      secure: true,
    },
    {
      clientFactory(config) {
        capturedConfig = config;
        return client;
      },
    }
  );

  const results = await service.listEmails("is:unread newer_than:7d", 1);

  assert.equal(capturedConfig.host, "imap.hostinger.com");
  assert.equal(capturedConfig.port, 993);
  assert.equal(capturedConfig.secure, true);
  assert.equal(capturedConfig.auth.user, "jurgis@in.lt");
  assert.equal(capturedConfig.auth.pass, "never-log-this");
  assert.equal(capturedConfig.logger, false);
  assert.deepEqual(calls[1], ["mailboxOpen", "INBOX", { readOnly: true }]);
  assert.equal(calls[2][0], "search");
  assert.deepEqual(calls[2][2], { uid: true });
  assert.equal(calls[3][1], "12");
  assert.deepEqual(calls[3][2], {
    uid: true,
    envelope: true,
    flags: true,
    internalDate: true,
  });
  assert.deepEqual(calls[3][3], { uid: true });
  assert.deepEqual(results, [
    {
      id: encodeImapMessageId("77", 12),
      threadId: encodeImapMessageId("77", 12),
      subject: "Project update",
      from: "Client <client@example.com>",
      date: "2026-07-25T10:00:00.000Z",
      snippet: "",
      labelIds: [],
    },
  ]);
  assert.deepEqual(calls.at(-1), ["logout"]);
});

test("Hostinger list returns newest UIDs first regardless of IMAP fetch order", async () => {
  const client = {
    mailbox: undefined,
    async connect() {},
    async mailboxOpen() {
      this.mailbox = { uidValidity: 77n };
    },
    async search() {
      return [11, 12];
    },
    async fetchAll() {
      return [
        { uid: 11, envelope: { subject: "Older" }, flags: new Set() },
        { uid: 12, envelope: { subject: "Newer" }, flags: new Set() },
      ];
    },
    async logout() {},
  };
  const service = new ImapReadService(
    {
      account: "jurgis@in.lt",
      password: "never-log-this",
      host: "imap.hostinger.com",
      port: 993,
      secure: true,
    },
    { clientFactory: () => client }
  );

  const results = await service.listEmails("", 2);

  assert.deepEqual(results.map((message) => message.subject), ["Newer", "Older"]);
});

test("Hostinger authentication failures are sanitized", async () => {
  const service = new ImapReadService(
    {
      account: "jurgis@in.lt",
      password: "never-log-this",
      host: "imap.hostinger.com",
      port: 993,
      secure: true,
    },
    {
      clientFactory() {
        return {
          async connect() {
            throw new Error("Authentication failed for jurgis@in.lt using never-log-this");
          },
          async logout() {},
        };
      },
    }
  );

  await assert.rejects(
    () => service.listEmails("is:unread", 10),
    (error) => {
      assert.match(error.message, /Hostinger IMAP connection failed/);
      assert.doesNotMatch(error.message, /never-log-this|jurgis@in\.lt/);
      return true;
    }
  );
});

test("Hostinger get reads one message in read-only mode without changing Seen", async () => {
  const calls = [];
  const source = Buffer.from(
    [
      "From: Client <client@example.com>",
      "To: Jurgis <jurgis@in.lt>",
      "Subject: Project update",
      "Date: Sat, 25 Jul 2026 10:00:00 +0000",
      "Message-ID: <message@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello Jurgis",
    ].join("\r\n")
  );
  const client = {
    mailbox: undefined,
    async connect() {},
    async mailboxOpen(path, options) {
      calls.push(["mailboxOpen", path, options]);
      this.mailbox = { uidValidity: 77n };
    },
    async fetchOne(uid, query, options) {
      calls.push(["fetchOne", uid, query, options]);
      return {
        uid,
        source,
        flags: new Set(["\\Flagged"]),
        envelope: { date: new Date("2026-07-25T10:00:00Z") },
      };
    },
    async logout() {},
  };
  const service = new ImapReadService(
    {
      account: "jurgis@in.lt",
      password: "never-log-this",
      host: "imap.hostinger.com",
      port: 993,
      secure: true,
    },
    { clientFactory: () => client }
  );

  const result = await service.getEmail(encodeImapMessageId("77", 12));

  assert.deepEqual(calls[0], ["mailboxOpen", "INBOX", { readOnly: true }]);
  assert.deepEqual(calls[1], [
    "fetchOne",
    12,
    { uid: true, envelope: true, flags: true, internalDate: true, source: true },
    { uid: true },
  ]);
  assert.equal(result.id, encodeImapMessageId("77", 12));
  assert.equal(result.subject, "Project update");
  assert.equal(result.from, "Client <client@example.com>");
  assert.equal(result.to, "Jurgis <jurgis@in.lt>");
  assert.equal(result.body, "Hello Jurgis\n");
  assert.deepEqual(result.labelIds, ["\\Flagged"]);
  assert.equal(result.headers["Message-ID"], "<message@example.com>");
});

test("Hostinger connection check returns folder metadata only", async () => {
  const client = {
    mailbox: undefined,
    async connect() {},
    async mailboxOpen(path, options) {
      this.mailbox = {
        uidValidity: 77n,
        exists: 42,
        path,
        readOnly: options.readOnly,
      };
    },
    async logout() {},
  };
  const service = new ImapReadService(
    {
      account: "jurgis@in.lt",
      password: "never-log-this",
      host: "imap.hostinger.com",
      port: 993,
      secure: true,
    },
    { clientFactory: () => client }
  );

  assert.deepEqual(await service.checkConnection(), {
    account: "jurgis@in.lt",
    provider: "hostinger-imap",
    mailbox: "INBOX",
    read_only: true,
    messages: 42,
  });
});

test("Hostinger get rejects stale UIDVALIDITY before fetching", async () => {
  let fetched = false;
  const client = {
    mailbox: undefined,
    async connect() {},
    async mailboxOpen() {
      this.mailbox = { uidValidity: 88n };
    },
    async fetchOne() {
      fetched = true;
    },
    async logout() {},
  };
  const service = new ImapReadService(
    {
      account: "jurgis@in.lt",
      password: "never-log-this",
      host: "imap.hostinger.com",
      port: 993,
      secure: true,
    },
    { clientFactory: () => client }
  );

  await assert.rejects(
    () => service.getEmail(encodeImapMessageId("77", 12)),
    /Hostinger message ID is stale/
  );
  assert.equal(fetched, false);
});
