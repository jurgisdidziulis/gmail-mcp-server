import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import {ImapFlow} from 'imapflow';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('actual service SDK keeps fixed exact Hostinger role boundary, auth, metadata-only check and no writable operations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'imap-sent-sdk-')),key='synthetic-local-backend-key';
 const updates={PORT:'0',SERVER_URL:'http://127.0.0.1',DATA_DIR:root,TOKENS_DATA:'',GOOGLE_CLIENT_ID:'synthetic-client',GOOGLE_CLIENT_SECRET:'synthetic-secret',ENCRYPTION_KEY:'synthetic-encryption-key',ADMIN_PASSWORD:'synthetic-admin',OFFICE_BACKEND_KEY_SHA256:createHash('sha256').update(key).digest('hex'),HOSTINGER_IMAP_ENABLED:'true',HOSTINGER_IMAP_ACCOUNT:'jurgis@in.lt',HOSTINGER_IMAP_PASSWORD:'synthetic-imap-password',HOSTINGER_IMAP_SENT_READ_ENABLED:'true',PDF_LOCAL_OCR_REVIEW_ENABLED:'false'};
 const previous=Object.fromEntries(Object.keys(updates).map(k=>[k,process.env[k]]));Object.assign(process.env,updates);
 const originals=Object.fromEntries(['connect','list','mailboxOpen','search','fetchAll','logout'].map(k=>[k,ImapFlow.prototype[k]]));const calls=[];
 ImapFlow.prototype.connect=async function(){calls.push('connect');};
 ImapFlow.prototype.list=async function(){calls.push('list');return[{path:'Provider private destination',flags:new Set(['\\Sent']),listed:true}];};
 ImapFlow.prototype.mailboxOpen=async function(path,options){calls.push(['open',path,options]);this.mailbox={path,readOnly:true,uidValidity:77n,exists:1};};
 ImapFlow.prototype.search=async function(){calls.push('search');return[1];};
 ImapFlow.prototype.fetchAll=async function(){calls.push('fetch');return[{uid:1,envelope:{subject:'synthetic',date:new Date('2026-11-01T00:00:00Z')},flags:new Set()}];};
 ImapFlow.prototype.logout=async function(){calls.push('logout');};
 const listen=express.application.listen;let server;express.application.listen=function(_port,callback){server=listen.call(this,0,'127.0.0.1',callback);return server;};
 let client,wrong;const originalFetch=globalThis.fetch;
 try{
  await import('../dist/index.js');if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));const port=server.address().port;
  globalThis.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url;if(!url.startsWith(`http://127.0.0.1:${port}/`))throw Error('External provider denied in synthetic SDK test');return originalFetch(input,init);};
  const connect=async(secret)=>{const c=new Client({name:'synthetic-sent-sdk',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{'X-Office-Backend-Key':secret}},reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}}));return c;};
  client=await connect(key);const tools=(await client.listTools()).tools;assert.equal(tools.some(t=>t.name==='list_emails'),true);
  const before=calls.length;
  for(const args of [{account:'all',hostinger_mailbox_role:'SENT'},{account:'other@example.test',hostinger_mailbox_role:'SENT'},{account:'jurgis@in.lt',hostinger_mailbox_role:'arbitrary/path'},{account:'jurgis@in.lt',mailbox_path:'Provider private destination'}])assert.equal((await client.callTool({name:'list_emails',arguments:args})).isError,true);
  assert.equal(calls.length,before);
  const observed=JSON.parse((await client.callTool({name:'check_hostinger_connection',arguments:{account:'jurgis@in.lt',hostinger_mailbox_role:'SENT'}})).content[0].text);assert.equal(observed.mailbox,'SENT');assert.equal(observed.read_only,true);assert.equal(calls.includes('search'),false);assert.equal(calls.includes('fetch'),false);assert.doesNotMatch(JSON.stringify(observed),/Provider private/);
  const listed=JSON.parse((await client.callTool({name:'list_emails',arguments:{account:'jurgis@in.lt',hostinger_mailbox_role:'SENT',max_results:1}})).content[0].text);assert.equal(listed.results[0].emails[0].id.startsWith('imap-sent:'),true);assert.equal(listed.pagination_complete,true);
  const batch=JSON.parse((await client.callTool({name:'batch_process',arguments:{account:'jurgis@in.lt',hostinger_mailbox_role:'SENT',query:'',max_results:1}})).content[0].text);assert.match(batch.hint,/read-only/);assert.match(batch.results[0].emails[0].id,/^imap-sent:/);
  const inbox=JSON.parse((await client.callTool({name:'list_emails',arguments:{account:'jurgis@in.lt',max_results:1}})).content[0].text);assert.match(inbox.results[0].emails[0].id,/^imap:/);
  for(const c of calls.filter(c=>Array.isArray(c)))assert.deepEqual(c[2],{readOnly:true});
  const denied=await originalFetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'Content-Type':'application/json','X-Office-Backend-Key':'wrong'},body:'{}'});assert.equal(denied.status,401);
 }finally{
  try{await client?.close();}catch{}try{await wrong?.close();}catch{}globalThis.fetch=originalFetch;express.application.listen=listen;
  if(server)await new Promise(resolve=>server.close(resolve));for(const[k,v]of Object.entries(originals))ImapFlow.prototype[k]=v;
  for(const[k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;
  await rm(root,{recursive:true,force:true});
 }
});
