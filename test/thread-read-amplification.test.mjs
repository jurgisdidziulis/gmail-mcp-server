import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GmailService} from '../dist/gmail-service.js';

function fixture(count=100) {
  const calls=[];
  const messages=Array.from({length:count},(_,i)=>({id:`m${i}`,threadId:'t1',historyId:'h1',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[],body:{size:5,data:Buffer.from('hello').toString('base64url')}}}));
  const service=new GmailService('synthetic','synthetic@example.test','test-signing-key');
  service.gmail={users:{
    getProfile:async()=>{calls.push('profile');return {data:{emailAddress:'synthetic@example.test'}};},
    threads:{get:async(args,options)=>{calls.push('thread');assert.equal(args.format,'full');assert.equal(options.retry,false);assert.equal(options.timeout,15000);assert.equal(options.maxContentLength,8*1024*1024);return {data:{id:'t1',messages}};}},
    messages:{get:async()=>{calls.push('message');throw Error('Unexpected per-message fetch');},modify:async()=>{throw Error('Write forbidden');}}
  }};
  return {service,calls,messages};
}

test('100 ordinary messages require two provider reads, preserve bodies and never fetch individual messages',async()=>{
  const {service,calls}=fixture();
  const page=await service.getThread('t1',100);
  assert.deepEqual(calls,['profile','thread']);
  assert.equal(page.messages.length,100);
  assert.ok(page.messages.every(m=>m.body==='hello'&&m.threadId==='t1'));
  assert.equal(page.threadComplete,true);
  assert.equal(page.nextPageToken,null);
});

test('pagination preserves complete membership binding without message fan-out',async()=>{
  const {service,calls}=fixture(3);
  const first=await service.getThread('t1',2);
  assert.equal(first.threadComplete,false);
  const second=await service.getThread('t1',2,first.nextPageToken);
  assert.deepEqual(second.messages.map(m=>m.id),['m2']);
  assert.equal(second.threadComplete,true);
  assert.deepEqual(calls,['profile','thread','profile','thread']);
});

test('missing bodies, wrong thread, duplicate membership and truncated MIME fail closed',async()=>{
  for(const corrupt of [m=>delete m[0].payload,m=>m[0].threadId='other',m=>m[1].id=m[0].id,m=>m[0].payload.body.size=99]) {
    const {service,messages}=fixture(2);corrupt(messages);
    await assert.rejects(()=>service.getThread('t1',2));
  }
});
