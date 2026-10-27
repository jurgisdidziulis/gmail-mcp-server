import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,access} from 'node:fs/promises';
import {scan} from './fixtures/scan.mjs';
import {reviewPdfOcr} from '../dist/pdf/ocr-pdf-review.js';
const available=await Promise.all([access('/usr/bin/tesseract'),access('/usr/share/tesseract-ocr/5/tessdata/eng.traineddata')]).then(()=>true,()=>false);
const actual=(name,fn)=>test(name,{skip:available?false:'local Tesseract/model unavailable; not downloaded'},fn);
actual('actual scanned PDF renders and OCRs with original/page/engine provenance',async()=>{
 const bytes=scan(),r=await reviewPdfOcr(bytes);
 assert.equal(r.status,'review_required',JSON.stringify(r));assert.match(r.pages[0].text,/OFFICE INVOICE 12345/);
 assert.equal(r.source_sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(r.byte_size,bytes.length);
 assert.equal(r.page_count,1);assert.equal(r.pages.length,1);assert.equal(r.review_only,true);assert.equal(r.extraction_complete,false);
 assert.match(r.renderer.worker_sha256,/^[a-f0-9]{64}$/);assert.match(r.pages[0].engine.model_sha256,/^[a-f0-9]{64}$/);
});
actual('password, annotations, blank and malformed PDF holds cannot become accepted OCR',async()=>{
 const fixtures=JSON.parse(await readFile(new URL('./fixtures/pdf-synthetic.json',import.meta.url)));
 for(const [name,reason] of [['encrypted','password_required'],['note','annotations_or_forms_require_review'],['form','annotations_or_forms_require_review']]){
  const r=await reviewPdfOcr(Buffer.from(fixtures[name],'base64'));assert.equal(r.reason,reason,JSON.stringify(r));assert.equal('pages' in r,false);
 }
 assert.equal((await reviewPdfOcr(Buffer.from('not PDF'))).reason,'malformed_pdf');
 assert.equal((await reviewPdfOcr(Buffer.from(fixtures.blank,'base64'))).reason,'ocr_no_text');
});
actual('multi-page review is complete, ordered and remains unverified business evidence',async()=>{
 const r=await reviewPdfOcr(scan(2));
 assert.equal(r.status,'review_required',JSON.stringify(r));assert.equal(r.page_count,2);
 assert.deepEqual(r.pages.map(p=>p.page),[1,2]);
 for(const p of r.pages)assert.match(p.text,/OFFICE INVOICE 12345/);
 assert.equal(r.extraction_complete,false);
});
actual('oversized page render and excess pages stop without partial review',async()=>{
 const huge=await reviewPdfOcr(scan(1,6000));assert.equal(huge.reason,'ocr_raster_pixel_limit');assert.equal('pages' in huge,false);
 const many=await reviewPdfOcr(scan(4));assert.equal(many.reason,'page_limit');assert.equal('pages' in many,false);
});
actual('ordinary text PDFs do not become OCR candidates',async()=>{
 const fixtures=JSON.parse(await readFile(new URL('./fixtures/pdf-synthetic.json',import.meta.url)));
 assert.equal((await reviewPdfOcr(Buffer.from(fixtures.multi,'base64'))).reason,'ocr_not_needed');
});
test('OCR-specific page/input caps fail before extraction',async()=>{
 assert.equal((await reviewPdfOcr(Buffer.alloc(8*1024*1024+1))).reason,'byte_limit');
 for(const max of [0,4,NaN])assert.equal((await reviewPdfOcr(scan(),max)).reason,'ocr_page_limit');
});
