import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertMailOperationAllowed,
  listConnectedMailAccounts,
  resolveMailAccounts,
  resolveSingleMailAccount,
} from "../dist/mail-account-routing.js";

const hostinger = {
  account: "jurgis@in.lt",
  password: "never-log-this",
  host: "imap.hostinger.com",
  port: 993,
  secure: true,
};
const gmailAccounts = [
  { email: "me@jurgisdid.com", addedAt: "2026-01-01T00:00:00Z" },
  { email: "admin@jurgisdid.com", addedAt: "2026-01-02T00:00:00Z" },
  { email: "info@jurgisdid.com", addedAt: "2026-01-03T00:00:00Z" },
];

test("connected account inventory preserves Gmail and identifies Hostinger read-only", () => {
  assert.deepEqual(listConnectedMailAccounts(gmailAccounts, hostinger), [
    ...gmailAccounts.map((account) => ({ ...account, provider: "gmail", read_only: false })),
    { email: "jurgis@in.lt", provider: "hostinger-imap", read_only: true },
  ]);
});

test("connected account inventory prefers Hostinger for a duplicate identity", () => {
  const duplicateAccounts = [
    ...gmailAccounts,
    { email: "JURGIS@IN.LT", addedAt: "2026-01-04T00:00:00Z" },
  ];
  const connected = listConnectedMailAccounts(duplicateAccounts, hostinger);
  assert.deepEqual(
    connected.filter((account) => account.email.toLowerCase() === "jurgis@in.lt"),
    [{ email: "jurgis@in.lt", provider: "hostinger-imap", read_only: true }]
  );
});

test("explicit Hostinger routing works but account all remains Gmail-only", () => {
  assert.deepEqual(resolveMailAccounts("jurgis@in.lt", gmailAccounts, hostinger), [
    "jurgis@in.lt",
  ]);
  assert.deepEqual(resolveMailAccounts("all", gmailAccounts, hostinger), [
    "me@jurgisdid.com",
    "admin@jurgisdid.com",
    "info@jurgisdid.com",
  ]);
});

test("account all excludes a duplicate Gmail token for the Hostinger identity", () => {
  const duplicateAccounts = [
    ...gmailAccounts,
    { email: "jurgis@in.lt", addedAt: "2026-01-04T00:00:00Z" },
  ];
  assert.deepEqual(resolveMailAccounts("all", duplicateAccounts, hostinger), [
    "me@jurgisdid.com",
    "admin@jurgisdid.com",
    "info@jurgisdid.com",
  ]);
});

test("single-account resolution rejects account all", () => {
  assert.throws(
    () => resolveSingleMailAccount("all", gmailAccounts, hostinger),
    /exact account/
  );
});

test("Hostinger mutating operations are blocked before IMAP access", () => {
  for (const operation of [
    "archive_email",
    "apply_label",
    "unsubscribe_email",
    "create_draft",
    "send_email",
  ]) {
    assert.throws(
      () => assertMailOperationAllowed("jurgis@in.lt", operation, hostinger),
      /read-only/
    );
  }
  assert.doesNotThrow(() =>
    assertMailOperationAllowed("jurgis@in.lt", "get_email", hostinger)
  );
});

test("disabled Hostinger configuration does not alter Gmail routing", () => {
  assert.deepEqual(listConnectedMailAccounts(gmailAccounts, null),
    gmailAccounts.map((account) => ({ ...account, provider: "gmail", read_only: false }))
  );
  assert.throws(
    () => resolveMailAccounts("jurgis@in.lt", gmailAccounts, null),
    /not connected/
  );
});
