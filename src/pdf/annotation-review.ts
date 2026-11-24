/** Eligibility for inert raster review only, never complete document evidence.
 * Existing document/page JS, XFA and note/form collector action checks MUST run
 * first. Canvas rendering has no DOM annotation layer or link navigation. */
export function assertInertAnnotationReview(pages:{page:number;annotations:any[]}[],notes:any,forms:any){
 const deny=(reason:string):never=>{throw Error(reason)};
 if(!Array.isArray(pages)||pages.length<1||pages.length>3)deny('ocr_page_limit');
 const noteIds=new Set(Array.isArray(notes?.notes)?notes.notes.map((n:any)=>n.annotation_id):[]);
 const widgetIds=new Set(Array.isArray(forms?.widgets)?forms.widgets.map((w:any)=>w.widget_id):[]);
 if(forms?.conflicting_names?.length)deny('annotation_review_conflicting_form_values');
 let total=0;
 for(const [i,p]of pages.entries()){
  if(p.page!==i+1||!Array.isArray(p.annotations))deny('annotation_review_contract');
  for(const a of p.annotations){
   if(++total>100)deny('annotation_review_limit');
   if(!a||typeof a!=='object'||a.actions||a.action||a.jsActions)deny('embedded_actions');
   if(!Number.isInteger(a.annotationFlags)||(a.annotationFlags&(2|32)))deny('annotation_review_hidden_annotation');
   if(a.subtype==='Widget'){
    if(!widgetIds.has(a.id)||a.fieldType!=='Tx'||a.password!==false||a.hidden!==false||a.richText||!Number.isInteger(a.fieldFlags)||(a.fieldFlags&(8192|(1<<25))))deny('annotation_review_unsupported_widget');
   }else if(a.subtype==='Text'){
    if(a.richText||a.url||a.unsafeUrl||a.file||typeof a.contentsObj?.str!=='string'||(a.contentsObj.str.length&&!noteIds.has(a.id)))deny('annotation_review_unsupported_note');
   }else if(a.subtype==='Link'){
    if(a.file||a.richText)deny('annotation_review_unsupported_link');
    for(const value of[a.url,a.unsafeUrl])if(value!==undefined&&value!==null){try{if(typeof value!=='string'||!['http:','https:'].includes(new URL(value).protocol))deny('annotation_review_unsupported_link');}catch{deny('annotation_review_unsupported_link');}}
   }else if(a.subtype==='Popup'){
    if(a.parentType!=='Text'||!noteIds.has(a.parentId))deny('annotation_review_unsupported_note');
   }else deny('annotation_review_unsupported_annotation');
  }
 }
}

/** Independent data-only dictionary admission, bound to the same original
 * bytes and exact indirect annotation IDs exposed by the pinned PDF.js parser.
 * Loaded only for explicit annotated OCR; ordinary extraction does not use it. */
