// Dedicated, authenticated Bilibili transport shared by Sites and the Node host.
// No host rotation, challenge handling, or automatic request replay.
import {fail,base64,bytes} from './platform.js';

export const MAX_BODY=17*1024*1024;
export const MAX_RESPONSE=17*1024*1024;
export const CLOCK_WINDOW=90000;
const encoder=new TextEncoder();
const API_PATHS={
  'api.bilibili.com':{
    GET:new Set(['/x/web-interface/nav','/x/web-interface/view','/x/player/wbi/v2','/x/player/v2','/x/v2/reply','/x/v1/dm/list.so','/x/player/videoshot','/x/web-interface/search/type','/x/space/wbi/acc/info']),
    POST:new Set(['/x/v2/reply/add','/x/v2/dm/post','/x/member/web/sign/update','/x/space/notice/set','/x/dynamic/feed/create/dyn'])
  },
  'passport.bilibili.com':{GET:new Set(['/x/passport-login/web/qrcode/generate','/x/passport-login/web/qrcode/poll'])},
  'member.bilibili.com':{GET:new Set(['/preupload','/x/web/archives','/x/web/archive/view']),POST:new Set(['/x/vu/web/add/v3','/x/vu/web/edit','/x/vu/web/cover/up'])}
};
export function allowTarget(input,method='GET'){
  let u;try{u=new URL(input);}catch{fail('BACKEND_TARGET_REJECTED','后端请求地址无效',400);}
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||u.href.length>6000)fail('BACKEND_TARGET_REJECTED','后端只接受已支持的 B站 HTTPS 接口',400);
  const api=API_PATHS[u.hostname];
  if(api){if(!api[method]?.has(u.pathname))fail('BACKEND_TARGET_REJECTED','后端未开放此 B站接口或请求方法',400);return u;}
  // Public subtitle and timeline image assets, with no credentials forwarded.
  if(method==='GET'&&/^(?:[a-z0-9-]+\.)+hdslb\.com$/.test(u.hostname)&&/\.(?:jpe?g|png|webp|json)$/i.test(u.pathname))return u;
  // UPOS hosts are returned by Bilibili's authenticated preupload endpoint.
  if(['PUT','POST'].includes(method)&&/^upos-[a-z0-9-]+\.(?:bilivideo\.(?:com|cn)|bilibili\.com)$/.test(u.hostname)&&u.pathname.length>1)return u;
  fail('BACKEND_TARGET_REJECTED','后端未开放此资源域名；不会转发到任意网站',400);
}
const HEADER_ALLOW=new Set(['user-agent','referer','origin','accept','content-type','cookie','x-upos-auth']);
export function forwardHeaders(input,u){
  const headers={};
  for(const [key,value]of new Headers(input||{})){
    if(!HEADER_ALLOW.has(key)||value.length>10000)fail('BACKEND_HEADERS_REJECTED','后端请求头不受支持',400);
    // Never forward account cookies to public media hosts.
    if((key==='cookie'||key==='x-upos-auth')&&!API_PATHS[u.hostname]&&!u.hostname.startsWith('upos-'))continue;
    headers[key]=value;
  }
  return headers;
}
export async function boundedBytes(stream,max=MAX_BODY){
  if(!stream)return new Uint8Array();
  const reader=stream.getReader(),parts=[];let length=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();fail('BACKEND_BODY_TOO_LARGE','云端请求或响应超过分块上限',413);}parts.push(value);}}
  finally{reader.releaseLock();}
  const output=new Uint8Array(length);let offset=0;for(const part of parts){output.set(part,offset);offset+=part.byteLength;}return output;
}
const encodeJson=value=>base64(encoder.encode(JSON.stringify(value)));
export function decodeJson(value){try{return JSON.parse(new TextDecoder().decode(bytes(value)));}catch{fail('BACKEND_ENVELOPE_INVALID','后端请求格式无效',400);}}
async function digest(value){return base64(new Uint8Array(await crypto.subtle.digest('SHA-256',value)));}
async function signingData(meta,body){return encoder.encode(['bili-backend-v1',meta.time,meta.nonce,meta.method,meta.url,await digest(encoder.encode(meta.headers)),await digest(body)].join('\n'));}
async function importKey(secret,usage){if(typeof secret!=='string'||secret.length<40)fail('BACKEND_KEY_INVALID','云端后端密钥未正确配置',503);return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,usage);}
export async function signEnvelope(secret,meta,body){return base64(new Uint8Array(await crypto.subtle.sign('HMAC',await importKey(secret,['sign']),await signingData(meta,body))));}
export async function verifyEnvelope(secret,meta,body,signature){
  let sig;try{sig=bytes(signature);}catch{return false;}
  return crypto.subtle.verify('HMAC',await importKey(secret,['verify']),sig,await signingData(meta,body));
}
export function backendOrigin(value){
  let u;try{u=new URL(value);}catch{fail('BACKEND_CONFIG_INVALID','云端后端地址未正确配置',503);}
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.hostname==='localhost'||u.hostname.includes(':')||/^\d+(?:\.\d+){3}$/.test(u.hostname))fail('BACKEND_CONFIG_INVALID','云端后端需使用固定的 HTTPS 域名',503);
  return u.origin;
}
export async function makeEnvelope(url,options={},key){
  const method=(options.method||'GET').toUpperCase(),target=allowTarget(url,method),headers=forwardHeaders(options.headers,target);
  const body=await boundedBytes(new Response(options.body??null).body);
  if(method==='GET'&&body.length)fail('BACKEND_BODY_INVALID','读取请求不能携带正文',400);
  const meta={time:String(Date.now()),nonce:crypto.randomUUID(),method,url:target.href,headers:encodeJson(headers)};
  const signed=await signEnvelope(key,meta,body);
  return {method:'POST',headers:{'content-type':'application/octet-stream','x-bili-time':meta.time,'x-bili-nonce':meta.nonce,'x-bili-method':method,'x-bili-target':base64(encoder.encode(meta.url)),'x-bili-headers':meta.headers,'x-bili-signature':signed},body};
}
export async function backendFetch(url,options,backend){
  const origin=backendOrigin(backend.url),envelope=await makeEnvelope(url,options,backend.key);
  let response;
  try{response=await fetch(origin+'/v1/bilibili',{...envelope,redirect:'manual',signal:AbortSignal.timeout(85000)});}
  catch{fail('BILI_BACKEND_UNAVAILABLE','云端后端暂时未响应。免费实例可能正在唤醒，请稍后手动重试；发送操作请先核实结果。',503);}
  if(!response.ok||response.headers.get('x-bili-relay')!=='1'){
    await response.body?.cancel();
    fail(response.status===401?'BILI_BACKEND_AUTH_FAILED':'BILI_BACKEND_UNAVAILABLE',response.status===401?'云端后端鉴权未通过，请检查两端密钥配置。':'云端后端尚未就绪或正在唤醒，请稍后再试。',503);
  }
  const status=Number(response.headers.get('x-bili-status'));
  if(!Number.isInteger(status)||status<200||status>599){await response.body?.cancel();fail('BILI_BACKEND_BAD_RESPONSE','云端后端返回格式无效',502);}
  const values=decodeJson(response.headers.get('x-bili-response-headers')||''),out=new Headers();
  for(const key of ['content-type','set-cookie'])for(const value of Array.isArray(values[key])?values[key]:[])out.append(key,value);
  return new Response([204,205,304].includes(status)?null:response.body,{status,headers:out});
}
export function encodeResponseHeaders(response){
  const values={'content-type':[response.headers.get('content-type')||'application/octet-stream'],'set-cookie':response.headers.getSetCookie?.()||[]};
  return encodeJson(values);
}
