import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';

const ENGINE='/usr/bin/tesseract';
const MODEL='/usr/share/tesseract-ocr/5/tessdata/eng.traineddata';
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
let active=false;

export interface RasterReviewInput {
 raster:Buffer;
 /** Upstream must independently bind this declaration to the original PDF. */
 original_sha256:string;
 page:number;
 page_count:number;
}

async function publicFileHash(path:string){
 const info=await stat(path);
 if(!info.isFile()||info.size<1||info.size>32*1024*1024)throw Error('ocr_engine_unavailable');
 return sha(await readFile(path));
}

/** Internal, review-only raster OCR. No URLs, caller executable, shell, downloads,
 * invoice classification or trusted original-document claims. Not wired into the
 * live PDF extractor: upstream raster/original binding remains a prerequisite. */
export async function reviewRasterOcr(input:RasterReviewInput,options:{timeoutMs?:number;maxText?:number}={}){
 const held=(reason:string)=>({status:'incomplete_stop' as const,reason,review_only:true,completeness:false});
 if(!input||!Buffer.isBuffer(input.raster)||input.raster.length<33||input.raster.length>2*1024*1024)return held('ocr_raster_byte_limit');
 if(!input.raster.subarray(0,8).equals(PNG)||input.raster.readUInt32BE(8)!==13||input.raster.toString('ascii',12,16)!=='IHDR')return held('ocr_raster_format');
 const width=input.raster.readUInt32BE(16),height=input.raster.readUInt32BE(20);
 if(!width||!height||width>4096||height>4096||width*height>4_000_000)return held('ocr_raster_pixel_limit');
 if(typeof input.original_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.original_sha256)||!Number.isInteger(input.page)||!Number.isInteger(input.page_count)||input.page<1||input.page_count<1||input.page>input.page_count||input.page_count>50)return held('ocr_source_declaration_invalid');
 const timeoutMs=options.timeoutMs??10_000,maxText=options.maxText??40_000;
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10_000||!Number.isInteger(maxText)||maxText<1||maxText>40_000)return held('ocr_limits_invalid');
 if(active)return held('ocr_busy');
 // Snapshot before awaiting or spawning: caller mutation must not change bytes
 // between the raster digest, engine input and returned evidence.
 const raster=Buffer.from(input.raster),original=input.original_sha256,page=input.page,pageCount=input.page_count;
 active=true;
 try{
  let engineSha:string,modelSha:string;
  try{[engineSha,modelSha]=await Promise.all([publicFileHash(ENGINE),publicFileHash(MODEL)]);}
  catch{return held('ocr_engine_unavailable');}
  return await new Promise<ReturnType<typeof held>|Record<string,unknown>>(resolve=>{
   const drop=process.platform==='linux'&&process.getuid?.()===0?{uid:65534,gid:65534}:{};
   const child=spawn(ENGINE,['stdin','stdout','-l','eng','--dpi','150','--psm','6'],{
    shell:false,stdio:['pipe','pipe','pipe'],env:{LANG:'C.UTF-8',OMP_THREAD_LIMIT:'1'},...drop,
   });
   const chunks:Buffer[]=[];
   let diagnostics=0,outputBytes=0,done=false;
   const finish=(result:ReturnType<typeof held>|Record<string,unknown>)=>{
    if(done)return;done=true;clearTimeout(timer);clearInterval(monitor);
    if(!child.pid||child.exitCode!==null||child.signalCode!==null)resolve(result);
    else{child.once('close',()=>resolve(result));child.kill('SIGKILL');}
   };
   const timer=setTimeout(()=>finish(held('ocr_timeout')),timeoutMs);
   const monitor=setInterval(()=>{
    if(process.platform!=='linux'||!child.pid)return;
    void readFile('/proc/'+child.pid+'/status','utf8').then(text=>{
     const rss=/^VmRSS:\s+(\d+)\s+kB/m.exec(text);
     if(rss&&Number(rss[1])>256*1024)finish(held('ocr_memory_limit'));
    }).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')finish(held('ocr_memory_monitor_unavailable'));});
   },25);
   child.on('error',()=>finish(held('ocr_engine_unavailable')));
   child.stdin.on('error',()=>finish(held('ocr_input_failure')));
   child.stdout.on('data',(bytes:Buffer)=>{
    outputBytes+=bytes.length;
    if(outputBytes>maxText*4)return finish(held('ocr_output_limit'));
    chunks.push(Buffer.from(bytes));
   });
   child.stderr.on('data',(bytes:Buffer)=>{diagnostics+=bytes.length;if(diagnostics>16_384)finish(held('ocr_diagnostics_limit'));});
   child.on('close',code=>{
    if(done)return;
    if(code!==0||diagnostics)return finish(held('ocr_engine_failure'));
    let text:string;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)).trim();}
    catch{return finish(held('ocr_output_encoding'));}
    if(!text)return finish(held('ocr_no_text'));
    if(text.length>maxText)return finish(held('ocr_output_limit'));
    finish({status:'review_required',review_only:true,completeness:false,
     declared_original_sha256:original,original_binding_verified:false,
     page,page_count:pageCount,raster_sha256:sha(raster),width,height,
     text,text_sha256:sha(text),confidence:null,
     engine:{name:'tesseract-cli',language:'eng',executable_sha256:engineSha,model_sha256:modelSha},
     scope:'OCR candidate only; original/raster binding, visual correctness and business facts unverified'});
   });
   child.stdin.end(raster);
  });
 }finally{active=false;}
}
