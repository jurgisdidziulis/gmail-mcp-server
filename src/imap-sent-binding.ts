import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';

export type HostingerMailboxRole='INBOX'|'SENT';
export function requireMailboxRole(value:unknown):HostingerMailboxRole {
 if(value!=='INBOX'&&value!=='SENT')throw Error('Invalid Hostinger mailbox role');
 return value;
}
export interface ListedMailbox {path:string;flags:Set<string>;listed:boolean}
/** Raw server flags only: ImapFlow specialUse can be inferred from names/hints. */
export function resolveProviderSentMailbox(entries:unknown):{path:string;binding:string} {
 if(!Array.isArray(entries)||entries.length>4096)throw Error('Hostinger Sent folder discovery unavailable');
 const found:ListedMailbox[]=[];
 for(const entry of entries){
  if(!entry||typeof entry!=='object'||typeof entry.path!=='string'||!entry.path||Buffer.byteLength(entry.path)>1024||/[\x00-\x1f\x7f]/.test(entry.path)||!(entry.flags instanceof Set))throw Error('Hostinger Sent folder discovery invalid');
  if(entry.flags.has('\\Sent'))found.push(entry);
 }
 if(found.length!==1||found[0].listed!==true||found[0].flags.has('\\Noselect')||found[0].flags.has('\\NonExistent')||found[0].path.toUpperCase()==='INBOX')throw Error('Hostinger Sent folder discovery ambiguous or unavailable');
 const path=found[0].path;
 return {path,binding:createHash('sha256').update('hostinger-sent-folder\0'+path).digest('hex')};
}
const SentIdSchema=z.object({version:z.literal(1),provider:z.literal('hostinger-imap'),accountBinding:z.string().regex(/^[a-f0-9]{64}$/),mailbox:z.literal('SENT'),folderBinding:z.string().regex(/^[a-f0-9]{64}$/),uidValidity:z.string().regex(/^\d+$/).max(40),uid:z.number().int().positive().safe(),signature:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
type SentId=z.infer<typeof SentIdSchema>;
function signature(value:Omit<SentId,'signature'>,key:string){return createHmac('sha256',key).update(JSON.stringify(value)).digest('base64url');}
export function encodeSentMessageId(accountBinding:string,folderBinding:string,uidValidity:string,uid:number,key:string):string {
 const value={version:1 as const,provider:'hostinger-imap' as const,accountBinding,mailbox:'SENT' as const,folderBinding,uidValidity,uid};
 const signed=SentIdSchema.parse({...value,signature:signature(value,key)});
 return 'imap-sent:'+Buffer.from(JSON.stringify(signed)).toString('base64url');
}
export function decodeSentMessageId(id:string,accountBinding:string,key:string):SentId {
 try{
  if(!id.startsWith('imap-sent:')||id.length>2048)throw Error();
  const encoded=id.slice(10),raw=Buffer.from(encoded,'base64url');if(raw.toString('base64url')!==encoded)throw Error();
  const value=SentIdSchema.parse(JSON.parse(raw.toString('utf8')));if(value.accountBinding!==accountBinding)throw Error();
  const {signature:provided,...unsigned}=value,expected=signature(unsigned,key);
  if(Buffer.from(provided,'base64url').toString('base64url')!==provided||!timingSafeEqual(Buffer.from(provided,'base64url'),Buffer.from(expected,'base64url')))throw Error();
  return value;
 }catch{throw Error('Invalid Hostinger Sent message ID');}
}
