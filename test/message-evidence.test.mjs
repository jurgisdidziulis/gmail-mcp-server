import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {scan} from './fixtures/scan.mjs';
import {readMessageEvidence} from '../dist/thread-evidence.js';
import {GmailService,gmailReceivedAt} from '../dist/gmail-service.js';
const account='info@example.test',cutoff='2026-11-20T12:00:00.000Z',received='2026-11-20T12:00:01.000Z';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/pdf-synthetic.json',import.meta.url),'utf8'));
function fixture(inputBytes){
 const bytes=inputBytes??Buffer.from(fixtures.multi,'base64'),attachment={attachment_id:'a1',filename:'invoice.pdf',mime_type:'application/pdf',size:bytes.length};
 const message={id:'m1',threadId:'mixed-old-thread',historyId:'h1',received_at:received,date:'Forged sender date does not authorize receipt',attachments:[attachment],labelIds:['INBOX']};
 let emails=0,threads=0,downloads=0;
 const service={getEmail:async id=>{emails++;assert.equal(id,'m1');return structuredClone(message)},getThread:async()=>{threads++;throw Error('Must never read old thread')},getDocumentAttachment:async input=>{downloads++;assert.equal(input.expected_received_at,received);return{bytes,source:{provider_received_at:received,account,message_id:'m1',thread_id:message.threadId,history_id:'h1',attachment_id:'a1',source_part_path:'root.0',filename:attachment.filename,mime_type:attachment.mime_type,byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}}};
 return{message,service,counts:()=>({emails,threads,downloads})};
}
function enabled(){process.env.ACCOUNTING_MESSAGE_EVIDENCE_ENABLED='true';process.env.PDF_DOCUMENT_EVIDENCE_ENABLED='true'}
test('incoming single-message extraction proves original pages without old thread traversal',async()=>{
 enabled();const f=fixture();const r=await readMessageEvidence(f.service,account,'m1','gmail',cutoff);
 assert.equal(r.status,'complete');assert.equal(r.capability,'mail.message_evidence.read');assert.equal(r.evidence_scope,'message');assert.equal(r.provider_received_at,received);assert.equal(r.not_before,cutoff);assert.equal(r.messages.length,1);assert.equal(r.pdfs[0].page_count,2);assert.match(r.pdfs[0].pages[1].text,/Source page two/);assert.equal(r.pdfs[0].source.provider_received_at,received);assert.equal(r.completeness.thread_complete,false);assert.equal(r.completeness.reply_context_complete,false);assert.deepEqual(f.counts(),{emails:1,threads:0,downloads:1});
});
test('new operation requires literal activation before any source read',async()=>{delete process.env.ACCOUNTING_MESSAGE_EVIDENCE_ENABLED;const f=fixture();await assert.rejects(()=>readMessageEvidence(f.service,account,'m1','gmail',cutoff),/NOT_ACTIVATED/);assert.deepEqual(f.counts(),{emails:0,threads:0,downloads:0});});
test('old, missing or forged receipt, future receipt and nonincoming labels deny before attachment access',async()=>{
 enabled();for(const mutate of[m=>m.received_at='2026-11-19T12:00:00.000Z',m=>delete m.received_at,m=>m.received_at='not-a-date',m=>m.received_at='2099-01-01T00:00:00.000Z',m=>m.labelIds=['SENT','INBOX'],m=>m.labelIds=['DRAFT','INBOX'],m=>m.labelIds=['ARCHIVE'],m=>{m.received_at=null;m.date=received}]){const f=fixture();mutate(f.message);await assert.rejects(()=>readMessageEvidence(f.service,account,'m1','gmail',cutoff),/NOT_FORWARD_INCOMING/);assert.deepEqual(f.counts(),{emails:1,threads:0,downloads:0});}
});
test('invalid provider/cutoff/page bounds are denied without read',async()=>{enabled();for(const args of[['hostinger-imap',cutoff,50],['gmail','2026-11-20T12:00:00Z',50],['gmail','invalid',50],['gmail',cutoff,0],['gmail',cutoff,51],['gmail',cutoff,1.5]]){const f=fixture();await assert.rejects(()=>readMessageEvidence(f.service,account,'m1',...args),/BOUNDARY_INVALID/);assert.deepEqual(f.counts(),{emails:0,threads:0,downloads:0});}});
test('anchor substitution or incomplete metadata cannot reach extraction',async()=>{enabled();for(const mutate of[m=>m.id='other',m=>m.threadId='',m=>delete m.historyId,m=>delete m.attachments,m=>delete m.labelIds]){const f=fixture();mutate(f.message);await assert.rejects(()=>readMessageEvidence(f.service,account,'m1','gmail',cutoff),/IDENTITY_INVALID/);assert.equal(f.counts().downloads,0);}});
test('receipt timestamp/source conflict is held before extraction claim',async()=>{enabled();const f=fixture(),original=f.service.getDocumentAttachment;f.service.getDocumentAttachment=async input=>{const r=await original(input);r.source.provider_received_at=cutoff;return r};const r=await readMessageEvidence(f.service,account,'m1','gmail',cutoff);assert.equal(r.status,'incomplete_stop');assert.equal(r.pdfs[0].failure_code,'source_binding_rejected');});
test('Gmail timestamp comes solely from validated provider internalDate',async()=>{
 assert.equal(gmailReceivedAt(String(Date.parse(received))),received);for(const bad of[undefined,null,1,'','NaN','1.5','-1','99999999999999999'])assert.equal(gmailReceivedAt(bad),null);
 const service=new GmailService('synthetic-token');service.gmail={users:{messages:{get:async()=>({data:{id:'m1',threadId:'t1',historyId:'h1',internalDate:String(Date.parse(received)),payload:{mimeType:'text/plain',headers:[{name:'Date',value:'2099-01-01'}],body:{size:0,data:''}},labelIds:['INBOX']}})}}};
 const result=await service.getEmail('m1');assert.equal(result.received_at,received);assert.equal(result.date,'2099-01-01');
});
test('list summary uses provider receipt rather than sender Date',async()=>{const service=new GmailService('synthetic-token');service.gmail={users:{messages:{get:async()=>({data:{id:'m1',threadId:'t1',internalDate:String(Date.parse(received)),payload:{headers:[{name:'Date',value:'2099-01-01'}]},labelIds:['INBOX']}})}}};assert.equal((await service.getEmailSummary('m1')).received_at,received);});
test('original byte lane rereads provider receipt/incoming membership before and after download',async()=>{
 const bytes=Buffer.from('%PDF-synthetic-source');
 for(const mode of['good','old-before','old-after','sent-before','draft-after'])for(const lane of['document','attachment']){
  let reads=0,downloads=0;
  const service=new GmailService('synthetic-token',account,'fixture');
  service.gmail={users:{
   getProfile:async()=>({data:{emailAddress:account}}),
   messages:{
    get:async()=>{
     reads++;
     return{data:{
      id:'m1',threadId:'t1',historyId:'h1',
      internalDate:String(Date.parse(mode==='old-before'||mode==='old-after'&&reads>(lane==='attachment'?2:1)?cutoff:received)),
      labelIds:mode==='sent-before'?['INBOX','SENT']:mode==='draft-after'&&reads>(lane==='attachment'?2:1)?['INBOX','DRAFT']:['INBOX'],
      payload:{mimeType:'multipart/mixed',parts:[{filename:'invoice.pdf',mimeType:'application/pdf',body:{attachmentId:'a1',size:bytes.length}}]},
     }};
    },
    attachments:{get:async()=>{downloads++;return{data:{data:bytes.toString('base64url')}}}},
   },
  }};
  const call=()=>lane==='attachment'?service.getAttachment('m1','a1','invoice.pdf',received):service.getDocumentAttachment({messageId:'m1',threadId:'t1',historyId:'h1',expected_received_at:received,attachment:{attachment_id:'a1',filename:'invoice.pdf',mime_type:'application/pdf',size:bytes.length}});
  if(mode==='good'){const r=await call();assert.equal(lane==='attachment'?r.provider_received_at:r.source.provider_received_at,received);assert.equal(downloads,1)}else{await assert.rejects(call,/incoming source changed/);assert.equal(downloads,mode.endsWith('before')?0:1)}
 }
});

test('message OCR preserves exact source/receipt and review-only original provenance',{skip:!existsSync('/usr/bin/tesseract')||!existsSync('/usr/share/tesseract-ocr/5/tessdata/eng.traineddata')},async()=>{
 enabled();process.env.PDF_OCR_REVIEW_ENABLED='true';const f=fixture(scan());
 const r=await readMessageEvidence(f.service,account,'m1','gmail',cutoff,3,{ocrReview:true});
 assert.equal(r.success,false);assert.equal(r.status,'incomplete_stop');assert.equal(r.messages.length,1);assert.equal(r.completeness.thread_complete,false);assert.equal(r.pdfs[0].source.provider_received_at,received);assert.equal(r.pdfs[0].ocr_review.status,'review_required',JSON.stringify(r));assert.equal(r.pdfs[0].ocr_review.review_only,true);assert.equal(r.pdfs[0].ocr_review.extraction_complete,false);assert.equal(r.pdfs[0].ocr_review.source_sha256,r.pdfs[0].source.sha256);assert.match(r.pdfs[0].ocr_review.pages[0].text,/OFFICE INVOICE 12345/);assert.deepEqual(f.counts(),{emails:1,threads:0,downloads:1});
});
test('message OCR request above the incoming fifty-page cap is denied before source read',async()=>{enabled();const f=fixture();await assert.rejects(()=>readMessageEvidence(f.service,account,'m1','gmail',cutoff,51,{ocrReview:true}),/BOUNDARY_INVALID/);assert.equal(f.counts().emails,0);});
