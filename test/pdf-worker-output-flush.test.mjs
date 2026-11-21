import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {createCanvas} from '@napi-rs/canvas';
import path from 'node:path';

// Real scanned content with a deterministic incompressible banner. It stays
// below existing worker limits while forcing stdout beyond pipe capacity.
function largeScan(){
 const width=1000,height=240,canvas=createCanvas(width,height),ctx=canvas.getContext('2d');
 ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.fillStyle='black';ctx.font='bold 48px sans-serif';ctx.fillText('OFFICE INVOICE 12345',30,95);
 const rgba=ctx.getImageData(0,0,width,height);let seed=123456789;
 for(let y=180;y<height;y++)for(let x=0;x<width;x++){
  const i=(y*width+x)*4;
  for(let c=0;c<3;c++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;rgba.data[i+c]=seed&255;}
 }
 ctx.putImageData(rgba,0,0);
 const rgb=Buffer.alloc(width*height*3);for(let i=0,j=0;i<rgba.data.length;i+=4){rgb[j++]=rgba.data[i];rgb[j++]=rgba.data[i+1];rgb[j++]=rgba.data[i+2];}
 const stream=(prefix,bytes)=>Buffer.concat([Buffer.from(prefix+` /Length ${bytes.length} >>\nstream\n`),bytes,Buffer.from('\nendstream')]);
 const image=deflateSync(rgb),content=Buffer.from('q 500 0 0 120 0 0 cm /Im0 Do Q');
 const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 120] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'),stream(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,image),stream('<<',content)];
 const chunks=[Buffer.from('%PDF-1.7\n')],offsets=[];let length=chunks[0].length;
 objects.forEach((obj,i)=>{offsets.push(length);const part=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);chunks.push(part);length+=part.length;});
 chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));return Buffer.concat(chunks);
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function render(bytes){
 const root=path.resolve(import.meta.dirname,'..'),worker=path.join(root,'dist/pdf/worker.js');
 return new Promise((resolve,reject)=>{
  const args=['--permission','--allow-fs-read='+path.join(root,'dist/pdf'),'--allow-fs-read='+path.join(root,'node_modules'),'--allow-addons','--max-old-space-size=128','--disable-proto=throw','--disallow-code-generation-from-strings',worker];
  const drop=process.platform==='linux'&&process.getuid?.()===0?{uid:65534,gid:65534}:{};
  const child=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe'],env:{NODE_ENV:'production',LANG:'C.UTF-8'},...drop});
  const chunks=[];let stderr='',readTimer;
  const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('worker timeout'));},10000);
  child.once('error',reject);child.stderr.on('data',b=>{stderr+=b});
  // Wait until output exists, then deliberately let pipe backpressure build.
  child.stdout.once('readable',()=>{readTimer=setTimeout(()=>{child.stdout.on('data',b=>chunks.push(Buffer.from(b)));child.stdout.resume();},150)});
  child.once('close',(code,signal)=>{clearTimeout(timeout);clearTimeout(readTimer);resolve({code,signal,stderr,output:Buffer.concat(chunks)});});
  child.stdin.end(JSON.stringify({data:bytes.toString('base64'),maxPages:3,maxText:40000,ocrReview:true}));
 });
}
test('actual raster worker flushes complete bounded large JSON under pipe backpressure',async t=>{
 const bytes=largeScan();assert.ok(bytes.length<8*1024*1024);
 const r=await render(bytes);assert.equal(r.code,0,r.stderr);assert.equal(r.signal,null);
 // A clean exit with partial JSON was the defect; no parser/bound relaxation.
 const result=JSON.parse(r.output.toString('utf8'));
 assert.equal(result.status,'rendered_for_review');assert.equal(result.review_only,true);assert.equal(result.source_sha256,sha(bytes));assert.equal(result.page_count,1);assert.equal(result.pages.length,1);
 const p=result.pages[0],png=Buffer.from(p.raster_base64,'base64');assert.ok(png.length>64*1024,`raster ${png.length} must exceed pipe capacity`);assert.ok(png.length<=2*1024*1024);assert.ok(r.output.length<9*1024*1024);assert.equal(png.toString('base64'),p.raster_base64);assert.equal(sha(png),p.raster_sha256);assert.equal(png.readUInt32BE(16),p.width);assert.equal(png.readUInt32BE(20),p.height);
 t.diagnostic(JSON.stringify({transport_bytes:r.output.length,png_bytes:png.length,raster_sha256:p.raster_sha256,source_sha256:result.source_sha256}));
});
