import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GmailService} from '../dist/gmail-service.js';
const account='fixture@example.test',received='2026-11-20T12:00:01.000Z',bytes=Buffer.from('%PDF-synthetic');
function fixture(change={}){
 const s=new GmailService('synthetic-token',account,'fixture');let reads=0,downloads=0;
 s.gmail={users:{getProfile:async()=>({data:{emailAddress:change.account??account}}),messages:{
  get:async()=>{const i=reads++;let part={filename:'fixture.pdf',mimeType:'application/pdf',body:{attachmentId:change.stable?'original':'rotated-'+i,size:bytes.length}};const parts=[part];if(change.duplicate)parts.push(structuredClone(part));if(change.conflict)parts.push({filename:'other.pdf',mimeType:'application/pdf',body:{attachmentId:'original',size:bytes.length}});if(change.move&&i>0)parts.unshift({mimeType:'text/plain',body:{size:0}});return{data:{id:'m1',threadId:'t1',historyId:change.history&&i>1?'changed':'h1',internalDate:String(Date.parse(change.receipt&&i>1?'2026-11-20T12:00:02.000Z':received)),labelIds:change.sent&&i>1?['INBOX','SENT']:['INBOX'],payload:{parts}}}},
  attachments:{get:async()=>{downloads++;return{data:{data:(change.truncate?bytes.subarray(1):bytes).toString('base64url')}}}}
 }}};
 return{s,counts:()=>({reads,downloads})};
}
for(const stable of [true,false])test('incoming original bytes retain exact source proof with '+(stable?'unchanged':'rotating')+' IDs',async()=>{
 const f=fixture({stable});const r=await f.s.getAttachment('m1','original','fixture.pdf',received);
 assert.equal(r.attachment_id,stable?'original':'rotated-1');assert.equal(r.source_part_path,'root.0');assert.equal(r.provider_received_at,received);assert.equal(r.bytes_base64,bytes.toString('base64'));assert.equal(r.sha256,createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(f.counts(),{reads:3,downloads:1});
});
for(const change of [{duplicate:true},{conflict:true},{move:true},{history:true},{receipt:true},{sent:true},{truncate:true},{account:'other@example.test'}])test('incoming rotation never bypasses '+JSON.stringify(change),async()=>{
 const f=fixture(change);await assert.rejects(()=>f.s.getAttachment('m1','original','fixture.pdf',received));
});
