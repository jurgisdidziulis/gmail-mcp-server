// One explicit decoder for source reconciliation and final legacy text output.
export function decodeBodyBytes(bytes: Buffer, charset: string): string {
  const name = charset.toLowerCase().replace(/_/g, '-');
  if (name === 'utf-8' || name === 'utf8') return new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(bytes);
  if (name === 'ascii' || name === 'us-ascii') {
    if (bytes.some(b => b > 127)) throw new Error('Non-ASCII Gmail body bytes');
    return bytes.toString('ascii');
  }
  if (name === 'iso-8859-1') return bytes.toString('latin1');
  if (name === 'windows-1252' || name === 'windows-1250' || name === 'windows-1257') {
    const text = new TextDecoder(name, {fatal:true,ignoreBOM:true}).decode(bytes);
    if (/[\u0080-\u009f\ufffd]/.test(text)) throw new Error('Undefined Gmail body character');
    return text;
  }
  throw new Error('Unsupported Gmail body encoding');
}
