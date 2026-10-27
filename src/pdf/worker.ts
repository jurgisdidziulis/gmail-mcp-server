import './network-deny.js';
import {collectTextNotes} from './note-review.js';
import {collectTextFields} from './form-review.js';
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
 const fields=await doc.getFieldObjects();
 const xfa=((await doc.getMetadata()).info as any).IsXFAPresent;
 if(xfa!==false){stop('xfa_requires_review');process.exit(0);}
 const annotationPages=[];let hasAnnotations=false;
 for(let n=1;n<=doc.numPages;n++){const page=await doc.getPage(n);if(await page.getJSActions()){stop('embedded_actions');process.exit(0);}const annotations=await page.getAnnotations({intent:'any'});hasAnnotations ||= annotations.length>0;annotationPages.push({page:n,annotations});}
 if(fields||hasAnnotations){
  let review,forms;try{review=collectTextNotes(annotationPages);if(fields)forms=collectTextFields(fields,annotationPages,xfa);}catch(e:any){stop(e.message==='embedded_actions'?'embedded_actions':['note_review_limit','form_review_limit','form_review_contract','xfa_requires_review'].includes(e.message)?e.message:'note_review_contract');process.exit(0);}
  if(warnings.length){stop('parser_warning');process.exit(0);}
  await task.destroy();
  process.stdout.write(JSON.stringify({status:'incomplete_stop',reason:'annotations_or_forms_require_review',extractor:'pdfjs-dist',version:'6.2.108',...(review.notes.length?{note_review:review}:{}),...(forms?.widgets.length?{form_review:forms}:{})}));process.exit(0);
 }
 if(req.ocrReview===true){
  if(req.maxPages>3){stop('ocr_page_limit');process.exit(0);}
  const {createCanvas}=require('@napi-rs/canvas');
  const rendered=[];let rasterBytes=0;
  for(let n=1;n<=doc.numPages;n++){
   const page=await doc.getPage(n),viewport=page.getViewport({scale:150/72});
   const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);
   if(width<1||height<1||width>4096||height>4096||width*height>4_000_000){stop('ocr_raster_pixel_limit');process.exit(0);}
   const canvas=createCanvas(width,height);
   await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport,background:'rgb(255,255,255)'}).promise;
   const png:Buffer=canvas.toBuffer('image/png');rasterBytes+=png.length;
   if(png.length>2*1024*1024||rasterBytes>6*1024*1024){stop('ocr_raster_byte_limit');process.exit(0);}
   rendered.push({page:n,width,height,raster_base64:png.toString('base64'),raster_sha256:createHash('sha256').update(png).digest('hex')});
   page.cleanup();
  }
  if(warnings.length){stop('parser_warning');process.exit(0);}
  await task.destroy();
  process.stdout.write(JSON.stringify({status:'rendered_for_review',review_only:true,extractor:'pdfjs-dist',version,page_count:doc.numPages,source_sha256:createHash('sha256').update(Buffer.from(req.data,'base64')).digest('hex'),pages:rendered}));process.exit(0);
 }
 const imageOps=new Set([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintImageMaskXObjectGroup,OPS.paintImageXObjectRepeat,OPS.paintInlineImageXObjectGroup]);
 const pages=[];let total=0;
 for(let n=1;n<=doc.numPages;n++) {
  const page=await doc.getPage(n);
  if((await page.getAnnotations({intent:'any'})).length){stop('annotations_or_forms_require_review');process.exit(0);}
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
