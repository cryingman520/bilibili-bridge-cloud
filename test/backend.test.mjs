import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createBackend} from '../backend/server.mjs';
import {makeEnvelope,backendFetch,allowTarget,forwardHeaders,boundedBytes,decodeJson} from '../src/transport.js';
import {networkSession} from '../src/platform.js';
import {checkedFetch,startLogin,pollLogin} from '../src/bilibili.js';
import {PNG} from 'pngjs';
import jpeg from 'jpeg-js';
const key='test-only-backend-secret-'.padEnd(48,'x');
const nativeFetch=globalThis.fetch;
async function withBackend(fetchImpl,run,options={}){
  const server=createBackend({key,fetchImpl,logger:()=>{},...options});server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  try{await run(origin);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('unsigned, tampered and replayed backend requests cannot reach Bilibili',async()=>{
  let calls=0;
  await withBackend(async()=>{calls++;return new Response('{"code":0}');},async origin=>{
    assert.equal((await nativeFetch(origin+'/v1/bilibili',{method:'POST'})).status,401);
    const envelope=await makeEnvelope('https://api.bilibili.com/x/v2/reply/add',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie:'SESSDATA=test'},body:'message=approved'},key);
    assert.equal((await nativeFetch(origin+'/v1/bilibili',{...envelope,body:'message=tampered'})).status,401);
    assert.equal((await nativeFetch(origin+'/v1/bilibili',{...envelope,headers:{...envelope.headers,'x-bili-target':Buffer.from('https://api.bilibili.com/x/v2/dm/post').toString('base64')}})).status,401);
    assert.equal((await nativeFetch(origin+'/v1/bilibili',envelope)).status,200);
    assert.equal((await nativeFetch(origin+'/v1/bilibili',envelope)).status,409);
    assert.equal(calls,1);
  });
});
test('old signed requests expire without being forwarded',async()=>{
  await withBackend(async()=>{assert.fail('must not call upstream');},async origin=>{
    const envelope=await makeEnvelope('https://api.bilibili.com/x/web-interface/view',{},key);
    assert.equal((await nativeFetch(origin+'/v1/bilibili',envelope)).status,401);
  },{clock:()=>Date.now()+100000});
});
test('concurrent signed requests are queued with four upstream slots and no replay',async()=>{
  let active=0,maximum=0,calls=0;
  await withBackend(async()=>{active++;maximum=Math.max(maximum,active);calls++;await new Promise(resolve=>setTimeout(resolve,30));active--;return Response.json({code:0});},async origin=>{
    const requests=await Promise.all(Array.from({length:8},()=>makeEnvelope('https://api.bilibili.com/x/web-interface/view',{},key)));
    const responses=await Promise.all(requests.map(envelope=>nativeFetch(origin+'/v1/bilibili',envelope)));
    assert.ok(responses.every(r=>r.status===200));assert.equal(calls,8);assert.equal(maximum,4);
    await Promise.all(responses.map(r=>r.arrayBuffer()));
  });
});
test('backend only permits implemented Bilibili interfaces and public assets',()=>{
  for(const url of ['https://example.com/test','https://127.0.0.1/test','http://api.bilibili.com/x/web-interface/view','https://api.bilibili.com:8443/x/web-interface/view','https://api.bilibili.com/unimplemented','https://api.bilibili.com@evil.test/x/web-interface/view','https://foo.hdslb.com.evil.test/x.jpg'])assert.throws(()=>allowTarget(url));
  assert.throws(()=>allowTarget('https://api.bilibili.com/x/web-interface/view','POST'));
  assert.equal(allowTarget('https://i0.hdslb.com/bfs/videoshot/example.jpg').hostname,'i0.hdslb.com');
  assert.equal(allowTarget('https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/track?auth_key=test').hostname,'aisubtitle.hdslb.com');
  assert.equal(allowTarget('https://upos-sz-upcdnws.bilivideo.com/ugcupos/test.mp4?uploadId=1','PUT').protocol,'https:');
  assert.deepEqual(forwardHeaders({cookie:'secret','x-upos-auth':'secret',accept:'image/jpeg'},new URL('https://i0.hdslb.com/x.jpg')),{accept:'image/jpeg'});
  assert.throws(()=>forwardHeaders({'x-arbitrary':'bad'},new URL('https://api.bilibili.com')));
});
test('signed cloud frame requests crop real PNG pixels and bind crop coordinates to the signature',async()=>{
  const png=new PNG({width:2,height:1});png.data.set([255,0,0,255,0,255,0,255]);const source=PNG.sync.write(png);let calls=0;
  await withBackend(async()=>{calls++;return new Response(source,{headers:{'content-type':'image/png'}});},async origin=>{
    const options={frameCrop:{x:1,y:0,width:1,height:1}},envelope=await makeEnvelope('https://i0.hdslb.com/bfs/videoshot/source.png',options,key);
    assert.equal((await nativeFetch(origin+'/v1/bilibili',{...envelope,headers:{...envelope.headers,'x-bili-crop':Buffer.from(JSON.stringify({x:0,y:0,width:1,height:1})).toString('base64')}})).status,401);
    const response=await nativeFetch(origin+'/v1/bilibili',envelope);assert.equal(response.status,200);
    const cropped=jpeg.decode(Buffer.from(await response.arrayBuffer()));assert.equal(cropped.width,1);assert.equal(cropped.height,1);assert.ok(cropped.data[1]>cropped.data[0]);assert.equal(calls,1);
  });
});
test('binary upload bytes and QR response cookies survive authenticated transport',async()=>{
  const payload=new Uint8Array([0,255,10,128,99]);
  await withBackend(async(url,opts)=>{
    assert.equal(opts.redirect,'manual');assert.equal(opts.method,'PUT');assert.deepEqual(opts.body,payload);assert.equal(opts.headers['x-upos-auth'],'upos-token');
    const r=new Response(payload,{status:201,headers:{'content-type':'application/octet-stream'}});r.headers.append('set-cookie','SESSDATA=test; Secure');r.headers.append('set-cookie','bili_jct=csrf; Secure');return r;
  },async origin=>{
    globalThis.fetch=(url,opts)=>nativeFetch(String(url).replace('https://backend.example.test',origin),opts);
    try{
      const r=await backendFetch('https://upos-sz-upcdnws.bilivideo.com/ugcupos/test.mp4?uploadId=1',{method:'PUT',headers:{'x-upos-auth':'upos-token'},body:payload},{url:'https://backend.example.test',key});
      assert.equal(r.status,201);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),payload);assert.equal(r.headers.getSetCookie().length,2);
    }finally{globalThis.fetch=nativeFetch;}
  });
});
test('remote risk-control status stops once without fallback to Sites network',async()=>{
  let calls=0;
  await withBackend(async()=>{calls++;return new Response('risk',{status:412});},async origin=>{
    globalThis.fetch=(url,opts)=>nativeFetch(String(url).replace('https://backend.example.test',origin),opts);
    try{await assert.rejects(()=>checkedFetch('https://api.bilibili.com/x/web-interface/view',{}, {url:'https://backend.example.test',key}),{code:'BILI_RISK_CONTROL'});assert.equal(calls,1);}finally{globalThis.fetch=nativeFetch;}
  });
});
test('configured backend does not become a stored credential or a logged-in account',()=>{
  const context=networkSession({BILI_BACKEND_URL:'https://backend.example.test',BILI_BACKEND_KEY:key});
  assert.equal(context.backend.key,key);assert.equal(context.cookies,undefined);assert.equal(JSON.stringify(context),'{}');
});
test('request and response buffers enforce a fixed limit',async()=>{
  await assert.rejects(()=>boundedBytes(new Response('12345').body,4),{code:'BACKEND_BODY_TOO_LARGE'});
});
test('QR generation and polling use the same hosted backend without leaking credentials',async()=>{
  const records=new Map(),env={BILI_BACKEND_URL:'https://backend.example.test',BILI_BACKEND_KEY:key,BILI_CREDENTIAL_KEY:Buffer.alloc(32,8).toString('base64'),BUCKET:{async get(k){const value=records.get(k);return value?{json:async()=>JSON.parse(value)}:null;},async put(k,v){records.set(k,v);},async delete(k){records.delete(k);}}};
  const paths=[];
  await withBackend(async(url)=>{
    paths.push(url.pathname);
    if(url.pathname.endsWith('/generate'))return Response.json({code:0,data:{url:'https://passport.bilibili.com/test-qr',qrcode_key:'qr-private'}});
    if(url.pathname.endsWith('/poll')){const r=Response.json({code:0,data:{code:0,url:'https://passport.bilibili.com/crossDomain'}});r.headers.append('set-cookie','SESSDATA=session-test; Secure');r.headers.append('set-cookie','bili_jct=csrf-test; Secure');return r;}
    return Response.json({code:0,data:{isLogin:true,mid:42,uname:'QR user'}});
  },async origin=>{
    globalThis.fetch=(url,opts)=>nativeFetch(String(url).replace('https://backend.example.test',origin),opts);
    try{
      const login=await startLogin(env,'owner');assert.match(login.svg,/<svg/);
      const result=await pollLogin(env,'owner',login.id);assert.equal(result.status,'success');assert.equal(result.account.mid,42);
      const output=JSON.stringify(result);for(const secret of ['session-test','csrf-test',key])assert.ok(!output.includes(secret));
      const atRest=[...records.values()].join('');for(const secret of ['session-test','csrf-test',key])assert.ok(!atRest.includes(secret));
      assert.deepEqual(paths,['/x/passport-login/web/qrcode/generate','/x/passport-login/web/qrcode/poll','/x/web-interface/nav']);
    }finally{globalThis.fetch=nativeFetch;}
  });
});
