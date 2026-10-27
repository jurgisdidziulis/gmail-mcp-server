import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access} from 'node:fs/promises';
import {createCanvas} from '@napi-rs/canvas';
import {reviewRasterOcr} from '../dist/pdf/ocr-review.js';

function image(text='OFFICE INVOICE 12345'){
 const canvas=createCanvas(1000,160),ctx=canvas.getContext('2d');
 ctx.fillStyle='white';ctx.fillRect(0,0,1000,160);
 ctx.fillStyle='black';ctx.font='bold 48px sans-serif';ctx.fillText(text,30,95);
 return canvas.toBuffer('image/png');
}
const input=(raster=image())=>({raster,original_sha256:'a'.repeat(64),page:1,page_count:1});
const engineAvailable=await Promise.all([
 access('/usr/bin/tesseract'),access('/usr/share/tesseract-ocr/5/tessdata/eng.traineddata'),
]).then(()=>true,()=>false);
const engineTest=(name,fn)=>test(name,{skip:engineAvailable?false:'requires local Tesseract and English model; no download performed'},fn);

engineTest('actual installed engine extracts a synthetic raster with engine/model and byte provenance',async()=>{
 const i=input(),r=await reviewRasterOcr(i);
 assert.equal(r.status,'review_required');assert.match(r.text,/OFFICE INVOICE 12345/);
 assert.equal(r.raster_sha256,createHash('sha256').update(i.raster).digest('hex'));
 assert.equal(r.text_sha256,createHash('sha256').update(r.text).digest('hex'));
 assert.match(r.engine.executable_sha256,/^[a-f0-9]{64}$/);assert.match(r.engine.model_sha256,/^[a-f0-9]{64}$/);
 assert.equal(r.review_only,true);assert.equal(r.completeness,false);assert.equal(r.original_binding_verified,false);assert.equal(r.confidence,null);
});
test('unsupported, truncated and oversized raster bytes stop before OCR',async()=>{
 for(const raster of [Buffer.alloc(0),Buffer.alloc(32),Buffer.alloc(2*1024*1024+1)])assert.equal((await reviewRasterOcr(input(raster))).reason,'ocr_raster_byte_limit');
 assert.equal((await reviewRasterOcr(input(Buffer.alloc(33)))).reason,'ocr_raster_format');
});
test('pixel bombs and invalid original/page declarations are rejected',async()=>{
 const huge=image();huge.writeUInt32BE(4096,16);huge.writeUInt32BE(4096,20);
 assert.equal((await reviewRasterOcr(input(huge))).reason,'ocr_raster_pixel_limit');
 for(const change of [{original_sha256:'caller says trusted'},{page:0},{page:2},{page_count:51},{page_count:1.5}])assert.equal((await reviewRasterOcr({...input(),...change})).reason,'ocr_source_declaration_invalid');
});
test('caller limits cannot disable time/output bounds',async()=>{
 for(const options of [{timeoutMs:0},{timeoutMs:10001},{maxText:0},{maxText:40001},{maxText:NaN}])assert.equal((await reviewRasterOcr(input(),options)).reason,'ocr_limits_invalid');
});
engineTest('concurrent request is held and exact engine text cannot exceed caller cap',async()=>{
 const first=reviewRasterOcr(input());
 assert.equal((await reviewRasterOcr(input())).reason,'ocr_busy');
 assert.equal((await first).status,'review_required');
 assert.equal((await reviewRasterOcr(input(),{maxText:8})).reason,'ocr_output_limit');
});
engineTest('blank or malformed image cannot become successful text',async()=>{
 const blank=createCanvas(100,100),ctx=blank.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,100,100);
 const r=await reviewRasterOcr(input(blank.toBuffer('image/png')));
 assert.equal(r.status,'incomplete_stop');assert.equal(r.reason,'ocr_no_text');
 const broken=image().subarray(0,33);const failed=await reviewRasterOcr(input(broken));
 assert.equal(failed.status,'incomplete_stop');assert.equal('text' in failed,false);
});
engineTest('caller cannot mutate in-flight raster or original/page declarations',async()=>{
 const i=input(),expected=createHash('sha256').update(i.raster).digest('hex');
 const result=reviewRasterOcr(i);
 i.raster.fill(0);i.original_sha256='b'.repeat(64);i.page=99;
 const r=await result;
 assert.equal(r.status,'review_required');assert.match(r.text,/OFFICE INVOICE 12345/);
 assert.equal(r.raster_sha256,expected);assert.equal(r.declared_original_sha256,'a'.repeat(64));assert.equal(r.page,1);
});
