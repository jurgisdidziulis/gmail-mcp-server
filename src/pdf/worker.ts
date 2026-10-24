import './network-deny.js';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const require=createRequire(import.meta.url);
let input='';
for await (const b of process.stdin) { input+=b; if(Buffer.byteLength(input)>12_000_000)process.exit(2); }
const warnings:string[]=[];
console.warn=()=>{warnings.push('parser_warning');}; console.log=()=>{warnings.push('parser_log');};
const stop=(reason:string)=>process.stdout.write(JSON.stringify({status:'incomplete_stop',reason,extractor:'pdfjs-dist',version:'6.2.108'}));
try {
 const req=JSON.parse(input);
 if(!Number.isInteger(req.maxPages)||req.maxPages<1||req.maxPages>200||!Number.isInteger(req.maxText)||req.maxText<1||req.maxText>500000)throw Error('limits');
 const {getDocument,OPS,version}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 if(version!=='6.2.108')throw Error('version');
 const root=dirname(require.resolve('pdfjs-dist/package.json'));
 const task=getDocument({data:new Uint8Array(Buffer.from(req.data,'base64')),standardFontDataUrl:join(root,'standard_fonts/'),cMapUrl:join(root,'cmaps/'),cMapPacked:true,wasmUrl:join(root,'wasm/'),enableXfa:false,useSystemFonts:false,disableFontFace:true,isOffscreenCanvasSupported:false,useWorkerFetch:false,stopAtErrors:true});
 const doc=await task.promise;
 if(doc.numPages<1||doc.numPages>req.maxPages){stop('page_limit');process.exit(0);}
 if(await doc.getJSActions()){stop('embedded_actions');process.exit(0);}
 const imageOps=new Set([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintImageMaskXObjectGroup,OPS.paintImageXObjectRepeat,OPS.paintInlineImageXObjectGroup]);
 const pages=[];let total=0;
 for(let n=1;n<=doc.numPages;n++) {
  const page=await doc.getPage(n);
  if(await page.getJSActions()){stop('embedded_actions');process.exit(0);}
  const ops=await page.getOperatorList();
  if(ops.fnArray.some((op:number)=>imageOps.has(op))){stop('needs_ocr_or_visual_review');process.exit(0);}
  const content=await page.getTextContent();
  const text=content.items.map(item=>'str' in item ? item.str+(item.hasEOL?'\n':''):'').join('');
  total+=text.length;
  if(total>req.maxText){stop('text_limit');process.exit(0);}
  if(!text.trim()){stop('needs_ocr_or_visual_review');process.exit(0);}
  pages.push({page:n,text,text_sha256:createHash('sha256').update(text).digest('hex')});page.cleanup();
 }
 if(warnings.length){stop('parser_warning');process.exit(0);}
 await task.destroy();
 process.stdout.write(JSON.stringify({status:'complete',error:null,extractor:'pdfjs-dist',version,page_count:doc.numPages,pages,text_character_count:total,warnings:[],scope:'text-only; visual content not accepted'}));
} catch(e:any) {stop(e?.name==='PasswordException'?'password_required':'malformed_or_unsupported_pdf');}
