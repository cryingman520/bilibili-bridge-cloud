import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {actor,saveSession,session,prefix,put,read,secretPut,secretRead,verifyBrowserWrite,csrf} from '../src/platform.js';
import {parseCookies,parseTime,checkedFetch,frames,accountStatus} from '../src/bilibili.js';
import {prepareAction,approveAction} from '../src/actions.js';
import jpeg from 'jpeg-js';

class MemoryBucket {
  map=new Map(); revision=0;
  async get(k){const x=this.map.get(k);if(!x)return null;return {etag:x.etag,json:async()=>JSON.parse(x.value)};}
  async put(k,value,options={}){if(options.onlyIf?.etagMatches&&this.map.get(k)?.etag!==options.onlyIf.etagMatches)return null;const etag=String(++this.revision);this.map.set(k,{value,etag});return {etag};}
  async delete(k){this.map.delete(k);}
  async list({prefix}){return {objects:[...this.map.keys()].filter(x=>x.startsWith(prefix)).map(key=>({key,uploaded:new Date()}))};}
}
const makeEnv=()=>({BUCKET:new MemoryBucket(),BILI_CREDENTIAL_KEY:Buffer.alloc(32,9).toString('base64')});
const credentials={cookies:{SESSDATA:'session-secret',bili_jct:'csrf-secret'},mid:123,name:'测试用户'};
async function mockFetch(fn,run){const previous=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=previous;}}
const ok=data=>new Response(JSON.stringify({code:0,data}),{headers:{'content-type':'application/json'}});
test('verified owner identity is consistent across browser and MCP surfaces',()=>{
  const env={BILI_OWNER_EMAIL:'owner@example.test',BILI_OWNER_ACCOUNT_ID:'platform-owner'};
  assert.equal(actor(new Request('https://site.test',{headers:{'oai-authenticated-user-email':'owner@example.test'}}),true,env),'owner');
  assert.equal(actor(new Request('https://site.test',{headers:{'oai-authenticated-user-id':'site-scoped-id','oai-authenticated-user-email':'OWNER@example.test'}}),true,env),'owner');
  assert.throws(()=>actor(new Request('https://site.test',{headers:{'oai-authenticated-user-email':'another@example.test'}}),true,env),{code:'OWNER_ONLY'});
  assert.throws(()=>actor(new Request('https://site.test'),true,env),{code:'SIGN_IN_REQUIRED'});
});

