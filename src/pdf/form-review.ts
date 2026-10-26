import {createHash} from 'node:crypto';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const fail=()=>{throw Error('form_review_contract');};
const short=(v:any)=>typeof v==='string'&&v.length>0&&v.length<=200;
export function collectTextFields(fields:any,pages:{page:number;annotations:any[]}[],xfa:any){
 if(xfa!==false)throw Error('xfa_requires_review');
 if(!fields||typeof fields!=='object'||Array.isArray(fields))fail();
 const leaves=new Map<string,any>();
 for(const group of Object.values(fields) as any[]){
  if(!Array.isArray(group))fail();
  for(const f of group){
   if(!f||f.actions||f.action||f.jsActions)throw Error('embedded_actions');
   if(Array.isArray(f.kidIds)&&f.page===-1&&f.type==='')continue;
   if(!short(f.id)||leaves.has(f.id))fail();leaves.set(f.id,f);
  }
 }
 const seen=new Set<string>(),widgets:any[]=[];let total=0;
 for(const p of pages)for(const a of p.annotations){
  if(a.actions||a.action||a.jsActions)throw Error('embedded_actions');
  if(a.subtype!=='Widget')continue;
  if(!short(a.id)||seen.has(a.id))fail();seen.add(a.id);
  const f=leaves.get(a.id);if(!f||f.page!==p.page-1||f.name!==a.fieldName)fail();
  // Both PDF.js views must explicitly agree on safe text-widget flags.
  if(f.type!=='text'||a.fieldType!=='Tx')continue;
  if(typeof f.password!=='boolean'||typeof f.hidden!=='boolean'||typeof a.password!=='boolean'||typeof a.hidden!=='boolean'||!Number.isInteger(a.fieldFlags))fail();
  if(f.password!==a.password||f.hidden!==a.hidden||Boolean(a.fieldFlags&8192)!==a.password)fail();
  if(f.password||f.hidden||a.richText||(a.fieldFlags&(1<<25)))continue;
  if(!short(f.name)||typeof f.value!=='string'||f.value!==a.fieldValue)fail();
  if(f.value.length>4000||widgets.length>=100||total+f.value.length>40000)throw Error('form_review_limit');
  total+=f.value.length;widgets.push({page:p.page,widget_id:a.id,field_name:f.name,value:f.value,value_sha256:hash(f.value)});
 }
 for(const id of leaves.keys())if(!seen.has(id))fail();
 return {review_only:true as const,value_semantics:'pdfjs-resolved' as const,page_count:pages.length,widgets,conflicting_names:[...new Set(widgets.filter((w,i)=>widgets.some((v,j)=>i!==j&&v.field_name===w.field_name&&v.value!==w.value)).map(w=>w.field_name))].sort()};
}
export function bindFormReview(r:any,bytes:Buffer,maxPages:number){
 if(!r||Object.keys(r).sort().join(',')!=='conflicting_names,page_count,review_only,value_semantics,widgets'||r.review_only!==true||r.value_semantics!=='pdfjs-resolved'||!Number.isInteger(r.page_count)||r.page_count<1||r.page_count>maxPages||!Array.isArray(r.widgets)||r.widgets.length<1||r.widgets.length>100||!Array.isArray(r.conflicting_names))fail();
 let total=0,last=0;const seen=new Set<string>();
 for(const w of r.widgets){
  if(!w||Object.keys(w).sort().join(',')!=='field_name,page,value,value_sha256,widget_id'||!Number.isInteger(w.page)||w.page<1||w.page>r.page_count||w.page<last||!short(w.widget_id)||!short(w.field_name)||typeof w.value!=='string'||w.value.length>4000||hash(w.value)!==w.value_sha256||seen.has(w.widget_id))fail();
  total+=w.value.length;if(total>40000)throw Error('form_review_limit');last=w.page;seen.add(w.widget_id);
 }
 const conflicts=[...new Set(r.widgets.filter((w:any,i:number)=>r.widgets.some((v:any,j:number)=>i!==j&&v.field_name===w.field_name&&v.value!==w.value)).map((w:any)=>w.field_name))].sort();
 if(JSON.stringify(conflicts)!==JSON.stringify(r.conflicting_names))fail();
 return {...r,source_sha256:createHash('sha256').update(bytes).digest('hex'),byte_size:bytes.length,extractor:'pdfjs-dist',version:'6.2.108'};
}
