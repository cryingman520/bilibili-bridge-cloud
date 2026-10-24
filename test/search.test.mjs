import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createSearchPolicy} from '../backend/search-policy.mjs';
import {createBackend} from '../backend/server.mjs';
import {responseSignals,safeDetails} from '../src/diagnostics.js';
import {search} from '../src/bilibili.js';
import {makeEnvelope,backendFetch} from '../src/transport.js';

const target=(keyword='private-keyword',stamp='1')=>new URL('https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword='+keyword+'&wts='+stamp+'&w_rid=signature');
const value=(status=200,body={code:0,data:{result:[]}})=>{const payload=Buffer.from(JSON.stringify(body));return {status,payload,signals:responseSignals(status,'application/json',payload)};};

test('searches serialize, share identical in-flight queries, isolate sessions and expire cached results',async()=>{
  let time=1000,calls=0,active=0,maximum=0;const starts=[];
  const policy=createSearchPolicy({clock:()=>time,delay:async ms=>{time+=ms;}});
  const load=async()=>{active++;maximum=Math.max(maximum,active);starts.push(time);calls++;await new Promise(resolve=>setImmediate(resolve));active--;return value();};
  const [a,b,c]=await Promise.all([policy.run(target('a'),{cookie:'SESSDATA=one'},load),policy.run(target('a','2'),{cookie:'SESSDATA=one'},load),policy.run(target('b'),{cookie:'SESSDATA=one'},load)]);
  assert.equal(calls,2);assert.equal(maximum,1);assert.equal(b.cacheStatus,'shared');assert.equal(c.cacheStatus,'miss');assert.ok(starts[1]-starts[0]>=2000);
  assert.equal((await policy.run(target('a','3'),{cookie:'SESSDATA=one'},load)).cacheStatus,'hit');assert.equal(calls,2);
  await policy.run(target('a'),{cookie:'SESSDATA=another'},load);assert.equal(calls,3);
  time+=120001;await policy.run(target('a'),{cookie:'SESSDATA=one'},load);assert.equal(calls,4);
});

test('a risk response stops queued searches without upstream retries and blocks cache during cooldown',async()=>{
  let time=1000,calls=0;const policy=createSearchPolicy({clock:()=>time,delay:async ms=>{time+=ms;}});
  const blocked=async()=>{calls++;return value(412,{code:-412,message:'blocked'});};
  const results=await Promise.allSettled([policy.run(target('a'),{},blocked),policy.run(target('b'),{},blocked)]);
  assert.equal(results[0].value.status,412);assert.equal(results[1].reason.code,'BACKEND_SEARCH_COOLDOWN');assert.equal(calls,1);
  await assert.rejects(()=>policy.run(target('a'),{},blocked),{code:'BACKEND_SEARCH_COOLDOWN'});assert.equal(calls,1);
  time+=120001;await policy.run(target('a'),{},async()=>{calls++;return value();});assert.equal(calls,2);
});

test('HTTP 200 verification challenges are risk responses, never empty successful searches',()=>{
  const v=value(200,{code:0,data:{v_voucher:'private-verification-token'}});
  assert.equal(v.signals.risk,true);assert.equal(v.signals.requires_verification,true);
  assert.ok(!JSON.stringify(v.signals).includes('private-verification-token'));
  assert.deepEqual(safeDetails({request_id:'12345678-1234-1234-1234-123456789abc',cookie:'secret',upstream_code:-352}),{request_id:'12345678-1234-1234-1234-123456789abc',upstream_code:-352});
});

test('search uses a signed current endpoint and search-page context without a legacy fallback',async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(input,options)=>{const u=new URL(input);calls.push(u.pathname);
    if(u.pathname.endsWith('/nav'))return Response.json({code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+('a'.repeat(32))+'.png',sub_url:'https://i0.hdslb.com/'+('b'.repeat(32))+'.png'}}});
    assert.equal(u.pathname,'/x/web-interface/wbi/search/type');assert.equal(u.searchParams.get('keyword'),'毕导 科学');assert.match(u.searchParams.get('w_rid'),/^[a-f0-9]{32}$/);assert.match(u.searchParams.get('wts'),/^\d+$/);
    assert.equal(options.headers.origin,'https://search.bilibili.com');assert.match(options.headers.referer,/^https:\/\/search.bilibili.com\/video\?keyword=/);
    return Response.json({code:0,data:{result:[{bvid:'BV17x411w7KC',title:'<em>test</em>',author:'UP',duration:'1:00'}]}});
  };
  try{const result=await search({cookies:{SESSDATA:'test'}},'毕导 科学',4);assert.equal(result.videos[0].title,'test');assert.equal(result.diagnostics.strategy,'wbi');assert.deepEqual(calls,['/x/web-interface/nav','/x/web-interface/wbi/search/type']);}finally{globalThis.fetch=original;}
});

for(const body of [{code:-352,message:'risk'},{code:0,data:{v_voucher:'private-token',result:[]}}])test('search stops on JSON risk '+body.code+' without returning an empty list',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async input=>{calls++;return String(input).includes('/nav')?Response.json({code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+('a'.repeat(32))+'.png',sub_url:'https://i0.hdslb.com/'+('b'.repeat(32))+'.png'}}}):Response.json(body);};
  try{await assert.rejects(()=>search(null,'test',2),{code:'BILI_RISK_CONTROL'});assert.equal(calls,2);}finally{globalThis.fetch=original;}
});

test('signed transport caches searches and emits useful diagnostics without keyword, tokens or response content',async()=>{
  const key='test-search-policy-secret'.padEnd(48,'x'),logs=[];let calls=0;
  const server=createBackend({key,logger:v=>logs.push(v),searchOptions:{intervalMs:0},fetchImpl:async()=>{calls++;return Response.json({code:0,data:{result:[{description:'private-description'}]}});}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  try{
    const options={headers:{cookie:'SESSDATA=private-cookie; buvid3=private-buvid'}};
    const one=await fetch(origin+'/v1/bilibili',await makeEnvelope(target(),options,key));await one.arrayBuffer();assert.equal(one.headers.get('x-bili-cache-status'),'miss');
    const two=await fetch(origin+'/v1/bilibili',await makeEnvelope(target('private-keyword','2'),options,key));await two.arrayBuffer();assert.equal(two.headers.get('x-bili-cache-status'),'hit');assert.equal(calls,1);
    assert.equal(logs[0].status,200);assert.equal(logs[0].upstream_code,0);assert.equal(logs[0].session_present,true);assert.equal(logs[0].buvid3_present,true);
    for(const secret of ['private-cookie','private-buvid','private-keyword','private-description',key])assert.ok(!JSON.stringify(logs).includes(secret));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('transport exposes a local search cooldown as a specific safe error without sending a second request',async()=>{
  const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({error:'BACKEND_SEARCH_COOLDOWN',request_id:'12345678-1234-1234-1234-123456789abc',retry_after_seconds:119},{status:429});
  try{await assert.rejects(()=>backendFetch(target(),{},{url:'https://backend.example.test',key:'test-only-secret'.padEnd(48,'x')}),e=>e.code==='BILI_SEARCH_COOLDOWN'&&e.details.retry_after_seconds===119);}finally{globalThis.fetch=original;}
});