export async function validateOriginalAnnotationDictionaries(bytes:Buffer,pages:{page:number;annotations:any[]}[]){
 const deny=(reason:string):never=>{throw Error(reason)};
 if(!Buffer.isBuffer(bytes)||bytes.length<5||bytes.length>8*1024*1024)deny('annotation_review_raw_limit');
 const original=Buffer.from(bytes);
 try{
  const {PDFDocument,PDFDict,PDFArray,PDFName,PDFRef,PDFNumber,PDFString,PDFHexString,PDFBool,ParseSpeeds}=await import('pdf-lib');
  const doc=await PDFDocument.load(original,{ignoreEncryption:false,updateMetadata:false,throwOnInvalidObject:true,parseSpeed:ParseSpeeds.Slow});
  if(doc.context.enumerateIndirectObjects().length>2000)deny('annotation_review_raw_limit');
  const rawPages=doc.getPages();if(rawPages.length!==pages.length||rawPages.length<1||rawPages.length>3)deny('annotation_review_raw_contract');
  const name=(key:string)=>PDFName.of(key),lookup=(value:any):any=>doc.context.lookup(value);
  const id=(ref:any)=>ref.objectNumber+'R'+(ref.generationNumber===0?'':ref.generationNumber);
  const all=new Set<string>();let total=0;
  const actions=(dict:any,link:boolean)=>{
   if(!(dict instanceof PDFDict))deny('annotation_review_raw_contract');
   if(['AA','JS','JavaScript'].some(k=>dict.has(name(k))))deny('embedded_actions');
   if(['RC','RV'].some(k=>dict.has(name(k))))deny('annotation_review_rich_content');
   if(dict.has(name('A'))){
    const a=lookup(dict.get(name('A')));
    if(!link||!(a instanceof PDFDict)||a.keys().some((k:any)=>!['/S','/URI','/IsMap','/Type'].includes(k.toString()))||a.get(name('S'))?.toString()!=='/URI')deny('embedded_actions');
    if(a.has(name('Type'))&&a.get(name('Type'))?.toString()!=='/Action')deny('embedded_actions');
    const uri=lookup(a.get(name('URI')));if(!(uri instanceof PDFString)&&!(uri instanceof PDFHexString))deny('annotation_review_unsupported_link');
    try{if(!['http:','https:'].includes(new URL(uri.decodeText()).protocol))deny('annotation_review_unsupported_link');}catch{deny('annotation_review_unsupported_link');}
    if(a.has(name('IsMap'))&&!(lookup(a.get(name('IsMap')))instanceof PDFBool))deny('annotation_review_raw_contract');
   }
  };
  actions(doc.catalog,false);
  if(doc.catalog.has(name('OpenAction')))deny('embedded_actions');
  const names=lookup(doc.catalog.get(name('Names')));if(names instanceof PDFDict&&names.has(name('JavaScript')))deny('embedded_actions');
  const acro=lookup(doc.catalog.get(name('AcroForm')));if(acro!==undefined){if(!(acro instanceof PDFDict))deny('annotation_review_raw_contract');actions(acro,false);if(acro.has(name('XFA')))deny('xfa_requires_review');}
  for(const [index,page]of rawPages.entries()){
   if(pages[index]?.page!==index+1||!Array.isArray(pages[index]?.annotations))deny('annotation_review_raw_contract');
   actions(page.node,false);
   const annots=lookup(page.node.get(name('Annots')));
   if(annots===undefined&&pages[index]!.annotations.length===0)continue;
   if(!(annots instanceof PDFArray)||annots.size()!==pages[index]!.annotations.length)deny('annotation_review_raw_contract');
   const exposed=new Map(pages[index]!.annotations.map(a=>[a.id,a]));if(exposed.size!==annots.size())deny('annotation_review_raw_contract');
   for(let i=0;i<annots.size();i++){
    if(++total>100)deny('annotation_review_raw_limit');
    const ref=annots.get(i);if(!(ref instanceof PDFRef)||all.has(id(ref))||!exposed.has(id(ref)))deny('annotation_review_raw_contract');all.add(id(ref));
    const annotation=lookup(ref);if(!(annotation instanceof PDFDict))deny('annotation_review_raw_contract');
    const data=exposed.get(id(ref))!,subtype=annotation.get(name('Subtype'))?.toString();if(subtype!=='/'+data.subtype)deny('annotation_review_raw_contract');
    const f=lookup(annotation.get(name('F')));if(f!==undefined&&(!(f instanceof PDFNumber)||!Number.isSafeInteger(f.asNumber())||f.asNumber()<0||f.asNumber()>0xffffffff))deny('annotation_review_raw_contract');
    // PDF spec Invisible1 is ignored for known annotation types; do not mistake
    // that documented normalization for Hidden2 or NoView32.
    if(f instanceof PDFNumber&&(f.asNumber()&(2|32)))deny('annotation_review_hidden_annotation');
    const pageRef=annotation.get(name('P'));if(pageRef!==undefined&&(!(pageRef instanceof PDFRef)||pageRef.toString()!==page.ref.toString()))deny('annotation_review_raw_contract');
    actions(annotation,subtype==='/Link');
    if(subtype==='/Widget'){
     const seen=new Set<string>();let parent=annotation.get(name('Parent')),depth=0;
     while(parent!==undefined){if(++depth>8||!(parent instanceof PDFRef)||seen.has(parent.toString()))deny('annotation_review_raw_contract');seen.add(parent.toString());const field=lookup(parent);actions(field,false);parent=field.get(name('Parent'));}
    }
   }
  }
 }catch(error){
  const reason=error instanceof Error?error.message:'';
  if(['embedded_actions','xfa_requires_review','annotation_review_hidden_annotation','annotation_review_unsupported_link','annotation_review_rich_content','annotation_review_raw_limit','annotation_review_raw_contract'].includes(reason))throw error;
  deny('annotation_review_raw_contract');
 }
}
