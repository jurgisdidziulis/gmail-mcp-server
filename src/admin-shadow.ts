import { legacyMimeParameters } from './mime-parameters.js';
import { createHash } from 'node:crypto';

// Provider injection is wired only to existing authenticated Google clients.
// There is deliberately no generic RPC, URL, token or mailbox selector here.
export const ADMIN = 'admin@jurgisdid.com';
type Provider = {
  identity: () => Promise<{data: any}>;
  profile: () => Promise<{data: any}>;
  thread: (id: string) => Promise<{data: any}>;
};
const MAX_BYTES = 4 * 1024 * 1024;
function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error('Admin shadow: ' + message);
}
function id(s: any): string {
  requireThat(typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s), 'invalid ID');
  return s;
}
function canonical(x: any): string {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k)+':'+canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
export function digest(x: any): string {
  return createHash('sha256').update(canonical(x)).digest('hex');
}

// Preserve original body encoding and MIME metadata. Attachment data is neither
// decoded, hashed nor returned. Ancestor fences propagate through nested parts.
export function stripAttachments(root: any, legacyParameters = false): any {
  let count = 0, bytes = 0;
  function visit(p: any, depth = 0, fenced = false): any {
    requireThat(p && typeof p === 'object' && !Array.isArray(p) && depth <= 20 && ++count <= 300, 'MIME bound');
    requireThat(typeof p.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(p.mimeType), 'MIME type');
    const mime = p.mimeType.toLowerCase();
    const filename = p.filename ?? '';
    requireThat(typeof filename === 'string' && filename.length <= 1024, 'filename');
    const headers = p.headers ?? [];
    requireThat(Array.isArray(headers) && headers.length <= 200, 'headers');
    let blocked = fenced || filename !== '' || mime === 'message/rfc822';
    const structuralHeaders = new Set<string>();
    const safeHeaders = headers.map((h: any) => {
      requireThat(typeof h?.name === 'string' && typeof h.value === 'string' && h.name.length <= 128 && h.value.length <= 8192 && !/[\r\n]/.test(h.name+h.value), 'header shape');
      if (/^content-(type|disposition)$/i.test(h.name)) {
        const key = h.name.toLowerCase();
        requireThat(!structuralHeaders.has(key), 'duplicate MIME structural header');
        structuralHeaders.add(key);
        // Comments and malformed tokens are ambiguous; never decode through them.
        if (legacyParameters) {
          const parameters = legacyMimeParameters(h.value);
          blocked ||= parameters.has('name') || parameters.has('filename');
        } else requireThat(!/[()]/.test(h.value), 'ambiguous MIME comment');
        blocked ||= /(?:^|;)\s*(?:name|filename)(?:\*[\d*]*)?\s*=/i.test(h.value);
        if (key === 'content-disposition') {
          const token = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*(?:;|$)/.exec(h.value);
          requireThat(token, 'ambiguous disposition token');
          blocked ||= token[1].toLowerCase() !== 'inline';
        } else {
          const token = /^\s*([\w.+-]+\/[\w.+-]+)\s*(?:;|$)/.exec(h.value);
          requireThat(token && token[1].toLowerCase() === mime, 'conflicting MIME type header');
        }
      }
      bytes += Buffer.byteLength(h.name+h.value);
      return {name:h.name,value:h.value};
    });
    const parts = p.parts ?? [];
    requireThat(Array.isArray(parts), 'parts');
    blocked ||= !parts.length && mime !== 'text/plain' && mime !== 'text/html';
    requireThat(!mime.startsWith('multipart/') || parts.length > 0, 'empty multipart');
    requireThat(parts.length === 0 || mime.startsWith('multipart/') || blocked, 'unexpected children');
    const body = p.body ?? {};
    requireThat(body && typeof body === 'object' && Number.isSafeInteger(body.size) && body.size >= 0, 'body size');
    const outBody: any = {size:body.size};
    if (body.attachmentId !== undefined) {
      requireThat(typeof body.attachmentId === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(body.attachmentId), 'attachment ID metadata');
      outBody.attachmentId = body.attachmentId;
    }
    if (!blocked && !parts.length) {
      requireThat(!body.attachmentId, 'body requires attachment fetch');
      const data = body.data ?? '';
      requireThat(typeof data === 'string' && data.length <= 1400000 && /^[A-Za-z0-9_-]*={0,2}$/.test(data), 'inline body encoding/bound');
      // Body bytes remain encoded here; strict_mime performs bounded decoding.
      const decoded = Buffer.from(data, 'base64url');
      requireThat(decoded.length === body.size && decoded.toString('base64url') === data.replace(/=+$/, ''), 'incomplete/noncanonical body');
      bytes += decoded.length;
      outBody.data = data;
    }
    requireThat(bytes <= MAX_BYTES, 'thread evidence size');
    return {mimeType:p.mimeType,filename,headers:safeHeaders,body:outBody,
      ...(parts.length ? {parts:parts.map((c:any)=>visit(c,depth+1,blocked))}: {})};
  }
  return visit(root);
}

