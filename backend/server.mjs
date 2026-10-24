import http from 'node:http';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {allowTarget,forwardHeaders,boundedBytes,verifyEnvelope,decodeJson,encodeResponseHeaders,MAX_BODY,MAX_RESPONSE,CLOCK_WINDOW} from '../src/transport.js';
import {bytes} from '../src/platform.js';

// The backend is stateless. Accounts, encrypted credentials and draft locks stay
// in the existing private Sites service and are never written to the host disk.
export function createBackend({key=process.env.BILI_BACKEND_KEY,fetchImpl=fetch,clock=Date.now}={}){
  if(typeof key!=='string'||key.length<40)throw new Error('Set BILI_BACKEND_KEY to at least 32 random bytes encoded as base64url.');
  const nonces=new Map();let active=0;
  return http.createServer({maxHeaderSize:32768,requestTimeout:95000,headersTimeout:15000},async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
    if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true,service:'bilibili-backend',version:1,stateless:true});
    if(req.method!=='POST'||req.url!=='/v1/bilibili')return send(404,{error:'NOT_FOUND'});
    const stamp=clock();
    for(const [nonce,expires]of nonces)if(expires<stamp)nonces.delete(nonce);
    const h=req.headers,meta={time:h['x-bili-time'],nonce:h['x-bili-nonce'],method:h['x-bili-method'],headers:h['x-bili-headers']};
    // All malformed or unauthenticated requests fail without calling Bilibili.
    if(!/^\d{13}$/.test(meta.time||'')||Math.abs(stamp-Number(meta.time))>CLOCK_WINDOW||! /^[a-f0-9-]{36}$/.test(meta.nonce||'')||typeof h['x-bili-target']!=='string'||typeof meta.headers!=='string'||typeof h['x-bili-signature']!=='string')return send(401,{error:'AUTH_REQUIRED'});
    if(nonces.has(meta.nonce))return send(409,{error:'REPLAY_REJECTED'});
    let slot=false;
    try{
      meta.url=new TextDecoder().decode(bytes(h['x-bili-target']));
      if(Number(req.headers['content-length'])>MAX_BODY)return send(413,{error:'BODY_TOO_LARGE'});
      // Bound work even before authentication; never buffer unlimited uploads.
      if(active>=4)return send(503,{error:'BACKEND_BUSY'});
      active++;slot=true;
      const body=await boundedBytes(Readable.toWeb(req),MAX_BODY);
      if(!await verifyEnvelope(key,meta,body,h['x-bili-signature']))return send(401,{error:'AUTH_FAILED'});
      // Synchronous reservation after verification prevents concurrent replay.
      if(nonces.has(meta.nonce))return send(409,{error:'REPLAY_REJECTED'});
      nonces.set(meta.nonce,Number(meta.time)+CLOCK_WINDOW);
      const target=allowTarget(meta.url,meta.method),headers=forwardHeaders(decodeJson(meta.headers),target);
      if(meta.method==='GET'&&body.length)return send(400,{error:'GET_BODY_REJECTED'});
      const upstream=await fetchImpl(target,{method:meta.method,headers,body:meta.method==='GET'?undefined:body,redirect:'manual',signal:AbortSignal.timeout(25000)});
      // Redirects and 412/429 are returned once, without following or retrying.
      const payload=await boundedBytes(upstream.body,MAX_RESPONSE);
      res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff','x-bili-relay':'1','x-bili-status':String(upstream.status),'x-bili-response-headers':encodeResponseHeaders(upstream)});
      res.end(payload);
    }catch(e){
      if(!res.headersSent)send(e.status===413?413:e.code?.startsWith('BACKEND_')?400:502,{error:e.code?.startsWith('BACKEND_')?e.code:'UPSTREAM_UNAVAILABLE'});
      else res.end();
    }finally{if(slot)active--;}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const port=Number(process.env.PORT||10000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT is invalid.');
  const server=createBackend();
  server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'backend.listening',port})));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),10000).unref();});
}
