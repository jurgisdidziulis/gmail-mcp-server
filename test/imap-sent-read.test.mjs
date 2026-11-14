import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImapReadService,encodeImapMessageId,getHostingerImapConfig} from '../dist/imap-read-service.js';
import {resolveProviderSentMailbox,decodeSentMessageId} from '../dist/imap-sent-binding.js';
const config={account:'jurgis@in.lt',password:'synthetic-no-provider-password',host:'imap.hostinger.com',port:993,secure:true,sentReadEnabled:true};
const entry=(path='Provider chosen archive',flags=['\\Sent'])=>({path,flags:new Set(flags),listed:true});
const mime=Buffer.from('From: synthetic@example.test\r\nTo: receiver@example.test\r\nSubject: synthetic\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nsynthetic body\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="synthetic.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi1zeW50aGV0aWM=\r\n--b--\r\n');
function fixture({entries=[entry()],uids=[1,2],validity=77n,readonly=true,pathOverride,enabled=true}={}){
 const calls=[];let currentEntries=entries;
 const factory=()=>({mailbox:false,async connect(){calls.push(['connect']);},async list(){calls.push(['list']);return currentEntries;},async mailboxOpen(path,options){calls.push(['open',path,options]);this.mailbox={path:pathOverride??path,readOnly:readonly,uidValidity:validity,exists:uids.length};},async search(){calls.push(['search']);return uids;},async fetchAll(range){calls.push(['fetch',range]);return range.split(',').map(Number).map(uid=>({uid,envelope:{subject:'synthetic',date:new Date('2026-11-01T00:00:00Z')},flags:new Set(['\\Seen'])}));},async fetchOne(uid){calls.push(['one',uid]);return{uid,source:mime,flags:new Set(['\\Seen'])};},async logout(){calls.push(['logout']);}});
 return {calls,service:new ImapReadService({...config,...(enabled?{}:{sentReadEnabled:undefined})},{clientFactory:factory}),setEntries:v=>currentEntries=v};
}
async function replayRoot(fn){const p=await mkdtemp(join(tmpdir(),'sent-fake-replay-')),old=process.env.GMAIL_THREAD_TOKEN_REPLAY_DIR;process.env.GMAIL_THREAD_TOKEN_REPLAY_DIR=p;try{await fn();}finally{if(old===undefined)delete process.env.GMAIL_THREAD_TOKEN_REPLAY_DIR;else process.env.GMAIL_THREAD_TOKEN_REPLAY_DIR=old;await rm(p,{recursive:true,force:true});}}

