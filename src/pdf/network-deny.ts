// Fixed parser worker: no application network APIs or inherited credentials.
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const deny = () => { throw new Error('PDF_NETWORK_DENIED'); };
for (const [name, keys] of Object.entries({http:['request','get'],https:['request','get'],net:['connect','createConnection'],tls:['connect'],dgram:['createSocket'],dns:['lookup','resolve','resolve4','resolve6','resolveAny']})) {
  const module = require('node:' + name);
  for (const key of keys) module[key] = deny;
}
const promises = require('node:dns/promises'); for (const key of Object.keys(promises)) if (typeof promises[key] === 'function') promises[key] = deny;
require('node:http2').connect = deny;
const net = require('node:net'); net.Socket.prototype.connect = deny;
(globalThis as any).fetch = deny;
(globalThis as any).WebSocket = class { constructor() { deny(); } };
syncBuiltinESMExports();
