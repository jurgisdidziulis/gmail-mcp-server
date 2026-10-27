import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractOriginalPdf} from './extract.js';
import {reviewRasterOcr} from './ocr-review.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const worker=resolve(root,'dist/pdf/worker.js');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const keys=(value:any)=>Object.keys(value).sort().join(',');
const held=(reason:string)=>({status:'incomplete_stop',reason,review_only:true,extraction_complete:false});
let active=false;

async function render(bytes:Buffer,maxPages:number,timeout:number):Promise<any>{
 return await new Promise(resolveResult=>{
  const args=['--permission','--allow-fs-read='+resolve(root,'dist/pdf'),'--allow-fs-read='+resolve(root,'node_modules'),'--allow-addons','--max-old-space-size=128','--disable-proto=throw','--disallow-code-generation-from-strings',worker];
  const drop=process.platform==='linux'&&process.getuid?.()===0?{uid:65534,gid:65534}:{};
  const child=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe'],env:{NODE_ENV:'production',LANG:'C.UTF-8'},...drop});
  const chunks:Buffer[]=[];let outputBytes=0,diagnostics='',done=false;
  const finish=(result:any)=>{
   if(done)return;done=true;clearTimeout(timer);clearInterval(monitor);
   if(!child.pid||child.exitCode!==null||child.signalCode!==null)resolveResult(result);
   else{child.once('close',()=>resolveResult(result));child.kill('SIGKILL');}
  };
  const timer=setTimeout(()=>finish(held('ocr_render_timeout')),timeout);
  const monitor=setInterval(()=>{
   if(process.platform!=='linux'||!child.pid)return;
   void readFile('/proc/'+child.pid+'/status','utf8').then(s=>{
    const rss=/^VmRSS:\s+(\d+)\s+kB/m.exec(s);
    if(rss&&Number(rss[1])>256*1024)finish(held('ocr_render_memory_limit'));
   }).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')finish(held('ocr_render_memory_monitor_unavailable'));});
  },25);
  child.on('error',()=>finish(held('ocr_render_worker_failure')));
  child.stdin.on('error',()=>finish(held('ocr_render_input_failure')));
  child.stdout.on('data',(b:Buffer)=>{
   outputBytes+=b.length;if(outputBytes>9*1024*1024)return finish(held('ocr_render_output_limit'));
   chunks.push(Buffer.from(b));
  });
  child.stderr.on('data',(b:Buffer)=>{diagnostics+=b.toString('utf8');if(diagnostics.length>16384)finish(held('ocr_render_diagnostics_limit'));});
  child.on('close',code=>{
   if(done)return;
   const expectedNotice=/^\(node:\d+\) SecurityWarning: The flag --allow-addons must be used with extreme caution\. It could invalidate the permission model\.\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n?/;
   if(code!==0||diagnostics.replace(expectedNotice,'').trim())return finish(held('ocr_render_diagnostics'));
   try{finish(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}
   catch{finish(held('ocr_render_worker_contract'));}
  });
  child.stdin.end(JSON.stringify({data:bytes.toString('base64'),maxPages,maxText:40000,ocrReview:true}));
 });
}

/** Explicit internal review path only. Normal PDF extraction remains unchanged. */
export async function reviewPdfOcr(original:Buffer,maxPages=3):Promise<any>{
 if(!Buffer.isBuffer(original)||original.length<5||original.length>8*1024*1024)return held('byte_limit');
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>3)return held('ocr_page_limit');
 if(active)return held('ocr_pdf_busy');
 const bytes=Buffer.from(original),sourceSha=hash(bytes),deadline=Date.now()+30000;
 active=true;
 try{
  const preflight=await extractOriginalPdf(bytes,maxPages,{timeout:Math.min(15000,deadline-Date.now())});
  if(preflight.status!=='incomplete_stop'||preflight.reason!=='needs_ocr_or_visual_review')return held(preflight.status==='complete'?'ocr_not_needed':preflight.reason??'ocr_preflight_failed');
  if(Date.now()>=deadline)return held('ocr_timeout');
  const result=await render(bytes,maxPages,Math.min(10000,deadline-Date.now()));
  if(!result||typeof result!=='object'||Array.isArray(result))return held('ocr_render_worker_contract');
  if(result.status==='incomplete_stop')return held(result.reason??'ocr_render_failed');
  if(keys(result)!=='extractor,page_count,pages,review_only,source_sha256,status,version'||result.status!=='rendered_for_review'||result.review_only!==true||result.source_sha256!==sourceSha||result.extractor!=='pdfjs-dist'||result.version!=='6.2.108'||!Number.isInteger(result.page_count)||result.page_count<1||result.page_count>maxPages||!Array.isArray(result.pages)||result.pages.length!==result.page_count)return held('ocr_render_worker_contract');
  const pages=[];let chars=0;
  for(let i=0;i<result.pages.length;i++){
   const p=result.pages[i];
   if(!p||keys(p)!=='height,page,raster_base64,raster_sha256,width'||p.page!==i+1||typeof p.raster_base64!=='string'||p.raster_base64.length>3*1024*1024)return held('ocr_render_worker_contract');
   const png=Buffer.from(p.raster_base64,'base64');
   if(png.length<33||png.toString('base64')!==p.raster_base64||hash(png)!==p.raster_sha256||png.readUInt32BE(16)!==p.width||png.readUInt32BE(20)!==p.height)return held('ocr_render_worker_contract');
   if(Date.now()>=deadline)return held('ocr_timeout');
   if(chars>=40000)return held('ocr_output_limit');
   const text:any=await reviewRasterOcr({raster:png,original_sha256:sourceSha,page:p.page,page_count:result.page_count},{timeoutMs:Math.min(10000,deadline-Date.now()),maxText:40000-chars});
   if(text.status!=='review_required')return held(text.reason??'ocr_engine_failure');
   chars+=text.text.length;if(chars>40000)return held('ocr_output_limit');
   pages.push({page:p.page,raster_sha256:p.raster_sha256,width:p.width,height:p.height,text:text.text,text_sha256:text.text_sha256,engine:text.engine});
  }
  return {status:'review_required',review_only:true,extraction_complete:false,source_sha256:sourceSha,byte_size:bytes.length,page_count:result.page_count,pages,
   renderer:{name:'pdfjs-dist',version:'6.2.108',worker_sha256:hash(await readFile(worker)),dpi:150},
   scope:'Original-byte-bound rendering and OCR candidates only; visual correctness and business facts unverified'};
 }finally{active=false;}
}
