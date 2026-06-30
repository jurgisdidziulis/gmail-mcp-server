# Architect Notes

Running log of cross-cutting issues worth an architect's attention. Newest first.

---

## 2026-06-30 — Non-ASCII email headers mojibake (RECURRING)

**Status:** Fixed in code (this branch). Flagging because **this has regressed before** — it
should not keep coming back.

**Symptom:** Draft/sent **subject lines** with Lithuanian characters render as mojibake in mail
clients — e.g. `Nuoširdžiausias AČIŪ` → `NuoÅ¡irdÅ¾iausias AÄŒIÅª`, and `–` → `â€"`. Message
**bodies** were fine, which is what made this easy to miss in spot checks.

**Root cause:** `gmail-service.ts` built the raw RFC 2822 message by string-concatenating the
subject as raw UTF-8 (`Subject: ${options.subject}`). The body got away with it because it
carried `Content-Type: text/plain; charset="UTF-8"`, but **a header has no charset mechanism** —
non-ASCII header values must be wrapped as RFC 2047 encoded-words (`=?UTF-8?B?…?=`). Three call
sites shared the same hand-rolled builder (`createDraft`, `sendEmail`, `sendUnsubscribeMail`), so
the bug was duplicated.

**Fix:** Centralized message construction in `buildRawMessage()` with:
- `encodeHeaderValue()` — RFC 2047 Base64 encoded-word for any non-ASCII header value.
- `MIME-Version: 1.0` + `Content-Transfer-Encoding: base64` and a base64-encoded UTF-8 body.
- `getThreadingHeaders()` — see threading note below.

**Why it recurs / recommendation:** The raw-MIME assembly is hand-rolled and was copy-pasted
across three methods, so any new sender re-introduces the bug. To stop the cycle:
1. Keep **all** outgoing mail going through the single `buildRawMessage()` helper — never
   hand-assemble headers at a call site again.
2. Add a **regression test** asserting a Lithuanian subject produces a `=?UTF-8?B?…?=` header
   (there is currently no test suite — that absence is itself why this keeps slipping through).
3. Longer term, consider a vetted MIME builder (e.g. `nodemailer`'s composer / `mailcomposer`)
   instead of manual string concatenation.

---

## 2026-06-30 — Replies not threaded into the conversation

**Status:** Fixed in code (this branch).

**Symptom:** Draft replies created with a `thread_id` landed as standalone drafts rather than
nested into the original Gmail conversation.

**Root cause:** Setting `Draft.message.threadId` alone is **not sufficient**. Gmail nests a
message only when all of: (1) `threadId` set, (2) `Subject` matches the thread, and (3) the
`In-Reply-To` / `References` headers are present per RFC 2822. We only did (1) and (2).

**Fix:** `getThreadingHeaders()` fetches the thread's most recent message metadata
(`Message-ID`, `References`) and sets `In-Reply-To` + `References` on the outgoing message.
Best-effort: on any lookup failure it falls back to threadId-only association so a reply is never
blocked.

---

## Open gap — no `delete_draft` / `update_draft` tool

There is currently no MCP tool to delete or update an existing draft (only `create_draft`).
That means a draft created with a mistake can't be cleaned up programmatically — it has to be
removed by hand in Gmail. Worth adding alongside the `delete_email` item already in the README's
contributing list.