test('Sent opt-in is literal and default-disabled before constructing or connecting a client',async()=>{
 const env={HOSTINGER_IMAP_ENABLED:'true',HOSTINGER_IMAP_ACCOUNT:config.account,HOSTINGER_IMAP_PASSWORD:config.password};
 for(const flag of [undefined,'TRUE','1',' true '])assert.equal(getHostingerImapConfig({...env,HOSTINGER_IMAP_SENT_READ_ENABLED:flag}).sentReadEnabled,undefined);
 assert.equal(getHostingerImapConfig({...env,HOSTINGER_IMAP_SENT_READ_ENABLED:'true'}).sentReadEnabled,true);
 const f=fixture({enabled:false});await assert.rejects(()=>f.service.listEmails('',1,undefined,'SENT'),/disabled/);assert.deepEqual(f.calls,[]);
 for(const role of ['Sent','arbitrary/path',null,'all'])await assert.rejects(()=>f.service.listEmails('',1,undefined,role),/mailbox role/);assert.deepEqual(f.calls,[]);
});
test('only one raw server-flagged selectable listed Sent folder is authoritative, never inferred names or specialUse',()=>{
 assert.equal(resolveProviderSentMailbox([entry()]).path,'Provider chosen archive');
 for(const entries of [[],[{...entry('Sent',[]),specialUse:'\\Sent'}],[entry(),entry('Other')],[entry(),entry()],[entry('INBOX')],[entry('P',['\\Sent','\\Noselect'])],[entry('P',['\\Sent','\\NonExistent'])],[{...entry(),listed:false}],[entry('bad\npath')],new Array(4097).fill(entry())])assert.throws(()=>resolveProviderSentMailbox(entries));
});
test('default INBOX retains exact legacy IDs, signed v2 token fields, no LIST, and read-only open',async()=>{
 const f=fixture(),p=await f.service.listEmails('',1);assert.equal(p.emails[0].id,encodeImapMessageId('77',2));assert.equal(f.calls.some(c=>c[0]==='list'),false);assert.deepEqual(f.calls.find(c=>c[0]==='open'),['open','INBOX',{readOnly:true}]);
 const token=JSON.parse(Buffer.from(p.nextPageToken,'base64url'));assert.equal(token.version,2);assert.equal(token.mailbox,'INBOX');assert.equal('folderBinding'in token,false);const{signature,...unsigned}=token;assert.equal(signature,createHmac('sha256',config.password).update(JSON.stringify(unsigned)).digest('base64url'));
});
test('Sent IDs and page tokens are signed, folder/account/role bound, bounded and contain no folder name',async()=>{
 const f=fixture(),p=await f.service.listEmails('',1,undefined,'SENT'),id=p.emails[0].id,t=JSON.parse(Buffer.from(p.nextPageToken,'base64url'));
 assert.notEqual(id,encodeImapMessageId('77',2));assert.equal(t.version,3);assert.equal(t.mailbox,'SENT');assert.match(t.folderBinding,/^[a-f0-9]{64}$/);assert.equal(Buffer.from(p.nextPageToken,'base64url').toString().includes('Provider chosen'),false);
 const accountBinding=createHash('sha256').update('hostinger-imap\0'+config.account).digest('hex');assert.equal(decodeSentMessageId(id,accountBinding,config.password).uid,2);
 assert.throws(()=>decodeSentMessageId(id,'a'.repeat(64),config.password));assert.throws(()=>decodeSentMessageId(id,accountBinding,'wrong'));assert.throws(()=>decodeSentMessageId(id+'=',accountBinding,config.password));
 const before=f.calls.length;await assert.rejects(()=>f.service.listEmails('',1,p.nextPageToken,'INBOX'),/Invalid Hostinger page token/);assert.equal(f.calls.length,before);
});
test('separate folder UID spaces and attachment HMACs remain different while legacy INBOX attachment binding is unchanged',async()=>{
 const f=fixture(),sent=(await f.service.listEmails('',1,undefined,'SENT')).emails[0].id;
 const a=await f.service.getEmail(encodeImapMessageId('77',2)),b=await f.service.getEmail(sent);assert.notEqual(a.id,b.id);assert.equal(a.attachments.length,1);assert.equal(b.attachments.length,1);assert.notEqual(a.attachments[0].attachment_id,b.attachments[0].attachment_id);
 const hash=createHash('sha256').update(Buffer.from('%PDF-synthetic')).digest('hex');assert.equal(a.attachments[0].attachment_id,'hostinger:'+createHmac('sha256',config.password).update(['hostinger-imap',config.account,'77','2','0',hash].join('\0')).digest('base64url'));
 for(const call of f.calls.filter(c=>c[0]==='open'))assert.deepEqual(call[2],{readOnly:true});
});
test('Sent folder rename, ambiguity and UIDVALIDITY changes fail before message fetch/search and never fall back',async()=>{
 for(const change of [[entry('Renamed')],[entry(),entry('Other')],[]]){
  const f=fixture(),p=await f.service.listEmails('',1,undefined,'SENT');f.setEntries(change);f.calls.length=0;
  await assert.rejects(()=>f.service.getEmail(p.emails[0].id));assert.equal(f.calls.some(c=>c[0]==='one'||c[0]==='search'),false);assert.equal(f.calls.some(c=>c[0]==='open'&&c[1]==='INBOX'),false);
  f.calls.length=0;await assert.rejects(()=>f.service.listEmails('',1,p.nextPageToken,'SENT'));assert.equal(f.calls.some(c=>c[0]==='fetch'||c[0]==='search'),false);
 }
 const f=fixture(),id=(await f.service.listEmails('',1,undefined,'SENT')).emails[0].id,g=fixture({validity:78n});await assert.rejects(()=>g.service.getEmail(id),/stale/);assert.equal(g.calls.some(c=>c[0]==='one'),false);
});
test('Sent requires actual opened exact folder and read-only state before any search or fetch',async()=>{
 for(const options of [{readonly:false},{pathOverride:'Different'}]){const f=fixture(options);await assert.rejects(()=>f.service.listEmails('',1,undefined,'SENT'));assert.equal(f.calls.some(c=>c[0]==='search'||c[0]==='fetch'),false);}
});
test('Sent pagination snapshots, terminal completeness and replay claims stay per signed folder/query',()=>replayRoot(async()=>{
 const uids=[1,2],f=fixture({uids}),first=await f.service.listEmails('',1,undefined,'SENT');assert.equal(first.paginationComplete,false);uids.push(3);const last=await f.service.listEmails('',1,first.nextPageToken,'SENT');assert.equal(last.paginationComplete,true);assert.equal(last.nextPageToken,null);assert.equal(last.emails.length,1);
 await assert.rejects(()=>f.service.listEmails('',1,first.nextPageToken,'SENT'),/replay rejected/);
 const other=fixture(),p=await other.service.listEmails('',1,undefined,'SENT');const before=other.calls.length;await assert.rejects(()=>other.service.listEmails('is:unread',1,p.nextPageToken,'SENT'),/query/);assert.equal(other.calls.length,before);
}));
test('metadata-only Sent connection observation gives only folder hash and never fetches messages',async()=>{
 const f=fixture(),r=await f.service.checkConnection('SENT');assert.equal(r.mailbox,'SENT');assert.equal(r.read_only,true);assert.match(r.folder_binding_sha256,/^[a-f0-9]{64}$/);assert.equal(f.calls.some(c=>['search','fetch','one'].includes(c[0])),false);assert.equal(JSON.stringify(r).includes('Provider chosen'),false);
});

test('Sent message and page signature aliases cannot bypass canonical wire validation',async()=>{
 const f=fixture(),p=await f.service.listEmails('',1,undefined,'SENT');
 const alias=value=>{const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';return value.slice(0,-1)+alphabet[alphabet.indexOf(value.at(-1))+1];};
 const raw=JSON.parse(Buffer.from(p.emails[0].id.slice(10),'base64url'));raw.signature=alias(raw.signature);const bad='imap-sent:'+Buffer.from(JSON.stringify(raw)).toString('base64url');
 const before=f.calls.length;await assert.rejects(()=>f.service.getEmail(bad),/Invalid Hostinger Sent message ID/);assert.equal(f.calls.length,before);
 const token=JSON.parse(Buffer.from(p.nextPageToken,'base64url'));token.signature=alias(token.signature);await assert.rejects(()=>f.service.listEmails('',1,Buffer.from(JSON.stringify(token)).toString('base64url'),'SENT'),/Invalid Hostinger page token/);assert.equal(f.calls.length,before);
});
