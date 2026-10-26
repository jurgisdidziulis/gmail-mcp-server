import {bindNoteReview} from './note-review.js';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
let busy=false;
export async function extractOriginalPdf(bytes:Buffer,maxPages=50,options:{timeout?:number;maxText?:number;maxRss?:number}={}) : Promise<any> {
 const fail=(reason:string)=>({status:'incomplete_stop',reason,source_sha256:Buffer.isBuffer(bytes)?createHash('sha256').update(bytes).digest('hex'):null,byte_size:bytes?.length??0});
 if(!Buffer.isBuffer(bytes)||bytes.length<5||bytes.length>8*1024*1024)return fail('byte_limit');
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>200)return fail('page_limit');
 if(bytes.subarray(0,5).toString()!=='%PDF-')return fail('malformed_pdf');
 if(busy)return fail('extractor_busy');busy=true;
 try {return await new Promise(resolveResult=>{
  const maxText=Math.min(options.maxText??500000,500000),maxRss=Math.min(options.maxRss??256*1024*1024,256*1024*1024);
  const worker=resolve(root,'dist/pdf/worker.js');
  const args=['--permission','--allow-fs-read='+resolve(root,'dist/pdf'),'--allow-fs-read='+resolve(root,'node_modules'),'--allow-addons','--max-old-space-size=128','--disable-proto=throw','--disallow-code-generation-from-strings',worker];
  const drop=process.platform==='linux'&&process.getuid?.()===0 ? {uid:65534,gid:65534}:{};
  const child=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe'],env:{NODE_ENV:'production',LANG:'C.UTF-8'},...drop});
  let output='',diagnostics='',done=false;
  const finish=(result:any)=>{if(done)return;done=true;clearTimeout(timer);clearInterval(monitor);const release=()=>resolveResult({...result,source_sha256:createHash('sha256').update(bytes).digest('hex'),byte_size:bytes.length});if(!child.pid||child.exitCode!==null||child.signalCode!==null)release();else{child.once('close',release);child.kill('SIGKILL');}};
  const timer=setTimeout(()=>finish(fail('timeout')),Math.min(options.timeout??15000,15000));
  const monitor=setInterval(()=>{if(process.platform!=='linux'||!child.pid)return;void readFile('/proc/'+child.pid+'/status','utf8').then(s=>{const kb=/^VmRSS:\s+(\d+)\s+kB/m.exec(s);if(kb&&Number(kb[1])*1024>maxRss)finish(fail('memory_limit'));}).catch((error:any)=>{if(error?.code!=='ENOENT')finish(fail('memory_monitor_unavailable'));});},25);
  child.stdout.on('data',b=>{output+=b;if(Buffer.byteLength(output)>maxText*8+100000)finish(fail('output_limit'));});
  child.stderr.on('data',b=>{diagnostics+=b;if(diagnostics.length>32000)finish(fail('parser_diagnostics'));});
  child.on('error',()=>finish(fail('worker_failure')));
  child.on('close',code=>{if(done)return;try{const runtimeNotice=/^\(node:\d+\) SecurityWarning: The flag --allow-addons must be used with extreme caution\. It could invalidate the permission model\.\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n?/;const notice=runtimeNotice.test(diagnostics);const remainingDiagnostics=diagnostics.replace(runtimeNotice,'');if(code!==0||remainingDiagnostics.trim())return finish(fail('parser_diagnostics'));const r=JSON.parse(output);if(r.note_review!==undefined){if(r.status!=='incomplete_stop'||r.reason!=='annotations_or_forms_require_review'||r.extractor!=='pdfjs-dist'||r.version!=='6.2.108')return finish(fail('worker_contract'));try{r.note_review=bindNoteReview(r.note_review,bytes,maxPages);}catch{return finish(fail('worker_contract'));}}if(notice)r.containment_notes=['Node native addon permission explicitly enabled for pinned canvas; not an OS sandbox'];if(r.status==='complete'&&(!Array.isArray(r.pages)||r.pages.length!==r.page_count||r.pages.some((p:any,i:number)=>p.page!==i+1||typeof p.text!=='string'||p.text_sha256!==createHash('sha256').update(p.text).digest('hex'))))return finish(fail('worker_contract'));finish(r);}catch{finish(fail('worker_failure'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({data:bytes.toString('base64'),maxPages,maxText}));
 });}finally{busy=false;}
}
