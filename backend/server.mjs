import http from 'node:http';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {allowTarget,forwardHeaders,boundedBytes,verifyEnvelope,decodeJson,encodeResponseHeaders,MAX_BODY,MAX_RESPONSE,CLOCK_WINDOW} from '../src/transport.js';
import {bytes,fail,VERSION} from '../src/platform.js';
import {responseSignals,cookiePresence} from '../src/diagnostics.js';
import {createSearchPolicy,isSearch} from './search-policy.mjs';
import {cropFrame} from './frame.mjs';

// The backend is stateless. Accounts, encrypted credentials and draft locks stay
// in the existing private Sites service and are never written to the host disk.
export function createBackend({key=process.env.BILI_BACKEND_KEY,fetchImpl=fetch,clock=Date.now,logger=value=>console.log(JSON.stringify(value)),searchOptions={}}={}){
  if(typeof key!=='string'||key.length<40)throw new Error('Set BILI_BACKEND_KEY to at least 32 random bytes encoded as base64url.');
  const nonces=new Map(),waiters=[],searchPolicy=createSearchPolicy({clock,...searchOptions});let active=0,incoming=0;
  const acquire=()=>{
    if(active<4){active++;return Promise.resolve();}
    if(waiters.length>=8)fail('BACKEND_BUSY','后端正在处理其他请求',503);
    return new Promise((resolve,reject)=>{const waiter={resolve,timer:null};waiter.timer=setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);const e=new Error('Backend queue timed out');e.code='BACKEND_BUSY';e.status=503;reject(e);},15000);waiter.timer.unref();waiters.push(waiter);});
  };
  const release=()=>{const next=waiters.shift();if(next){clearTimeout(next.timer);next.resolve();}else active--;};
  return http.createServer({maxHeaderSize:32768,requestTimeout:95000,headersTimeout:15000},async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
    if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true,service:'bilibili-backend',version:VERSION,stateless:true});
    if(req.method!=='POST'||req.url!=='/v1/bilibili')return send(404,{error:'NOT_FOUND'});
    const stamp=clock();
    for(const [nonce,expires]of nonces)if(expires<stamp)nonces.delete(nonce);
    const h=req.headers,meta={time:h['x-bili-time'],nonce:h['x-bili-nonce'],method:h['x-bili-method'],headers:h['x-bili-headers']};
    if(h['x-bili-operation']){meta.operation=h['x-bili-operation'];meta.crop=h['x-bili-crop']||'';}
    // All malformed or unauthenticated requests fail without calling Bilibili.
    if(!/^\d{13}$/.test(meta.time||'')||Math.abs(stamp-Number(meta.time))>CLOCK_WINDOW||! /^[a-f0-9-]{36}$/.test(meta.nonce||'')||typeof h['x-bili-target']!=='string'||typeof meta.headers!=='string'||typeof h['x-bili-signature']!=='string')return send(401,{error:'AUTH_REQUIRED'});
    if(nonces.has(meta.nonce))return send(409,{error:'REPLAY_REJECTED'});
    let admitted=false,path='';
    try{
      meta.url=new TextDecoder().decode(bytes(h['x-bili-target']));
      if(Number(req.headers['content-length'])>MAX_BODY)return send(413,{error:'BODY_TOO_LARGE'});
      // Bound work even before authentication; never buffer unlimited uploads.
      if(incoming>=12)return send(503,{error:'BACKEND_BUSY'});
      incoming++;admitted=true;
      const body=await boundedBytes(Readable.toWeb(req),MAX_BODY);
      if(!await verifyEnvelope(key,meta,body,h['x-bili-signature']))return send(401,{error:'AUTH_FAILED'});
      // Synchronous reservation after verification prevents concurrent replay.
      if(nonces.has(meta.nonce))return send(409,{error:'REPLAY_REJECTED'});
      nonces.set(meta.nonce,Number(meta.time)+CLOCK_WINDOW);
      const target=allowTarget(meta.url,meta.method),headers=forwardHeaders(decodeJson(meta.headers),target);
      path=target.pathname;
      if(meta.method==='GET'&&body.length)return send(400,{error:'GET_BODY_REJECTED'});
      if(meta.operation&&(meta.operation!=='frame'||meta.method!=='GET'||!target.hostname.endsWith('.hdslb.com')))return send(400,{error:'BACKEND_FRAME_INPUT'});
      const load=async()=>{
        await acquire();const started=clock();
        try{
          const upstream=await fetchImpl(target,{method:meta.method,headers,body:meta.method==='GET'?undefined:body,redirect:'manual',signal:AbortSignal.timeout(25000)});
          // Redirects, validation challenges and risk responses are never retried.
          let payload=await boundedBytes(upstream.body,MAX_RESPONSE),responseHeaders=encodeResponseHeaders(upstream);
          const signals=responseSignals(upstream.status,upstream.headers.get('content-type'),payload);
          if(meta.operation==='frame'&&upstream.ok){payload=cropFrame(payload,decodeJson(meta.crop));responseHeaders=encodeResponseHeaders(new Response(null,{headers:{'content-type':'image/jpeg'}}));}
          if(isSearch(target)||signals.risk||!upstream.ok)logger({event:'backend.upstream',at:new Date(clock()).toISOString(),request_id:meta.nonce,method:meta.method,path,status:upstream.status,...signals,...cookiePresence(headers.cookie),elapsed_ms:clock()-started});
          return {status:upstream.status,payload,responseHeaders,signals,retryAfter:upstream.headers.get('retry-after'),requestId:meta.nonce,fetchedAt:new Date(clock()).toISOString()};
        }finally{release();}
      };
      const value=isSearch(target)?await searchPolicy.run(target,headers,load):await load();
      if(value.cacheStatus&&value.cacheStatus!=='miss')logger({event:'backend.search-cache',at:new Date(clock()).toISOString(),request_id:meta.nonce,cache_status:value.cacheStatus});
      res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff','x-bili-relay':'1','x-bili-status':String(value.status),'x-bili-response-headers':value.responseHeaders,'x-bili-request-id':value.requestId,'x-bili-upstream-code':String(value.signals.upstream_code??''),'x-bili-requires-verification':String(value.signals.requires_verification),'x-bili-cache-status':value.cacheStatus||'none','x-bili-fetched-at':value.fetchedAt});
      res.end(value.payload);
    }catch(e){
      logger({event:'backend.error',at:new Date(clock()).toISOString(),request_id:meta.nonce,path,error:e.code?.startsWith('BACKEND_')?e.code:'UPSTREAM_UNAVAILABLE'});
      if(!res.headersSent)send(e.code?.startsWith('BACKEND_')?(e.status||400):502,{error:e.code?.startsWith('BACKEND_')?e.code:'UPSTREAM_UNAVAILABLE',request_id:meta.nonce,...(e.retryAfter?{retry_after_seconds:e.retryAfter}:{})});
      else res.end();
    }finally{if(admitted)incoming--;}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const port=Number(process.env.PORT||10000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT is invalid.');
  const server=createBackend();
  server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'backend.listening',port})));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),10000).unref();});
}
