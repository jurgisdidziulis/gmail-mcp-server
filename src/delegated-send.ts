import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import PostalMime, { type Address } from 'postal-mime';

export const SEND_GRANT = 'jurgis-master-builder-mail-20260929-v1';
export const SEND_ACCOUNTS = ['admin@jurgisdid.com', 'me@jurgisdid.com', 'info@jurgisdid.com'];
export type SendBinding = { grant_id: string; account: string; draft_id: string; fingerprint: string; operation_id: string; task_id: string; expires_at: number };
export function verifySendProof(binding: SendBinding, proof: string, key: string, now = Date.now()) {
  if (process.env.MASTER_BUILDER_SEND_ENABLED !== 'true') throw new Error('SEND_DELEGATION_DISABLED');
  if (!key || binding.grant_id !== SEND_GRANT || !SEND_ACCOUNTS.includes(binding.account)) throw new Error('SEND_GRANT_INVALID');
  if (!Number.isSafeInteger(binding.expires_at) || binding.expires_at <= now || binding.expires_at > now + 300_000) throw new Error('SEND_APPROVAL_EXPIRED');
  for (const x of [binding.operation_id, binding.task_id, binding.draft_id]) if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(x)) throw new Error('SEND_BINDING_INVALID');
  if (!/^[a-f0-9]{64}$/.test(binding.fingerprint) || !/^[a-f0-9]{64}$/.test(proof)) throw new Error('SEND_PROOF_INVALID');
  const expected = createHmac('sha256', key).update(JSON.stringify(binding)).digest();
  if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) throw new Error('SEND_PROOF_INVALID');
}
export async function inspectSendRaw(account: string, draftId: string, raw: string, threadId = '') {
  if (!SEND_ACCOUNTS.includes(account)) throw new Error('SEND_ACCOUNT_DENIED');
  if (!raw || raw.length > 35_000_000 || !/^[A-Za-z0-9_-]+=*$/.test(raw)) throw new Error('SEND_RAW_INVALID');
  const bytes = Buffer.from(raw, 'base64url');
  const email = await PostalMime.parse(bytes);
  const addresses = (values: Address[] = []) => values.map(v => {
    if (!v.address || v.group || !/^[^\s<>@,;:\r\n]+@[^\s<>@,;:\r\n]+\.[^\s<>@,;:\r\n]+$/.test(v.address)) throw new Error('SEND_ADDRESS_INVALID');
    return v.address.toLowerCase();
  });
  const from = addresses(email.from ? [email.from] : []);
  if (from.length !== 1 || from[0] !== account) throw new Error('SEND_FROM_MISMATCH');
  if (email.sender && addresses([email.sender])[0] !== account) throw new Error('SEND_SENDER_MISMATCH');
  if (email.replyTo && addresses(email.replyTo).some(a => a !== account)) throw new Error('SEND_REPLY_TO_MISMATCH');
  for (const name of ['from','to','cc','bcc','sender','reply-to','subject','message-id']) {
    if (email.headers.filter(h => h.key === name).length > 1) throw new Error('SEND_DUPLICATE_HEADER');
  }
  if (email.headers.some(h => h.key.startsWith('resent-'))) throw new Error('SEND_RESENT_HEADER_DENIED');
  const to = addresses(email.to), cc = addresses(email.cc), bcc = addresses(email.bcc);
  if (to.length + cc.length + bcc.length < 1 || to.length + cc.length + bcc.length > 20) throw new Error('SEND_RECIPIENT_LIMIT');
  const fingerprint = createHash('sha256').update(JSON.stringify([account,draftId,threadId,createHash('sha256').update(bytes).digest('hex')])).digest('hex');
  return { account, draft_id: draftId, fingerprint, to, cc, bcc, subject: email.subject ?? '', attachment_count: email.attachments.length, thread_id: threadId, raw };
}
