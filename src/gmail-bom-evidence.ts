import { decodeBodyBytes } from './body-charset.js';
import { legacyMimeParameters } from './mime-parameters.js';
// Reconcile observed Gmail body transformations against exact original bytes.
// The strict shadow parser stays unchanged. No size tolerance is admitted.
export function reconcileOriginalBom(payload: any, encodedRaw: string): any {
  let proofStage = 'input_contract';
  let mimeClass = 'unknown';
  let charsetClass = 'unknown';
  let transferClass = 'unknown';
  let lengthDeltaClass = 'unknown';
  const fail = (): never => {
    // Fixed stage codes are safe to retain in provider logs. Never include the
    // account, message/thread identity, headers, filenames or source bytes.
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'original_mime_proof_rejected',
      proof_stage: proofStage,
      mime_class: mimeClass,
      charset_class: charsetClass,
      transfer_class: transferClass,
      length_delta_class: lengthDeltaClass,
    }));
    throw new Error('Original MIME does not prove Gmail BOM normalization');
  };
  if (typeof encodedRaw !== 'string' || encodedRaw.length > 6_000_000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(encodedRaw)) fail();
  const raw = Buffer.from(encodedRaw, 'base64url');
  proofStage = 'raw_canonical';
  if (raw.length > 4 * 1024 * 1024 || raw.toString('base64url') !== encodedRaw.replace(/=+$/, '')) fail();
  let count = 0, repairs = 0;
  function walk(part: any, source: string, depth = 0, ancestorBlocked = false): any {
    proofStage = 'part_bounds';
    if (!part || depth > 20 || ++count > 300) fail();
    const split = source.indexOf('\r\n\r\n');
    proofStage = 'header_separator';
    if (split < 0 || split > 65536) fail();
    const headerText = source.slice(0, split);
    proofStage = 'header_newlines';
    if (/\r(?!\n)|(?<!\r)\n/.test(headerText)) fail();
    const lines = headerText.replace(/\r\n[ \t]+/g, ' ').split('\r\n');
    proofStage = 'header_count';
    if (lines.length > 200) fail();
    const headers = new Map<string, string>();
    for (const line of lines) {
      const m = /^([A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}):[ \t]*(.*)$/.exec(line);
      proofStage = 'header_shape';
      if (!m || m[2].length > 8192) fail();
      const name = m![1].toLowerCase();
      proofStage = 'duplicate_content_header';
      if (name.startsWith('content-') && headers.has(name)) fail();
      headers.set(name, m![2]);
    }
    const contentType = headers.get('content-type') ?? 'text/plain';
    const mime = contentType.split(';')[0].trim().toLowerCase();
    proofStage = 'mime_type_binding';
    if (mime !== String(part.mimeType).toLowerCase()) fail();
    const structured = new Map<string, string>();
    proofStage = 'structured_header_list';
    if (!Array.isArray(part.headers ?? [])) fail();
    for (const h of part.headers ?? []) {
      proofStage = 'structured_header_shape';
      if (typeof h?.name !== 'string' || typeof h.value !== 'string' || /[\r\n]/.test(h.name + h.value)) fail();
      const name = h.name.toLowerCase();
      if (['content-type', 'content-disposition'].includes(name)) {
        proofStage = 'structured_header_duplicate';
        if (structured.has(name)) fail();
        structured.set(name, h.value);
      }
    }
    const fenced = (type: string, disposition: string): boolean => {
      const parameters = legacyMimeParameters(type || 'text/plain');
      const dispositionParameters = disposition ? legacyMimeParameters(disposition) : new Map<string,string>();
      const token = disposition ? /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*(?:;|$)/.exec(disposition) : null;
      proofStage = 'disposition_token';
      if (disposition && !token) fail();
      return ['name','filename'].some(n => parameters.has(n) || dispositionParameters.has(n)) ||
        Boolean(token && token[1].toLowerCase() !== 'inline');
    };
    const rawFence = fenced(contentType, headers.get('content-disposition') ?? '');
    const structuredFence = Boolean(part.filename) || fenced(structured.get('content-type') ?? '', structured.get('content-disposition') ?? '');
    proofStage = 'attachment_fence_binding';
    if (rawFence !== structuredFence) fail();
    const blocked = ancestorBlocked || rawFence || structuredFence || mime === 'message/rfc822';
    if (blocked) return part; // Do not decode, hash or traverse attachment bytes.
    const body = source.slice(split + 4);
    const parts = part.parts ?? [];
    proofStage = 'part_list';
    if (!Array.isArray(parts)) fail();
    if (mime.startsWith('multipart/')) {
      const boundary = legacyMimeParameters(contentType).get('boundary');
      proofStage = 'multipart_membership';
      if (!parts.length) fail();
      if (!boundary || boundary.length > 70) fail();
      const delimiter = '--' + boundary;
      const rows = body.split('\r\n');
      const chunks: string[] = []; let open = false, closed = false, current: string[] = [];
      for (const row of rows) {
        if (row === delimiter || row === delimiter + '--') {
          proofStage = 'multipart_delimiter_order';
          if (closed) fail();
          if (open) chunks.push(current.join('\r\n'));
          current = []; open = row === delimiter; closed = !open;
        } else if (open) current.push(row);
      }
      proofStage = 'multipart_complete';
      if (!closed || chunks.length !== parts.length) fail();
      return { ...part, parts: parts.map((p: any, i: number) => walk(p, chunks[i], depth + 1, blocked)) };
    }
    if (parts.length || !['text/plain', 'text/html'].includes(mime)) return part;
    const data = part.body?.data;
    proofStage = 'provider_body_encoding';
    if (typeof data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) fail();
    const full = Buffer.from(data, 'base64url');
    proofStage = 'provider_body_canonical';
    if (full.toString('base64url') !== data.replace(/=+$/, '')) fail();
    if (full.length === part.body.size) return part;
    const structuredType = (part.headers ?? []).filter((h: any) => h.name?.toLowerCase() === 'content-type');
    proofStage = 'content_type_binding';
    if (structuredType.length !== 1 || structuredType[0].value.replace(/\s+/g, ' ').trim().toLowerCase() !== contentType.replace(/\s+/g, ' ').trim().toLowerCase()) fail();
    const charset = legacyMimeParameters(contentType).get('charset')?.toLowerCase();
    const transfer = headers.get('content-transfer-encoding')?.toLowerCase();
    mimeClass = mime === 'text/plain' ? 'text_plain' : mime === 'text/html' ? 'text_html' : 'other';
    charsetClass = charset === 'utf-8' || charset === 'utf8' ? 'utf8' :
      charset === 'iso-8859-1' ? 'iso8859_1' :
      ['windows-1250', 'windows-1252', 'windows-1257'].includes(charset ?? '') ? charset!.replace('-', '') :
      charset === 'ascii' || charset === 'us-ascii' ? 'ascii' : charset ? 'other' : 'missing';
    transferClass = transfer === 'base64' ? 'base64' : transfer === 'quoted-printable' ? 'quoted_printable' :
      transfer === '8bit' ? '8bit' : transfer ? 'other' : 'missing';
    const lengthDelta = full.length - Number(part.body.size);
    lengthDeltaClass = [-3, -2, -1, 1, 2, 3].includes(lengthDelta)
      ? (lengthDelta < 0 ? `minus_${Math.abs(lengthDelta)}` : `plus_${lengthDelta}`)
      : lengthDelta < 0 ? 'minus_other' : lengthDelta > 0 ? 'plus_other' : 'equal';
    if (['iso-8859-1', 'windows-1250', 'windows-1252', 'windows-1257'].includes(charset ?? '') &&
      (transfer === 'quoted-printable' || transfer === '8bit')) {
      // Provider compatibility mode: legacy QP preserves literal terminal SP/HT.
      // This is not RFC 2045 whitespace normalization. Accept only exact source
      // decoded length AND exact charset-transformed provider bytes below.
      // Require exact original bytes and exact declared-charset transformation.
      // No guessed size tolerance or fallback charset is permitted.
      let original: Buffer;
      if (transfer === 'quoted-printable') {
        proofStage = 'legacy_qp_source_shape';
        if (/[^\x09\x20-\x7e\r\n]/.test(body) || /\r(?!\n)|(?<!\r)\n/.test(body) ||
          /=(?![A-Fa-f0-9]{2}|\r\n)/.test(body) ||
          body.split('\r\n').some(line => line.length > 76)) fail();
        original = Buffer.from(body.replace(/=\r\n/g, '').replace(/=([A-Fa-f0-9]{2})/g,
          (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
      } else {
        proofStage = 'legacy_8bit_source_shape';
        if (/\x00|\r(?!\n)|(?<!\r)\n/.test(body) ||
          body.split('\r\n').some(line => line.length > 998)) fail();
        original = Buffer.from(body, 'latin1');
      }
      proofStage = 'legacy_source_binding';
      if (original.length !== part.body.size ||
        !Buffer.from(decodeBodyBytes(original, charset!), 'utf8').equals(full)) fail();
      repairs++;
      return { ...part, body: { ...part.body, data: original.toString('base64url') } };
    }
    proofStage = 'utf8_base64_contract';
    if (charset !== 'utf-8' || headers.get('content-transfer-encoding')?.toLowerCase() !== 'base64') fail();
    proofStage = 'utf8_base64_source_shape';
    if (!/^[A-Za-z0-9+/=\r\n]*$/.test(body)) fail();
    const canonical = body.replace(/[\r\n]/g, '');
    const original = Buffer.from(canonical, 'base64');
    proofStage = 'utf8_bom_binding';
    if (original.toString('base64') !== canonical || original.length !== part.body.size ||
      original.length !== full.length + 3 || !original.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ||
      !original.subarray(3).equals(full)) fail();
    repairs++;
    return { ...part, body: { ...part.body, size: full.length } };
  }
  const result = walk(payload, raw.toString('latin1'));
  proofStage = 'repair_required';
  if (!repairs) fail();
  return result;
}
