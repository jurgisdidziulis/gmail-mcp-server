import {extractOriginalPdf} from './pdf/extract.js';
import {createHash} from 'node:crypto';
/** Provider-backed evidence. Metadata never substitutes for extracted PDF content. */
export async function readThreadEvidence(service: {
  getEmail(id: string): Promise<any>;
  getThread(id: string, limit: number, token?: string): Promise<any>;
  getDocumentAttachment?(input:any):Promise<any>;
}, account: string, messageId: string, provider: 'gmail' | 'hostinger-imap', maxPdfPages=50) {
  const anchor = await service.getEmail(messageId);
  if (anchor?.id !== messageId || typeof anchor.threadId !== 'string' || !anchor.threadId) throw new Error('Anchor identity mismatch');
  const messages: any[] = [], seen = new Set<string>(), tokens = new Set<string>();
  let token: string | undefined, finished = false;
  for (let pages = 0; pages < 10 && !finished; pages++) {
    const page = await service.getThread(anchor.threadId, 100, token);
    if (page?.account !== account || page.provider !== provider || page.threadId !== anchor.threadId || !Array.isArray(page.messages) || typeof page.threadComplete !== 'boolean' || page.attachmentComplete !== true) throw new Error('Thread provider contract mismatch');
    if (!page.messages.length || messages.length + page.messages.length > 1000) throw new Error('Thread membership bound exceeded or empty page');
    for (const m of page.messages) {
      if (typeof m?.id !== 'string' || !m.id || seen.has(m.id) || m.threadId !== anchor.threadId || !Array.isArray(m.attachments) || !Array.isArray(m.labelIds)) throw new Error('Thread message identity or metadata mismatch');
      seen.add(m.id); messages.push(m);
    }
    if (page.threadComplete) {
      if (page.nextPageToken !== null) throw new Error('Complete thread carries a continuation');
      finished = true;
    } else {
      if (typeof page.nextPageToken !== 'string' || !page.nextPageToken || tokens.has(page.nextPageToken)) throw new Error('Thread continuation missing or repeated');
      tokens.add(page.nextPageToken); token = page.nextPageToken;
    }
  }
  if (!finished || !seen.has(messageId)) throw new Error('Thread traversal incomplete or anchor absent');
  const attachments: any[] = [];
  for (const m of messages) for (const a of m.attachments) {
    const mime = a.mime_type ?? a.mimeType;
    if (typeof a.filename !== 'string' || !a.filename || typeof mime !== 'string' || !mime) throw new Error('Attachment metadata malformed');
    attachments.push({source_message_id:m.id,filename:a.filename,mime_type:mime,is_pdf:mime.toLowerCase()==='application/pdf'||a.filename.toLowerCase().endsWith('.pdf')});
  }
  const pdfs:any[]=[];let totalBytes=0,totalText=0;let providerRateLimited=false;
  for(const attachment of attachments.filter(a=>a.is_pdf)) {
    const incomplete=(error:string)=>({...attachment,status:'incomplete',error});
    if(providerRateLimited){pdfs.push({...incomplete('provider_rate_limit'),failure_stage:'source_fetch',failure_code:'provider_rate_limit'});continue;}
    if(process.env.PDF_DOCUMENT_EVIDENCE_ENABLED!=='true'){pdfs.push(incomplete('pdf_extraction_not_activated'));continue;}
    if(provider!=='gmail'||!service.getDocumentAttachment){pdfs.push(incomplete('pdf_provider_unsupported'));continue;}
    if(pdfs.length>=10){pdfs.push(incomplete('pdf_count_limit'));continue;}
    const message=messages.find(m=>m.id===attachment.source_message_id);
    const matches=message.attachments.filter((a:any)=>a.filename===attachment.filename&&a.mime_type===attachment.mime_type);
    if(matches.length!==1||!message.historyId){pdfs.push(incomplete('pdf_source_identity_incomplete'));continue;}
    if(!Number.isSafeInteger(matches[0].size)||matches[0].size<1||totalBytes+matches[0].size>16*1024*1024){pdfs.push(incomplete('pdf_thread_byte_limit'));continue;}
    let failureStage = 'source_fetch';
    try {
      const original=await service.getDocumentAttachment({messageId:message.id,threadId:message.threadId,historyId:message.historyId,attachment:matches[0]});
      failureStage = 'source_binding';
      const {bytes,source}=original;
      if(!Buffer.isBuffer(bytes)||bytes.length!==matches[0].size||typeof source.attachment_id!=='string'||!source.attachment_id||typeof source.source_part_path!=='string'||!/^root(?:\.\d+)*$/.test(source.source_part_path)||source.account!==account||source.message_id!==message.id||source.thread_id!==message.threadId||source.history_id!==message.historyId||source.filename!==attachment.filename||source.mime_type!==attachment.mime_type||source.byte_size!==bytes.length||source.sha256!==createHash('sha256').update(bytes).digest('hex'))throw Error('source binding');
      totalBytes+=bytes.length;if(totalBytes>16*1024*1024){pdfs.push(incomplete('pdf_thread_byte_limit'));continue;}
      failureStage = 'extractor';
      const extracted=await extractOriginalPdf(bytes,maxPdfPages);
      if(extracted.status!=='complete'){pdfs.push({...incomplete(extracted.reason??'pdf_extraction_failed'),source});continue;}
      const text=extracted.pages.map((p:any)=>p.text).join('\n\n');totalText+=text.length;
      if(totalText>500000){pdfs.push(incomplete('pdf_thread_text_limit'));continue;}
      pdfs.push({...attachment,...extracted,source,text,text_sha256:createHash('sha256').update(text).digest('hex'),is_pdf:true,status:'complete',error:null});
    }catch(error:any){
      const code = error?.code ?? error?.response?.status;
      const reasons = error?.response?.data?.error?.errors;
      const explicitQuota = code === 429 || (code === 403 && Array.isArray(reasons) && reasons.some((r:any) => ['rateLimitExceeded','userRateLimitExceeded'].includes(r?.reason)));
      if (explicitQuota) providerRateLimited=true;
      const failureCode = explicitQuota ? 'provider_rate_limit' : code === 403 ? 'provider_forbidden' :
        code === 404 ? 'provider_not_found' : error?.name === 'AbortError' || code === 'ETIMEDOUT' ? 'source_timeout' :
        failureStage === 'source_binding' ? 'source_binding_rejected' :
        failureStage === 'extractor' ? 'extractor_exception' : 'source_fetch_failed';
      pdfs.push({...incomplete('pdf_source_or_extraction_failed'),failure_stage:failureStage,failure_code:failureCode});
    }
  }
  const complete=pdfs.every(p=>p.status==='complete');
  return {capability:'mail.evidence.read',contract_version:'1.0.0',success:complete,status:complete?'complete':'incomplete_stop',account,anchor_message_id:messageId,thread_id:anchor.threadId,message_count:messages.length,messages,attachment_count:attachments.length,attachments,pdf_count:pdfs.length,pdfs,completeness:{anchor_message_complete:true,thread_complete:true,attachments_enumerated:true,pdf_extraction_complete:complete,reply_context_complete:true},failures:complete?[]:['pdf_extraction_complete']};
}
