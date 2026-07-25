import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { createBackendAuth } from "../dist/backend-auth.js";

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function requestWithKey(key) {
  return {
    get(name) {
      return name.toLowerCase() === "x-office-backend-key" ? key : undefined;
    },
  };
}

const rawKey = "test-backend-key-with-sufficient-entropy";
const rawKeySha256 = "f43ff617c75a06978677c8c4ccaf279e2047c6655f26bcb82cfc4c0cfc9ed723";

test("backend auth rejects invalid digest configuration", () => {
  assert.throws(() => createBackendAuth(""), /64-character SHA-256 digest/);
  assert.throws(() => createBackendAuth("not-a-digest"), /64-character SHA-256 digest/);
});

test("backend auth denies missing and invalid credentials", () => {
  const middleware = createBackendAuth(rawKeySha256);

  for (const key of [undefined, "wrong-key"]) {
    const response = responseRecorder();
    let nextCalled = false;
    middleware(requestWithKey(key), response, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: "Unauthorized" });
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("backend auth permits the credential matching the configured digest", () => {
  const middleware = createBackendAuth(rawKeySha256);
  const response = responseRecorder();
  let nextCalled = false;
  middleware(requestWithKey(rawKey), response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(response.body, null);
});

test("production MCP does not register an external-send tool", async () => {
  const compiledServer = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(compiledServer, /server\.tool\(\s*["']send_email["']/);
});
