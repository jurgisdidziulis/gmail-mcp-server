import {z} from 'zod';

const canonicalTime=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value);
export const QuotaObservationSchema=z.object({version:z.literal(1),observed_at:canonicalTime,provider_http_status:z.union([z.literal(403),z.literal(429)]),quota_reason:z.enum(['rateLimitExceeded','userRateLimitExceeded','both','unavailable']),retry_after_seconds:z.number().int().min(0).max(86400).optional(),retry_after_reset_at:canonicalTime.optional()}).strict().refine(value=>value.provider_http_status!==403||value.quota_reason!=='unavailable').refine(value=>!(value.retry_after_seconds!==undefined&&value.retry_after_reset_at!==undefined)).refine(value=>value.retry_after_reset_at===undefined||(Date.parse(value.retry_after_reset_at)>=Date.parse(value.observed_at)&&Date.parse(value.retry_after_reset_at)-Date.parse(value.observed_at)<=86400000));

/** Only use after existing explicit-quota classification. Never copy raw data. */
export function observeExplicitQuota(error:unknown,now=new Date()){
 try{
  const e=error as any,code=typeof e?.response?.status==='number'?e.response.status:typeof e?.code==='number'?e.code:undefined;
  if(code!==403&&code!==429)return undefined;
  const reasons=e?.response?.data?.error?.errors;
  const values=Array.isArray(reasons)?reasons.slice(0,100).map((v:any)=>v?.reason):[];
  const perUser=values.includes('userRateLimitExceeded'),rate=values.includes('rateLimitExceeded');
  if(code===403&&!perUser&&!rate)return undefined;
  const value:any={version:1,observed_at:now.toISOString(),provider_http_status:code,quota_reason:perUser&&rate?'both':perUser?'userRateLimitExceeded':rate?'rateLimitExceeded':'unavailable'};
  const headers=e?.response?.headers;
  let header:unknown;
  if(headers&&typeof headers.get==='function')header=headers.get('retry-after');
  else if(headers&&typeof headers==='object'){
   const keys=Object.keys(headers).filter(k=>k.toLowerCase()==='retry-after');
   if(keys.length===1)header=headers[keys[0]!];
  }
  if(typeof header==='string'&&header.length<=64){
   if(/^(?:0|[1-9][0-9]{0,4})$/.test(header)&&Number(header)<=86400)value.retry_after_seconds=Number(header);
   else if(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)){
    const date=new Date(header),delta=date.getTime()-now.getTime();
    if(Number.isFinite(date.getTime())&&date.toUTCString()===header&&delta>=0&&delta<=86400000)value.retry_after_reset_at=date.toISOString();
   }
  }
  return QuotaObservationSchema.parse(value);
 }catch{return undefined;}
}
