/** Provider-backed evidence. Metadata never substitutes for extracted PDF content. */
export async function readThreadEvidence(service: {
  getEmail(id: string): Promise<any>;
  getThread(id: string, limit: number, token?: string): Promise<any>;
}, account: string, messageId: string, provider: 'gmail' | 'hostinger-imap') {
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
  const pdfs = attachments.filter(a=>a.is_pdf).map(a=>({...a,status:'incomplete',error:'pdf_content_not_extracted'}));
  const complete = pdfs.length === 0;
  return {capability:'mail.evidence.read',contract_version:'1.0.0',success:complete,status:complete?'complete':'incomplete_stop',account,anchor_message_id:messageId,thread_id:anchor.threadId,message_count:messages.length,messages,attachment_count:attachments.length,attachments,pdf_count:pdfs.length,pdfs,completeness:{anchor_message_complete:true,thread_complete:true,attachments_enumerated:true,pdf_extraction_complete:complete,reply_context_complete:true},failures:complete?[]:['pdf_extraction_complete']};
}
