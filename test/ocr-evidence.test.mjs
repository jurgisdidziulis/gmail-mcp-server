import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scan} from './fixtures/scan.mjs';
import {readThreadEvidence} from '../dist/thread-evidence.js';
const available=await Promise.all([access('/usr/bin/tesseract'),access('/usr/share/tesseract-ocr/5/tessdata/eng.traineddata')]).then(()=>true,()=>false);
function setup(bytes=scan(),count=1,tamper=false){
 const attachments=Array.from({length:count},(_,i)=>({attachment_id:'a'+i,filename:'scan'+i+'.pdf',mime_type:'application/pdf',size:bytes.length}));
 const message={id:'m',threadId:'t',historyId:'h',attachments,labelIds:['INBOX'],body:'Unchanged body'};
 let reads=0;
 return {reads:()=>reads,service:{getEmail:async()=>message,getThread:async()=>({account:'info@example.test',provider:'gmail',threadId:'t',messages:[message],threadComplete:true,attachmentComplete:true,nextPageToken:null}),getDocumentAttachment:async({attachment})=>{
  reads++;
  return {bytes,source:{account:'info@example.test',message_id:'m',thread_id:'t',history_id:'h',attachment_id:attachment.attachment_id,source_part_path:'root.0',filename:attachment.filename,mime_type:attachment.mime_type,byte_size:bytes.length,sha256:tamper?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex')}};
 }}};
}
async function run(f,request=true){return readThreadEvidence(f.service,'info@example.test','m','gmail',50,{ocrReview:request});}
async function flags(fn){
 const old=[process.env.PDF_DOCUMENT_EVIDENCE_ENABLED,process.env.PDF_OCR_REVIEW_ENABLED];
 process.env.PDF_DOCUMENT_EVIDENCE_ENABLED='true';process.env.PDF_OCR_REVIEW_ENABLED='true';
 try{await fn();}finally{for(const [i,key] of ['PDF_DOCUMENT_EVIDENCE_ENABLED','PDF_OCR_REVIEW_ENABLED'].entries())if(old[i]===undefined)delete process.env[key];else process.env[key]=old[i];}
}
test('OCR evidence requires both explicit request and server activation',async()=>flags(async()=>{
 let r=await run(setup(),false);assert.equal('ocr_review' in r.pdfs[0],false);
 delete process.env.PDF_OCR_REVIEW_ENABLED;
 r=await run(setup());assert.equal('ocr_review' in r.pdfs[0],false);
 assert.equal(r.status,'incomplete_stop');
}));
test('actual scanned original returns nested review text without granting completeness',{skip:available?false:'Tesseract/model unavailable'},async()=>flags(async()=>{
 const f=setup(),r=await run(f),pdf=r.pdfs[0];
 assert.equal(f.reads(),1);assert.equal(r.success,false);assert.equal(r.status,'incomplete_stop');assert.equal(r.completeness.pdf_extraction_complete,false);
 assert.equal(pdf.status,'incomplete');assert.equal(pdf.error,'needs_ocr_or_visual_review');assert.equal('text' in pdf,false);assert.equal('pages' in pdf,false);
 assert.equal(pdf.ocr_review.status,'review_required',JSON.stringify(pdf));assert.equal(pdf.ocr_review.review_only,true);assert.equal(pdf.ocr_review.extraction_complete,false);
 assert.match(pdf.ocr_review.pages[0].text,/OFFICE INVOICE 12345/);assert.equal(pdf.ocr_review.source_sha256,pdf.source.sha256);assert.equal(r.messages[0].body,'Unchanged body');
}));
test('only one attachment per thread may enter OCR',{skip:available?false:'Tesseract/model unavailable'},async()=>flags(async()=>{
 const r=await run(setup(scan(),2));assert.equal(r.pdfs[0].ocr_review.status,'review_required');assert.equal(r.pdfs[1].ocr_review.reason,'ocr_thread_attempt_limit');assert.equal(r.success,false);
}));
test('bad source binding and document activation off cannot reach OCR',async()=>flags(async()=>{
 let r=await run(setup(scan(),1,true));assert.equal(r.pdfs[0].failure_code,'source_binding_rejected');assert.equal('ocr_review' in r.pdfs[0],false);
 delete process.env.PDF_DOCUMENT_EVIDENCE_ENABLED;const f=setup();r=await run(f);assert.equal(f.reads(),0);assert.equal('ocr_review' in r.pdfs[0],false);
}));
test('text, forms and annotation paths never invoke OCR',async()=>flags(async()=>{
 const fixtures=JSON.parse(await readFile(new URL('./fixtures/pdf-synthetic.json',import.meta.url)));
 for(const name of ['multi','note','form']){const r=await run(setup(Buffer.from(fixtures[name],'base64')));assert.equal('ocr_review' in r.pdfs[0],false);assert.equal(r.success,name==='multi');}
}));
test('provider cannot mutate original bytes while OCR evidence is in flight',{skip:available?false:'Tesseract/model unavailable'},async()=>flags(async()=>{
 const bytes=scan(),expected=createHash('sha256').update(bytes).digest('hex'),f=setup(bytes);
 const pending=run(f);const timer=setTimeout(()=>bytes.fill(0),20);
 try{const r=await pending;assert.equal(r.pdfs[0].ocr_review.status,'review_required',JSON.stringify(r));assert.equal(r.pdfs[0].source.sha256,expected);assert.equal(r.pdfs[0].ocr_review.source_sha256,expected);}finally{clearTimeout(timer);}
}));
