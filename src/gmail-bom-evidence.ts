// Reconcile only Gmail's observed removal of a leading UTF-8 BOM. The strict
// shadow parser stays unchanged. Original MIME bytes must prove every repair.
export function reconcileOriginalBom(payload: any, encodedRaw: string): any {
  const fail = () => { throw new Error('Original MIME does not prove Gmail BOM normalization'); };
  if (typeof encodedRaw !== 'string' || encodedRaw.length > 6_000_000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(encodedRaw)) fail();
  const raw = Buffer.from(encodedRaw, 'base64url');
  if (raw.length > 4 * 1024 * 1024 || raw.toString('base64url') !== encodedRaw.replace(/=+$/, '')) fail();
  let count = 0, repairs = 0;
  function walk(part: any, source: string, depth = 0, ancestorBlocked = false): any {
    if (!part || depth > 20 || ++count > 300) fail();
    const split = source.indexOf('\r\n\r\n');
    if (split < 0 || split > 65536) fail();
    const headerText = source.slice(0, split);
    if (/\r(?!\n)|(?<!\r)\n/.test(headerText)) fail();
    const lines = headerText.replace(/\r\n[ \t]+/g, ' ').split('\r\n');
    if (lines.length > 200) fail();
    const headers = new Map<string, string>();
    for (const line of lines) {
      const m = /^([A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}):[ \t]*(.*)$/.exec(line);
      if (!m || m[2].length > 8192) fail();
      const name = m![1].toLowerCase();
      if (name.startsWith('content-') && headers.has(name)) fail();
      headers.set(name, m![2]);
    }
    const contentType = headers.get('content-type') ?? 'text/plain';
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (mime !== String(part.mimeType).toLowerCase()) fail();
    const disposition = headers.get('content-disposition') ?? '';
    const blocked = ancestorBlocked || Boolean(part.filename) || mime === 'message/rfc822' ||
      /(?:^|;)\s*(?:name|filename)(?:\*[\d*]*)?\s*=/i.test(contentType + ';' + disposition) ||
      (Boolean(disposition) && !/^inline\s*(?:;|$)/i.test(disposition.trim()));
    if (blocked) return part; // Do not decode, hash or traverse attachment bytes.
    const body = source.slice(split + 4);
    const parts = part.parts ?? [];
    if (!Array.isArray(parts)) fail();
    if (mime.startsWith('multipart/')) {
      const matches = [...contentType.matchAll(/;\s*boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/gi)];
      if (matches.length !== 1 || !parts.length) fail();
      const boundary = matches[0][1] ?? matches[0][2];
      if (!boundary || boundary.length > 70) fail();
      const delimiter = '--' + boundary;
      const rows = body.split('\r\n');
      const chunks: string[] = []; let open = false, closed = false, current: string[] = [];
      for (const row of rows) {
        if (row === delimiter || row === delimiter + '--') {
          if (closed) fail();
          if (open) chunks.push(current.join('\r\n'));
          current = []; open = row === delimiter; closed = !open;
        } else if (open) current.push(row);
      }
      if (!closed || chunks.length !== parts.length) fail();
      return { ...part, parts: parts.map((p: any, i: number) => walk(p, chunks[i], depth + 1, blocked)) };
    }
    if (parts.length || !['text/plain', 'text/html'].includes(mime)) return part;
    const data = part.body?.data;
    if (typeof data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) fail();
    const full = Buffer.from(data, 'base64url');
    if (full.toString('base64url') !== data.replace(/=+$/, '')) fail();
    if (full.length === part.body.size) return part;
    const structuredType = (part.headers ?? []).filter((h: any) => h.name?.toLowerCase() === 'content-type');
    if (structuredType.length !== 1 || structuredType[0].value.replace(/\s+/g, ' ').trim().toLowerCase() !== contentType.replace(/\s+/g, ' ').trim().toLowerCase()) fail();
    if (!/;\s*charset\s*=\s*"?utf-8"?\s*(?:;|$)/i.test(contentType) || headers.get('content-transfer-encoding')?.toLowerCase() !== 'base64') fail();
    if (!/^[A-Za-z0-9+/=\r\n]*$/.test(body)) fail();
    const canonical = body.replace(/[\r\n]/g, '');
    const original = Buffer.from(canonical, 'base64');
    if (original.toString('base64') !== canonical || original.length !== part.body.size ||
      original.length !== full.length + 3 || !original.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ||
      !original.subarray(3).equals(full)) fail();
    repairs++;
    return { ...part, body: { ...part.body, size: full.length } };
  }
  const result = walk(payload, raw.toString('latin1'));
  if (!repairs) fail();
  return result;
}
