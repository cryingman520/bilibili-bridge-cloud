import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {actor,saveSession,session,prefix,put,read,secretPut,secretRead,verifyBrowserWrite,csrf} from '../src/platform.js';
import {parseCookies,parseTime,checkedFetch,frames,accountStatus,resolveVideo,videoInfo} from '../src/bilibili.js';
import {prepareAction,approveAction} from '../src/actions.js';
import {deploymentCheck} from '../src/index.js';
import {VERSION} from '../src/platform.js';
import {uploadCover} from '../src/uploads.js';
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
test('video links select the requested part and use its cid and duration',async()=>{
  await mockFetch(async()=>ok({bvid:'BV17x411w7KC',cid:11,duration:1000,pages:[{page:1,cid:11,duration:100,part:'第一节'},{page:2,cid:22,duration:900,part:'第二节'}]}),async()=>{
    const selected=await resolveVideo(null,'https://www.bilibili.com/video/BV17x411w7KC?p=2');assert.equal(selected.cid,22);assert.equal(selected.duration,900);assert.equal(selected.total_duration,1000);assert.equal(videoInfo(selected).url,'https://www.bilibili.com/video/BV17x411w7KC?p=2');
    assert.equal((await resolveVideo(null,'BV17x411w7KC')).duration,100);await assert.rejects(()=>resolveVideo(null,'BV17x411w7KC?p=3'),{code:'INVALID_PART'});
  });
});
test('cover upload validates image bytes, uses account CSRF and returns only the CDN image URL',async()=>{
  const env=makeEnv();await saveSession(env,'owner',credentials);let uploads=0;
  const image=jpeg.encode({data:Buffer.from([255,0,0,255]),width:1,height:1},80).data;
  await mockFetch(async(url,options)=>{uploads++;assert.equal(new URL(url).pathname,'/x/vu/web/cover/up');assert.equal(new URLSearchParams(options.body).get('csrf'),'csrf-secret');assert.match(options.headers.cookie,/session-secret/);return ok({url:'//i0.hdslb.com/bfs/archive/cover.jpg'});},async()=>{
    await assert.rejects(()=>uploadCover(env,'owner',{dataUrl:'data:image/svg+xml;base64,AAAA'}),{code:'INVALID_COVER'});assert.equal(uploads,0);
    const result=await uploadCover(env,'owner',{dataUrl:'data:image/jpeg;base64,'+image.toString('base64')});assert.equal(result.url,'https://i0.hdslb.com/bfs/archive/cover.jpg');assert.equal(uploads,1);assert.ok(!JSON.stringify(result).includes('secret'));
  });
});

test('cloud verification uses the private owner session, reports failures once and logs no account contents',async()=>{
  const env={...makeEnv(),BILI_OWNER_EMAIL:'owner@example.test'};await saveSession(env,'owner',credentials);
  const logs=[],originalLog=console.log;let requests=0;
  console.log=value=>logs.push(value);
  try{await mockFetch(async(url,options)=>{
    requests++;assert.match(options.headers.cookie,/SESSDATA=session-secret/);
    const path=new URL(url).pathname;
    if(path==='/x/web-interface/view')return new Response('{"code":-412}',{status:412});
    if(path==='/x/web-interface/nav')return ok({isLogin:true,mid:123,uname:'private-name',wbi_img:{img_url:'https://i0.hdslb.com/'+('a'.repeat(32))+'.png',sub_url:'https://i0.hdslb.com/'+('b'.repeat(32))+'.png'}});
    if(path==='/x/web/archives')return ok({arc_audits:[]});
    if(path==='/x/space/wbi/acc/info')return ok({mid:123,sign:'private-sign'});
    assert.fail('Unexpected request '+path);
  },async()=>{
    await deploymentCheck(env);const count=requests;await deploymentCheck(env);assert.equal(requests,count);
    const result=await read(env,'system/readiness/'+VERSION+'/sites');
    assert.equal(result.video.error.code,'BILI_RISK_CONTROL');assert.equal(result.account.logged_in,true);assert.equal(result.account.my_videos.retrieved,true);assert.equal(result.account.space.retrieved,true);assert.equal(result.login.credential_present,true);
    const output=logs.join('\n');for(const value of ['session-secret','csrf-secret','private-name','private-sign'])assert.ok(!output.includes(value));
  });}finally{console.log=originalLog;}
});