test('credentials are encrypted at rest and isolated by platform user',async()=>{
  const env=makeEnv();await saveSession(env,'owner',credentials);
  assert.equal((await session(env,'owner')).cookies.SESSDATA,'session-secret');
  assert.equal(await session(env,'another'),null);
  const raw=[...env.BUCKET.map.values()].map(x=>x.value).join('');assert.ok(!raw.includes('session-secret'));assert.ok(!raw.includes('csrf-secret'));
  const key=await prefix('owner','auth')+'session';await assert.rejects(()=>secretRead(env,'another',key),{code:'CREDENTIAL_READ_FAILED'});
});
test('browser writes require both platform identity and same-origin CSRF',async()=>{
  const env=makeEnv(),id='owner',token=await csrf(env,id);
  const req=(origin,csrfValue)=>new Request('https://site.test/api/drafts/x/approve',{method:'POST',headers:{'oai-authenticated-user-id':id,origin,'x-csrf-token':csrfValue}});
  assert.equal(await verifyBrowserWrite(req('https://site.test',token),env),id);
  await assert.rejects(()=>verifyBrowserWrite(req('https://attacker.test',token),env),{code:'BAD_ORIGIN'});
  await assert.rejects(()=>verifyBrowserWrite(req('https://site.test','wrong'),env),{code:'CSRF_REJECTED'});
  await assert.rejects(()=>verifyBrowserWrite(new Request('https://site.test',{method:'POST'}),env),{code:'SIGN_IN_REQUIRED'});
});
test('creating a comment draft performs no publication; confirmation executes once',async()=>{
  const env=makeEnv();await saveSession(env,'owner',credentials);const calls=[];
  await mockFetch(async (url,opts={})=>{calls.push({url:String(url),method:opts.method||'GET'});if(opts.method==='POST'){assert.equal(new URLSearchParams(opts.body).get('message'),'hello');return ok({rpid_str:'456'});}return ok({bvid:'BV17x411w7KC',aid:42,cid:9,title:'视频',duration:10});},async()=>{
    const draft=await prepareAction(env,'owner','comment.create',{url:'BV17x411w7KC',message:'hello'},'https://site.test');
    assert.equal(draft.status,'pending');assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
    await assert.rejects(()=>approveAction(env,'another',draft.id),{code:'NOT_FOUND'});
    const sent=await approveAction(env,'owner',draft.id);assert.equal(sent.draft.status,'completed');
    await assert.rejects(()=>approveAction(env,'owner',draft.id),{code:'ALREADY_HANDLED'});
    assert.equal(calls.filter(x=>x.method==='POST').length,1);
  });
});
test('ambiguous upstream failure is preserved and never automatically replayed',async()=>{
  const env=makeEnv();await saveSession(env,'owner',credentials);
  const draft=await prepareAction(env,'owner','profile.update',{sign:'new sign'},'https://site.test');let posts=0;
  await mockFetch(async()=>{posts++;throw new TypeError('connection closed');},async()=>{
    await assert.rejects(()=>approveAction(env,'owner',draft.id));
    assert.equal((await read(env,await prefix('owner','drafts')+draft.id)).status,'needs_verification');
    await assert.rejects(()=>approveAction(env,'owner',draft.id),{code:'ALREADY_HANDLED'});assert.equal(posts,1);
  });
});
test('account change invalidates previously prepared actions',async()=>{
  const env=makeEnv();await saveSession(env,'owner',credentials);
  const draft=await prepareAction(env,'owner','dynamic.publish',{text:'hello'},'https://site.test');
  await saveSession(env,'owner',{...credentials,mid:999});
  await assert.rejects(()=>approveAction(env,'owner',draft.id),{code:'ACCOUNT_CHANGED'});
});
test('QR credentials accept only official Bilibili redirect domains',()=>{
  const response=new Response('');
  assert.deepEqual(parseCookies(response,'https://evil.test/?SESSDATA=steal&bili_jct=x'),{});
  assert.deepEqual(parseCookies(response,'https://passport.bilibili.com/crossDomain?SESSDATA=good&bili_jct=csrf&DedeUserID=42'),{SESSDATA:'good',bili_jct:'csrf',DedeUserID:'42'});
});
test('risk-control responses stop immediately with actionable error',async()=>{
  let n=0;await mockFetch(async()=>{n++;return new Response('blocked',{status:412});},async()=>{
    await assert.rejects(()=>checkedFetch('https://api.bilibili.com/test'),{code:'BILI_RISK_CONTROL'});assert.equal(n,1);
  });
});
test('outbound requests use Workers-compatible manual redirects without following challenges',async()=>{
  await mockFetch(async (url,options)=>{assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{location:'https://untrusted.test'}});},async()=>{
    await assert.rejects(()=>checkedFetch('https://api.bilibili.com/test'),{code:'BILI_REDIRECT'});
  });
});
test('video-shot sampling maps first real index to first sprite cell',async()=>{
  const pixels=Buffer.from([255,0,0,255,0,255,0,255]);const image=jpeg.encode({data:pixels,width:2,height:1},100).data;
  await mockFetch(async u=>String(u).includes('/videoshot')?ok({index:[0,0,7],image:['https://i0.hdslb.com/test.jpg'],img_x_len:2,img_y_len:1,img_x_size:1,img_y_size:1}):new Response(image),async()=>{
    const f=await frames(null,{bvid:'BV17x411w7KC',cid:9,duration:9},['7'],1);
    assert.equal(f.frames[0].time,7);const out=jpeg.decode(Buffer.from(f.content[1].data,'base64'));assert.ok(out.data[1]>out.data[0]);
  });
});
test('login status never returns credential material',async()=>{
  const env=makeEnv();await saveSession(env,'owner',credentials);
  await mockFetch(async()=>ok({isLogin:true,mid:123,uname:'测试用户'}),async()=>{
    const output=JSON.stringify(await accountStatus(env,'owner'));assert.ok(!output.includes('session-secret'));assert.ok(!output.includes('csrf-secret'));assert.ok(output.includes('测试用户'));
  });
});
test('video time parser rejects malformed or nonfinite inputs',()=>{
  assert.equal(parseTime('01:02:03'),3723);assert.equal(parseTime('8.5'),8.5);assert.throws(()=>parseTime(Infinity));assert.throws(()=>parseTime('junk'));
});
