import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RESULT_ACCOUNT = "admin@jurgisdid.com";
export const RESULT_RECIPIENT = "yu193e@mail.instinct.com";
export const RESULT_SUBJECT_PREFIX = "[INSTINCT-ACCOUNTANT]";
export const RESULT_ATTACHMENT_FILENAME = "revolut-transactions-2026.csv";
export const RESULT_ATTACHMENT_MIME_TYPE = "text/csv";
export const RESULT_ATTACHMENT_BYTES = 748361;
export const RESULT_ATTACHMENT_SHA256 = "68d65925362ce285aa921f573807111bf41137d33486acfad5b9a62188f06e23";
export const WINDOW_ATTACHMENT_FILENAME = "revolut-transactions-2026-10-04_to_2026-10-14.csv";
export const WINDOW_ATTACHMENT_BYTES = 3579;
export const WINDOW_ATTACHMENT_SHA256 = "0516df1074b6c6b1401aa1f43bcc9db820d9a7b9195ed5dc8f44a5b0585b59bc";
const ATTACHMENT_MANIFESTS = [
  { capability: "mail.instinct_accountant_result.send", operation: "instinct_accountant_result_mail_v1", task_id: "t_4bd3fcb2", request_id: null, subject: null, thread_id: null, reply_message_id: null, filename: RESULT_ATTACHMENT_FILENAME, mime_type: RESULT_ATTACHMENT_MIME_TYPE, bytes: RESULT_ATTACHMENT_BYTES, sha256: RESULT_ATTACHMENT_SHA256 },
  { capability: "mail.instinct_accountant_result.send", operation: "instinct_revolut_window_mail_v1", task_id: "t_613d8bb0", request_id: "email-delivery-20261014-019", subject: "Re: [INSTINCT-ACCOUNTANT-REQUEST] email-delivery-20261014-019", thread_id: "1a13947756830e66", reply_message_id: "1a13947756830e66", filename: WINDOW_ATTACHMENT_FILENAME, mime_type: RESULT_ATTACHMENT_MIME_TYPE, bytes: WINDOW_ATTACHMENT_BYTES, sha256: WINDOW_ATTACHMENT_SHA256 },
] as const;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,79}$/;
const DELIVERY_ID = /^[a-f0-9]{32}$/;
const SENSITIVE = /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]|\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b|\b(?:\d[ -]*?){13,19}\b)/i;
const PROHIBITED_EFFECT = /(?:^|\n)\s*(?:(?:I|we|the accountant)\s+(?:have\s+)?(?:paid|transferred|moved\s+funds|sent\s+funds|granted|revoked|deleted|destroyed|posted\s+(?:a\s+)?(?:ledger|journal)|wrote\s+(?:to\s+)?(?:the\s+)?ledger)|(?:please\s+)?(?:move|send|transfer|pay|purchase|grant|revoke|delete|destroy|post|write)\b.{0,40}\b(?:money|funds|payment|permission|access|credential|password|token|ledger|entry|account))/im;

export interface ResultMailBinding {
  grant_id: string;
  capability: string;
  operation: string;
  task_id: string;
  operation_id: string;
  request_id: string;
  delivery_id: string;
  account: string;
  to: string;
  subject: string;
  thread_id: string | null;
  reply_message_id: string | null;
  body_sha256: string;
  attachment_filename: string;
  attachment_mime_type: string;
  attachment_bytes: number;
  attachment_sha256: string;
  expires_at: number;
}

export function verifyResultMailRequest(input: {
  binding: ResultMailBinding;
  proof: string;
  body: string;
  attachment: { filename: string; mime_type: string; content_base64: string };
  key: string;
  now?: number;
}): ResultMailBinding {
  const { binding, proof, body, attachment, key } = input;
  const now = input.now ?? Date.now();
  if (!key) throw new Error("RESULT_MAIL_KEY_REQUIRED");
  if (!binding || typeof binding !== "object") throw new Error("RESULT_MAIL_BINDING_INVALID");
  if (binding.grant_id !== "jurgis-master-builder-mail-20260929-v1" || binding.capability !== "mail.instinct_accountant_result.send") throw new Error("RESULT_MAIL_AUTHORITY_DENIED");
  const manifest = ATTACHMENT_MANIFESTS.find((item) => item.capability === binding.capability && item.operation === binding.operation && item.task_id === binding.task_id);
  if (!manifest) throw new Error("RESULT_MAIL_MANIFEST_DENIED");
  if (!REQUEST_ID.test(binding.request_id) || !DELIVERY_ID.test(binding.delivery_id)) throw new Error("RESULT_MAIL_CORRELATION_INVALID");
  if (binding.operation_id !== `instinct-accountant-mail-${binding.delivery_id}`) throw new Error("RESULT_MAIL_OPERATION_INVALID");
  const expectedSubject = manifest.subject ?? `${RESULT_SUBJECT_PREFIX} ${binding.request_id}`;
  if (binding.account !== RESULT_ACCOUNT || binding.to !== RESULT_RECIPIENT || binding.subject !== expectedSubject) throw new Error("RESULT_MAIL_FIXED_ENVELOPE_REQUIRED");
  if (manifest.request_id !== null && binding.request_id !== manifest.request_id) throw new Error("RESULT_MAIL_REQUEST_DENIED");
  if (binding.thread_id !== manifest.thread_id || binding.reply_message_id !== manifest.reply_message_id) throw new Error("RESULT_MAIL_THREAD_DENIED");
  if (!Number.isSafeInteger(binding.expires_at) || binding.expires_at < now || binding.expires_at > now + 120_000) throw new Error("RESULT_MAIL_PROOF_EXPIRED");
  if (typeof body !== "string" || body.length < 1 || body.length > 16_000 || !body.includes(`request_id: ${binding.request_id}`) || !body.includes(`delivery_id: ${binding.delivery_id}`)) throw new Error("RESULT_MAIL_BODY_INVALID");
  if (SENSITIVE.test(body)) throw new Error("RESULT_MAIL_SENSITIVE_CONTENT_DENIED");
  if (PROHIBITED_EFFECT.test(body)) throw new Error("RESULT_MAIL_OPERATION_INSTRUCTION_DENIED");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  if (binding.body_sha256 !== bodyHash) throw new Error("RESULT_MAIL_BODY_HASH_MISMATCH");
  if (binding.attachment_filename !== manifest.filename || binding.attachment_mime_type !== manifest.mime_type || binding.attachment_bytes !== manifest.bytes || binding.attachment_sha256 !== manifest.sha256) throw new Error("RESULT_MAIL_ATTACHMENT_BINDING_DENIED");
  if (!attachment || attachment.filename !== manifest.filename || attachment.mime_type !== manifest.mime_type || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.content_base64)) throw new Error("RESULT_MAIL_ATTACHMENT_INVALID");
  const attachmentBytes = Buffer.from(attachment.content_base64, "base64");
  if (attachmentBytes.toString("base64") !== attachment.content_base64 || attachmentBytes.length !== manifest.bytes || createHash("sha256").update(attachmentBytes).digest("hex") !== manifest.sha256) throw new Error("RESULT_MAIL_ATTACHMENT_HASH_MISMATCH");
  const expected = createHmac("sha256", key).update(JSON.stringify(binding)).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(proof)) throw new Error("RESULT_MAIL_PROOF_INVALID");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(proof, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("RESULT_MAIL_PROOF_INVALID");
  return binding;
}
