import {test} from 'node:test';import assert from 'node:assert/strict';
import {GmailService} from '../dist/gmail-service.js';
const account='info@jurgisdid.com',key='fixture-stable-key';
function fixture() {
 const state={listFail:false,summaryFail:false,threadFail:false,bodyFail:false,members:['m1','m2','m3'],reads:0,writes:0};
 function service(a=account,k=key) {
  const s=new GmailService('fixture-access',a,k);
  s.gmail={users:{
   getProfile:async()=>({data:{emailAddress:a}}),
   messages:{
    list:async({pageToken})=>{
     state.reads++;
     if(state.listFail){state.listFail=false;throw Error('fixture provider read failed')}
     return {data:{messages:[{id:pageToken?'m2':'m1'}],nextPageToken:pageToken?undefined:'provider-page-2'}};
    },
    get:async({id})=>{
     if(state.summaryFail){state.summaryFail=false;throw Error('fixture summary failed')}
     return {data:{id,threadId:'t1',payload:{headers:[]},labelIds:['INBOX','UNREAD']}};
    },
    modify:async()=>{state.writes++;throw Error('Write forbidden')}
   },
   threads:{get:async()=>{
    state.reads++;
    if(state.threadFail){state.threadFail=false;throw Error('fixture thread failed')}
    return {data:{id:'t1',messages:state.members.map(id=>({id}))}};
   }}
  }};
  s.getEmail=async id=>{
   if(state.bodyFail){state.bodyFail=false;throw Error('fixture body evidence failed')}
   return {id,threadId:'t1',labelIds:['INBOX','UNREAD'],attachments:[],body:'fixture'};
  };
  return s;
 }
 return {state,service};
}
test('list provider failure leaves exact signed cursor retriable',async()=>{const {state,service}=fixture(),s=service();const c=(await s.listEmails('is:unread',1)).nextPageToken;state.listFail=true;await assert.rejects(()=>s.listEmails('is:unread',1,c));assert.equal((await s.listEmails('is:unread',1,c)).emails[0].id,'m2');assert.equal(state.writes,0);});
test('summary failure and downstream rejection do not consume cursor',async()=>{const {state,service}=fixture(),s=service();const c=(await s.listEmails('is:unread',1)).nextPageToken;state.summaryFail=true;await assert.rejects(()=>s.listEmails('is:unread',1,c));await s.listEmails('is:unread',1,c);assert.equal((await s.listEmails('is:unread',1,c)).emails[0].id,'m2');assert.equal(state.writes,0);});
test('concurrent list retries and restarted service preserve read-only binding',async()=>{const {state,service}=fixture(),s=service();const c=(await s.listEmails('q',1)).nextPageToken;const r=await Promise.all([s.listEmails('q',1,c),s.listEmails('q',1,c),service().listEmails('q',1,c)]);assert.ok(r.every(x=>x.emails[0].id==='m2'));assert.equal(state.writes,0);});
test('list account, query, bounds, key and tampered signature still reject',async()=>{const {state,service}=fixture(),s=service();const c=(await s.listEmails('q',1)).nextPageToken;const reads=state.reads;for(const f of [()=>service('other@invalid.example').listEmails('q',1,c),()=>service(account,'wrong').listEmails('q',1,c),()=>s.listEmails('other',1,c),()=>s.listEmails('q',2,c),()=>s.listEmails('q',1,c.slice(0,-3)+'xxx')])await assert.rejects(f);assert.equal(state.reads,reads);});
test('thread provider and body-evidence failures permit same cursor retry',async()=>{const {state,service}=fixture(),s=service();const c=(await s.getThread('t1',1)).nextPageToken;state.threadFail=true;await assert.rejects(()=>s.getThread('t1',1,c));state.bodyFail=true;await assert.rejects(()=>s.getThread('t1',1,c));assert.equal((await s.getThread('t1',1,c)).messages[0].id,'m2');assert.equal(state.writes,0);});
test('thread concurrent retry, downstream rejection and restart revalidate membership',async()=>{const {state,service}=fixture(),s=service();const c=(await s.getThread('t1',1)).nextPageToken;await s.getThread('t1',1,c);const r=await Promise.all([s.getThread('t1',1,c),service().getThread('t1',1,c)]);assert.ok(r.every(x=>x.messages[0].id==='m2'));state.members.push('m4');await assert.rejects(()=>s.getThread('t1',1,c),/bounds/);assert.equal(state.writes,0);});
test('thread account, identity, key and signature mismatch reject',async()=>{const {service}=fixture(),s=service();const c=(await s.getThread('t1',1)).nextPageToken;for(const f of [()=>service('other@invalid.example').getThread('t1',1,c),()=>service(account,'wrong').getThread('t1',1,c),()=>s.getThread('other',1,c),()=>s.getThread('t1',1,c.slice(0,-3)+'xxx')])await assert.rejects(f);});
