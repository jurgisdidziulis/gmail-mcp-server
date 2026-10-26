import {createHash} from 'node:crypto';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function collectTextNotes(pages:{page:number;annotations:any[]}[]){
 const notes:{page:number;annotation_id:string;text:string;text_sha256:string}[]=[];let total=0;const ids=new Set<string>();
 // Inspect every parsed action carrier before reading any annotation text.
 for(const p of pages)for(const a of p.annotations)if(a.actions||a.action||a.jsActions)throw Error('embedded_actions');
 for(const p of pages)for(const a of p.annotations){
  if(a.subtype!=='Text'||a.richText||a.url||a.unsafeUrl||a.file)continue;
  const text=a.contentsObj?.str;
  if(typeof text!=='string'||!text.length)continue;
  if(typeof a.id!=='string'||!a.id||a.id.length>200||ids.has(p.page+':'+a.id))throw Error('note_review_contract');
  if(text.length>4000||notes.length>=100||total+text.length>40000)throw Error('note_review_limit');
  ids.add(p.page+':'+a.id);total+=text.length;notes.push({page:p.page,annotation_id:a.id,text,text_sha256:hash(text)});
 }
 return {review_only:true as const,page_count:pages.length,notes};
}
export function bindNoteReview(report:any,bytes:Buffer,maxPages:number){
 if(!report||Object.keys(report).sort().join(',')!=='notes,page_count,review_only'||report.review_only!==true||!Number.isInteger(report.page_count)||report.page_count<1||report.page_count>maxPages||!Array.isArray(report.notes)||report.notes.length<1||report.notes.length>100)throw Error('note_review_contract');
 let total=0,lastPage=0;const ids=new Set<string>();
 for(const n of report.notes){
  if(!n||Object.keys(n).sort().join(',')!=='annotation_id,page,text,text_sha256'||!Number.isInteger(n.page)||n.page<1||n.page>report.page_count||n.page<lastPage||typeof n.annotation_id!=='string'||!n.annotation_id||n.annotation_id.length>200||typeof n.text!=='string'||!n.text.length||n.text.length>4000||hash(n.text)!==n.text_sha256||ids.has(n.page+':'+n.annotation_id))throw Error('note_review_contract');
  total+=n.text.length;if(total>40000)throw Error('note_review_limit');lastPage=n.page;ids.add(n.page+':'+n.annotation_id);
 }
 return {...report,source_sha256:createHash('sha256').update(bytes).digest('hex'),byte_size:bytes.length,extractor:'pdfjs-dist',version:'6.2.108'};
}
