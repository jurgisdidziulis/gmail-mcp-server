import {pathToFileURL} from 'node:url';
// Starts the actual compiled Gmail server with synthetic credentials only.
// No token exchange or provider call is requested.
import {spawn} from 'node:child_process';import net from 'node:net';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(process.env.GMAIL_CANDIDATE_ROOT||path.join(import.meta.dirname,'..'));const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gmail-http-fixture-'));
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base=`http://127.0.0.1:${port}`;
const preload=path.join(dir,'pagination-failure-preload.mjs');
await fs.writeFile(preload, `import {google} from ${JSON.stringify(pathToFileURL(path.join(root,'node_modules/googleapis/build/src/index.js')).href)};
import {TokenStore} from ${JSON.stringify(pathToFileURL(path.join(root,'dist/token-store.js')).href)};
import {GmailService} from ${JSON.stringify(pathToFileURL(path.join(root,'dist/gmail-service.js')).href)};
google.auth.OAuth2.prototype.getAccessToken=async()=>({token:'fixture-access'});
TokenStore.prototype.listAccounts=()=>[{email:'admin@jurgisdid.com',addedAt:'2026-01-01'}];
TokenStore.prototype.getRefreshToken=()=> 'fixture-refresh';
GmailService.prototype.listEmails=async()=>{throw Error('FIXTURE_PROVIDER_READ_FAILED')};
GmailService.prototype.batchProcess=async()=>{throw Error('FIXTURE_PROVIDER_READ_FAILED')};
`);
const password='FIXTURE_ADMIN_HTTP_PASSWORD',backendKey='FIXTURE_BACKEND_KEY';let logs='';
const child=spawn(process.execPath,['--import',preload,'dist/index.js'],{cwd:root,env:{PATH:process.env.PATH,HOME:dir,PORT:String(port),SERVER_URL:base,DATA_DIR:dir,ENCRYPTION_KEY:'fixture-encryption-key',GOOGLE_CLIENT_ID:'fixture-client-id',GOOGLE_CLIENT_SECRET:'fixture-client-secret',ADMIN_PASSWORD:password,OFFICE_BACKEND_KEY_SHA256:createHash('sha256').update(backendKey).digest('hex')},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',x=>{logs+=x});child.stderr.on('data',x=>{logs+=x});
async function call(url,options={}){return fetch(base+url,{...options,redirect:'manual',signal:AbortSignal.timeout(3000)});}
try{
 let ready=false;for(let i=0;i<60;i++){try{const r=await call('/health');if(r.ok){ready=true;break;}}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,50));}
 assert.ok(ready,'Fixture server did not start');
 let r=await call('/setup');assert.equal(r.status,401);assert.ok((await r.text()).includes('method="POST"'));
 r=await call('/setup?key='+password);assert.equal(r.status,400);assert.ok(!(await r.text()).includes(password));
 r=await call('/admin/login',{method:'POST',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password})});assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/setup');const cookie=r.headers.get('set-cookie').split(';')[0];assert.ok(!cookie.includes(password));
 r=await call('/setup?message='+encodeURIComponent('<script>FIXTURE_XSS</script>'),{headers:{cookie}});assert.equal(r.status,200);let html=await r.text();assert.ok(html.includes('&lt;script&gt;FIXTURE_XSS&lt;/script&gt;'));assert.ok(!html.includes(password));assert.ok(!html.includes('?key='));
 r=await call('/setup/remove',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:'email=fixture%40example.invalid'});assert.equal(r.status,403);
 r=await call('/oauth/start',{headers:{cookie}});assert.equal(r.status,302);const oauth=new URL(r.headers.get('location'));const state=oauth.searchParams.get('state');assert.match(state,/^[a-f0-9]{64}$/);assert.ok(!oauth.href.includes(password));
 r=await call('/oauth/callback?state=forged&code=fixture',{headers:{cookie}});assert.equal(r.status,403);
 r=await call('/oauth/callback?state='+state+'&error=access_denied',{headers:{cookie}});assert.equal(r.status,302);assert.ok(!r.headers.get('location').includes(password));
 r=await call('/oauth/callback?state='+state+'&code=fixture',{headers:{cookie}});assert.equal(r.status,403);
 r=await call('/mcp',{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream','x-office-backend-key':'wrong'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});assert.equal(r.status,401);
 r=await call('/mcp',{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream','x-office-backend-key':backendKey},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});assert.equal(r.status,200);const inventory=await r.text();assert.ok(inventory.includes('get_admin_thread_shadow'));assert.ok(inventory.includes('get_email'));
 for(const name of ['list_emails','batch_process']){
 r=await call('/mcp',{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream','x-office-backend-key':backendKey},body:JSON.stringify({jsonrpc:'2.0',id:17,method:'tools/call',params:{name,arguments:{account:'admin@jurgisdid.com',query:'is:unread',max_results:1}}})});
 const body=await r.text();const frames=body.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim());const rpc=JSON.parse(frames.length?frames.join(''):body);assert.equal(rpc.result?.isError,true,name+' must return explicit tool error');assert.ok(JSON.stringify(rpc).includes('FIXTURE_PROVIDER_READ_FAILED'));assert.ok(!JSON.stringify(rpc).includes('pagination_complete'));
 }
 assert.ok(!logs.includes(password));assert.ok(!logs.includes('fixture-client-secret'));assert.ok(!logs.includes('TOKENS_DATA='));
 console.log(JSON.stringify({passed:true,scope:'Actual compiled Gmail HTTP setup/OAuth/MCP routes; synthetic credentials; no provider token exchange',checks:['list_emails provider failure is explicit MCP error','batch_process provider failure is explicit MCP error','unauthenticated POST login form','password URL rejection','secure opaque session','setup escaping','cross-origin mutation rejection','nonce-only OAuth redirect','invalid callback denial','OAuth error consumes state','callback replay denial','no credentials in server logs','backend wrong key rejected','authenticated existing and shadow MCP discovery preserved']}));
}finally{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await fs.rm(dir,{recursive:true,force:true});}
