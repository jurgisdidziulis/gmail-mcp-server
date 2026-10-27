import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,access} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {createCanvas} from '@napi-rs/canvas';
import {reviewPdfOcr} from '../dist/pdf/ocr-pdf-review.js';
const available=await Promise.all([access('/usr/bin/tesseract'),access('/usr/share/tesseract-ocr/5/tessdata/eng.traineddata')]).then(()=>true,()=>false);
const actual=(name,fn)=>test(name,{skip:available?false:'local Tesseract/model unavailable; not downloaded'},fn);
function scan(pageCount=1,widthPoints=500){
 const width=1000,height=160,canvas=createCanvas(width,height),ctx=canvas.getContext('2d');
 ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.fillStyle='black';ctx.font='bold 48px sans-serif';ctx.fillText('OFFICE INVOICE 12345',30,95);
 const rgba=ctx.getImageData(0,0,width,height).data,rgb=Buffer.alloc(width*height*3);
 for(let i=0,j=0;i<rgba.length;i+=4){rgb[j++]=rgba[i];rgb[j++]=rgba[i+1];rgb[j++]=rgba[i+2];}
 const image=deflateSync(rgb),content=Buffer.from('q 500 0 0 80 0 0 cm /Im0 Do Q');
 const stream=(prefix,bytes)=>Buffer.concat([Buffer.from(prefix+` /Length ${bytes.length} >>\nstream\n`),bytes,Buffer.from('\nendstream')]);
 const imageId=3+pageCount,contentId=imageId+1;
 const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from(`<< /Type /Pages /Kids [${Array.from({length:pageCount},(_,i)=>`${3+i} 0 R`).join(' ')}] /Count ${pageCount} >>`),...Array.from({length:pageCount},()=>Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPoints} 80] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)),stream(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,image),stream('<<',content)];
 const chunks=[Buffer.from('%PDF-1.7\n')],offsets=[0];let length=chunks[0].length;
 objects.forEach((obj,i)=>{offsets.push(length);const part=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);chunks.push(part);length+=part.length;});
 chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
 return Buffer.concat(chunks);
}
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