export async function readAdminThreadShadow(provider: Provider, account: string,
  threadId: string, now: () => number = () => Date.now()/1000) {
  requireThat(account === ADMIN, 'admin account only; aliases forbidden');
  id(threadId);
  let calls = 0;
  async function read() {
    const observed = now();
    const identity = (await provider.identity()).data; calls++;
    requireThat(identity?.email === ADMIN && identity.verified_email === true, 'OAuth email identity');
    const subject = id(identity.id);
    const profile = (await provider.profile()).data; calls++;
    requireThat(profile?.emailAddress === ADMIN && typeof profile.historyId === 'string', 'Gmail account proof');
    const raw = (await provider.thread(threadId)).data; calls++;
    requireThat(raw?.id === threadId && typeof raw.historyId === 'string' && Array.isArray(raw.messages) && raw.messages.length > 0 && raw.messages.length <= 100, 'complete bounded thread');
    requireThat(!raw.nextPageToken && raw.truncated !== true, 'partial response');
    const seen = new Set<string>();
    const messages = raw.messages.map((m:any) => {
      id(m.id); requireThat(!seen.has(m.id) && m.threadId === threadId && typeof m.historyId === 'string', 'message identity/history'); seen.add(m.id);
      requireThat(Array.isArray(m.labelIds) && m.labelIds.length <= 100 && m.labelIds.every((s:any)=>typeof s==='string' && s.length<=256), 'labels');
      return {id:m.id,threadId:m.threadId,historyId:m.historyId,labelIds:m.labelIds,
        payload:stripAttachments(m.payload)};
    });
    const snapshot = {account:ADMIN,thread_id:threadId,thread_complete:true,
      attachment_complete:true,pagination_complete:true,next_page_token:null,messages};
    requireThat(Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_BYTES, 'aggregate thread bound');
    return {observed,subject,thread_history:raw.historyId,snapshot};
  }
  const first = await read();
  const second = await read();
  const completed = now();
  requireThat([first.observed,second.observed,completed].every(Number.isFinite) && first.observed<=second.observed && second.observed<=completed && completed-first.observed<=300, 'observation expiry/order');
  requireThat(first.subject === second.subject && first.thread_history === second.thread_history && digest(first.snapshot) === digest(second.snapshot), 'source changed between independent reads');
  return {schema:'office.admin-shadow.v1',account:ADMIN,provider:'gmail',
    oauth_subject:first.subject,first_observed:first.observed,second_observed:second.observed,
    expires_at:first.observed+300,first:first.snapshot,second:second.snapshot,
    thread_sha256:digest(second.snapshot),provider_calls:calls,attachment_downloads:0,
    attachment_bytes_retained:0,business_effects:0,mode:'shadow_only'};
}
