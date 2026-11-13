import test from 'node:test';
import assert from 'node:assert/strict';
import {observeExplicitQuota,QuotaObservationSchema} from '../dist/quota-observation.js';
import {readThreadEvidence} from '../dist/thread-evidence.js';
const now=new Date('2026-11-13T20:00:00.000Z');
const error=(status=429,reasons=[],headers={})=>({response:{status,data:{error:{errors:reasons.map(reason=>({reason,message:'PRIVATE'}))}},headers},message:'PRIVATE-URL-TOKEN-CUSTOMER'});
test('only existing explicit quota statuses/reasons produce bounded facts',()=>{
 for(const [status,reasons,reason]of [[429,[],'unavailable'],[403,['rateLimitExceeded'],'rateLimitExceeded'],[403,['userRateLimitExceeded'],'userRateLimitExceeded'],[429,['rateLimitExceeded','userRateLimitExceeded'],'both']]){
  assert.deepEqual(observeExplicitQuota(error(status,reasons),now),{version:1,observed_at:now.toISOString(),provider_http_status:status,quota_reason:reason});
 }
 for(const e of [error(403,['PRIVATE']),error(500),{code:'429'},null])assert.equal(observeExplicitQuota(e,now),undefined);
});
test('standard retry header strictly bounded and canonical historical time survives',()=>{
 for(const headers of [{'Retry-After':'60'},{get:name=>name==='retry-after'?'60':null}])assert.equal(observeExplicitQuota(error(429,[],headers),now).retry_after_seconds,60);
 const r=observeExplicitQuota(error(429,[],{'retry-after':'Fri, 13 Nov 2026 20:01:00 GMT'}),now);
 assert.equal(r.retry_after_reset_at,'2026-11-13T20:01:00.000Z');assert.equal(QuotaObservationSchema.safeParse(r).success,true);
 for(const value of ['PRIVATE', '60 PRIVATE', '-1','86401','1.5','Infinity','0'.repeat(100),'Fri, 13 Nov 2026 19:59:59 GMT','Sat, 14 Nov 2026 20:00:01 GMT','Thu, 13 Nov 2026 20:01:00 GMT',['60']]){
  const r=observeExplicitQuota(error(429,[],{'retry-after':value}),now);assert.deepEqual(Object.keys(r),['version','observed_at','provider_http_status','quota_reason']);
 }
 assert.equal(observeExplicitQuota(error(429,[],{'Retry-After':'60','retry-after':'120'}),now).retry_after_seconds,undefined);
});
test('private fields/getters cannot escape or mask the existing denial',()=>{
 const e=error(429,['PRIVATE'],{'retry-after':'PRIVATE'});assert.doesNotMatch(JSON.stringify(observeExplicitQuota(e,now)),/PRIVATE|URL|TOKEN/);
 Object.defineProperty(e.response,'headers',{get(){throw Error('PRIVATE')}});assert.equal(observeExplicitQuota(e,now),undefined);
});
test('actual thread evidence annotates only failed natural fetch, never skipped PDFs or a new call',async()=>{
 const previous=process.env.PDF_DOCUMENT_EVIDENCE_ENABLED;process.env.PDF_DOCUMENT_EVIDENCE_ENABLED='true';
 try{for(const [status,reasons,quota]of [[429,[],true],[403,['userRateLimitExceeded'],true],[403,['PRIVATE'],false],[500,[],false]]){
  let reads=0;const message={id:'m',threadId:'t',historyId:'h',labelIds:[],attachments:[0,1].map(i=>({filename:`synthetic${i}.pdf`,mime_type:'application/pdf',size:10}))};
  const result=await readThreadEvidence({getEmail:async()=>message,getThread:async()=>({account:'synthetic@example.test',provider:'gmail',threadId:'t',messages:[message],nextPageToken:null,threadComplete:true,attachmentComplete:true}),getDocumentAttachment:async()=>{reads++;throw error(status,reasons,{'retry-after':'60'});}},'synthetic@example.test','m','gmail');
  assert.equal(result.success,false);assert.equal(result.status,'incomplete_stop');assert.deepEqual(result.failures,['pdf_extraction_complete']);
  assert.equal(reads,quota?1:2);assert.equal(result.pdfs[0].failure_code,quota?'provider_rate_limit':status===403?'provider_forbidden':'source_fetch_failed');
  assert.equal(!!result.pdfs[0].quota_observation,quota);assert.equal(result.pdfs[1].quota_observation,undefined);
  if(quota)assert.equal(result.pdfs[0].quota_observation.retry_after_seconds,60);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|URL|TOKEN/);
 }}finally{if(previous===undefined)delete process.env.PDF_DOCUMENT_EVIDENCE_ENABLED;else process.env.PDF_DOCUMENT_EVIDENCE_ENABLED=previous;}
});
