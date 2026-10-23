import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ACCOUNTING_SECRETARY_MAIL_GRANT = "jurgis-accounting-secretary-mail-20261004-v1";
export const ACCOUNTING_SECRETARY_ACCOUNT = "admin@jurgisdid.com";
export const ACCOUNTING_SECRETARY_RECIPIENT = "admin@jurgisdid.com";
export const ACCOUNTING_SECRETARY_SUBJECT_PREFIX = "[ACCOUNTING→SECRETARY]";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,79}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/;

export interface AccountingSecretaryMailBinding {
  grant_id: string;
  operation_id: string;
  request_id: string;
  account: string;
  to: string;
  subject: string;
  body_sha256: string;
  expires_at: number;
}

export function verifyAccountingSecretaryMail(input: {
  binding: AccountingSecretaryMailBinding;
  proof: string;
  body: string;
  key: string;
  now?: number;
}): AccountingSecretaryMailBinding {
  const { binding, proof, body, key } = input;
  const now = input.now ?? Date.now();
  if (!key) throw new Error("ACCOUNTING_SECRETARY_MAIL_KEY_REQUIRED");
  if (binding.grant_id !== ACCOUNTING_SECRETARY_MAIL_GRANT) throw new Error("ACCOUNTING_SECRETARY_MAIL_AUTHORITY_DENIED");
  if (!REQUEST_ID.test(binding.request_id) || !OPERATION_ID.test(binding.operation_id)) throw new Error("ACCOUNTING_SECRETARY_MAIL_CORRELATION_INVALID");
  if (binding.account !== ACCOUNTING_SECRETARY_ACCOUNT || binding.to !== ACCOUNTING_SECRETARY_RECIPIENT) throw new Error("ACCOUNTING_SECRETARY_MAIL_ROUTE_DENIED");
  if (binding.subject !== `${ACCOUNTING_SECRETARY_SUBJECT_PREFIX} ${binding.request_id}`) throw new Error("ACCOUNTING_SECRETARY_MAIL_SUBJECT_DENIED");
  if (binding.body_sha256 !== createHash("sha256").update(body).digest("hex")) throw new Error("ACCOUNTING_SECRETARY_MAIL_BODY_MISMATCH");
  if (!Number.isSafeInteger(binding.expires_at) || binding.expires_at < now || binding.expires_at > now + 120_000) throw new Error("ACCOUNTING_SECRETARY_MAIL_EXPIRED");
  if (!/^[a-f0-9]{64}$/.test(proof)) throw new Error("ACCOUNTING_SECRETARY_MAIL_PROOF_INVALID");
  const expected = createHmac("sha256", key).update(JSON.stringify(binding)).digest();
  const supplied = Buffer.from(proof, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("ACCOUNTING_SECRETARY_MAIL_PROOF_INVALID");
  return binding;
}
