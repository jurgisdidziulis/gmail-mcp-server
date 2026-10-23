import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=process.env.GMAIL_CANDIDATE_ROOT || path.resolve(import.meta.dirname,'..');
const {readThreadEvidence}=await import(pathToFileURL(path.join(root,'dist/thread-evidence.js')));
const account='admin@jurgisdid.com',message={id:'m1',threadId:'t1',labelIds:['UNREAD'],attachments:[]};
const page={account,provider:'gmail',threadId:'t1',messages:[message],nextPageToken:null,threadComplete:true,attachmentComplete:true};
let checks=0;
async function run(p=page,a=message){return readThreadEvidence({getEmail:async()=>a,getThread:async()=>structuredClone(p)},account,'m1','gmail');}
const good=await run();assert.equal(good.success,true);assert.equal(good.completeness.thread_complete,true);assert.equal(good.pdf_count,0);checks++;
const pdf=await run({...page,messages:[{...message,attachments:[{filename:'invoice.pdf',mime_type:'application/pdf'}]}]});assert.equal(pdf.success,false);assert.equal(pdf.status,'incomplete_stop');assert.equal(pdf.pdfs[0].status,'incomplete');assert.deepEqual(pdf.failures,['pdf_extraction_complete']);checks++;
for(const p of [{...page,account:'other'},{...page,provider:'other'},{...page,threadId:'other'},{...page,messages:[message,message]},{...page,messages:[{...message,id:'other'}]},{...page,threadComplete:false,nextPageToken:null},{...page,nextPageToken:'unexpected'},{...page,attachmentComplete:false},{...page,messages:[{...message,attachments:[{filename:'file'}]}]}]){await assert.rejects(()=>run(p));checks++;}
await assert.rejects(()=>run(page,{...message,id:'other'}));checks++;
let reads=0;const two=await readThreadEvidence({getEmail:async()=>message,getThread:async()=> ++reads===1?{...page,threadComplete:false,nextPageToken:'p2'}:{...page,messages:[{...message,id:'m2'}]}},account,'m1','gmail');assert.equal(two.message_count,2);assert.equal(reads,2);checks++;
console.log(JSON.stringify({passed:true,checks,real_provider_writes:0,pdf_content_downloads:0}));
