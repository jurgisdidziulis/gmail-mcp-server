// Legacy provider reader only. Strict shadow parsing retains its own contract.
export function legacyMimeParameters(value: string): Map<string, string> {
  const fail = (): never => { throw new Error('Legacy MIME: malformed or unsupported parameter syntax'); };
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail();
  let i = value.indexOf(';');
  const head = (i < 0 ? value : value.slice(0, i)).trim();
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~\/-]+$/.test(head)) fail();
  const out = new Map<string, string>();
  if (i < 0) return out;
  while (i < value.length) {
    if (value[i++] !== ';') fail();
    while (/[ \t]/.test(value[i] ?? '') && i < value.length) i++;
    const start = i;
    while (i < value.length && /[A-Za-z0-9!#$%&'*+.^_`|~-]/.test(value[i])) i++;
    const rawName = value.slice(start, i).toLowerCase();
    // Extended filename values are not interpreted; their presence only fences.
    const name = /^(name|filename)(?:\*|\*\d+\*?)$/.test(rawName) ? rawName.split('*')[0] : rawName;
    if (!name || name.includes('*') || out.has(name)) fail();
    while (i < value.length && /[ \t]/.test(value[i])) i++;
    if (value[i++] !== '=') fail();
    while (i < value.length && /[ \t]/.test(value[i])) i++;
    let result = '';
    if (value[i] === '"') {
      i++; let closed = false;
      while (i < value.length) {
        let c = value[i++];
        if (c === '"') { closed = true; break; }
        if (c === '\\') { if (i >= value.length) fail(); c = value[i++]; }
        if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) fail();
        result += c;
      }
      if (!closed) fail();
    } else {
      const begin = i;
      while (i < value.length && /[A-Za-z0-9!#$%&'*+.^_`|~-]/.test(value[i])) i++;
      result = value.slice(begin, i);
      if (!result) fail();
    }
    while (i < value.length && /[ \t]/.test(value[i])) i++;
    if (i < value.length && value[i] !== ';') fail();
    out.set(name, result);
  }
  return out;
}
