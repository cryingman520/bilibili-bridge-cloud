import {safeDetails} from './diagnostics.js';
export const VERSION = '3.1.3';
export class BridgeError extends Error {
  constructor(code, message, status=400,details=null) { super(message); this.code=code; this.status=status;if(details)this.details=safeDetails(details); }
}
export const fail = (code,message,status=400,details=null) => { throw new BridgeError(code,message,status,details); };
export function json(data,status=200,headers={}) {
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers}});
}
export const base64 = b => { let s=''; for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192)); return btoa(s); };
export const bytes = s => Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export const now = () => new Date().toISOString();
export function text(value,name='内容',max=2000) {
  if(typeof value!=='string'||!value.trim()||value.length>max)fail('INVALID_INPUT',name+'不能为空且不得超过 '+max+' 字符'); return value.trim();
}
export function integer(value,name,min=0,max=Number.MAX_SAFE_INTEGER) {
  const n=Number(value); if(!Number.isSafeInteger(n)||n<min||n>max)fail('INVALID_INPUT',name+'格式无效'); return n;
}
export function numericId(v,name='ID') { const s=String(v??'');if(!/^\d{1,24}$/.test(s))fail('INVALID_INPUT',name+'必须为数字');return s; }
export function actor(req,required=false,env={}) {
  let id=req.headers.get('oai-authenticated-user-id');
  const email=req.headers.get('oai-authenticated-user-email');
  // This is an explicitly owner-private Site. Some supported browser paths
  // provide verified email without the site-scoped ID; map both to one owner
  // record after checking the configured owner assertion from Sites.
  if(env.BILI_OWNER_EMAIL&&(id||email)){
    const matchesEmail=email?.trim().toLowerCase()===env.BILI_OWNER_EMAIL.trim().toLowerCase();
    const matchesId=env.BILI_OWNER_ACCOUNT_ID&&id===env.BILI_OWNER_ACCOUNT_ID;
    if(!matchesEmail&&!matchesId)fail('OWNER_ONLY','此服务仅供创建者使用，请使用创建插件的 ChatGPT 账号。',403);
    id='owner';
  }
  if(required&&!id)fail('SIGN_IN_REQUIRED','请先在此页面登录 ChatGPT，再连接 B站账号。',401);
  return id;
}
export async function actorHash(id) { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id)))).replace(/[/+=]/g,''); }
function bucket(env) { if(!env.BUCKET)fail('STORAGE_NOT_READY','云端存储尚未连接',503);return env.BUCKET; }
export async function read(env,key) { const o=await bucket(env).get(key);return o?await o.json():null; }
export async function put(env,key,value) {return bucket(env).put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'}});}
export async function remove(env,key) {return bucket(env).delete(key);}
export async function prefix(id,kind) {return 'users/'+await actorHash(id)+'/'+kind+'/';}
async function aesKey(env) {if(!env.BILI_CREDENTIAL_KEY)fail('ENCRYPTION_NOT_READY','云端加密密钥尚未配置',503);return crypto.subtle.importKey('raw',bytes(env.BILI_CREDENTIAL_KEY),'AES-GCM',false,['encrypt','decrypt']);}
export async function secretPut(env,id,key,value) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(id)},await aesKey(env),new TextEncoder().encode(JSON.stringify(value)));
  return put(env,key,{v:1,iv:base64(iv),ct:base64(new Uint8Array(ct))});
}
export async function secretRead(env,id,key) {
  const saved=await read(env,key);if(!saved)return null;
  try{return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(saved.iv),additionalData:new TextEncoder().encode(id)},await aesKey(env),bytes(saved.ct))));}
  catch{fail('CREDENTIAL_READ_FAILED','无法解密已保存的登录，请重新扫码连接。',503);}
}
export function networkSession(env,value=null) {
  if(!env.BILI_BACKEND_URL&&!env.BILI_BACKEND_KEY)return value;
  const s={...(value||{})};
  // Transport secrets are transient and cannot enter stored sessions or JSON.
  Object.defineProperty(s,'backend',{value:{url:env.BILI_BACKEND_URL,key:env.BILI_BACKEND_KEY},enumerable:false});return s;
}
export async function session(env,id,required=false) {
  const s=id?await secretRead(env,id,await prefix(id,'auth')+'session'):null;
  if(required&&!s?.cookies?.SESSDATA)fail('BILI_LOGIN_REQUIRED','请打开账户页面，用 B站手机客户端扫码登录。',401);return networkSession(env,s);
}
export async function saveSession(env,id,s) {return secretPut(env,id,await prefix(id,'auth')+'session',s);}
export async function csrf(env,id) {
  const key=await crypto.subtle.importKey('raw',bytes(env.BILI_CREDENTIAL_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('csrf:'+id))));
}
export async function verifyBrowserWrite(req,env) {
  const id=actor(req,true,env),origin=req.headers.get('origin'),url=new URL(req.url);
  if(origin!==url.origin&&origin!==env.SITE_ORIGIN)fail('BAD_ORIGIN','请求来源不匹配',403);
  const given=req.headers.get('x-csrf-token')||'',expected=await csrf(env,id);
  let diff=given.length^expected.length;for(let i=0;i<expected.length;i++)diff|=(given.charCodeAt(i)||0)^expected.charCodeAt(i);
  if(diff)fail('CSRF_REJECTED','页面凭据已变更，请刷新后重试。',403);return id;
}
export async function bodyJson(req,max=100000) {
  const value=await req.text();if(value.length>max)fail('INPUT_TOO_LARGE','请求内容过长',413);
  try{return JSON.parse(value);}catch{fail('INVALID_JSON','请求不是有效 JSON');}
}
export async function audit(env,id,event) {
  const key=await prefix(id,'audit')+Date.now()+'-'+crypto.randomUUID();
  await put(env,key,{...event,time:now()});
}
export async function listRecords(env,id,kind,limit=50) {
  const all=await bucket(env).list({prefix:await prefix(id,kind),limit:1000});
  const selected=all.objects.sort((a,b)=>b.uploaded-a.uploaded).slice(0,limit);
  return (await Promise.all(selected.map(x=>read(env,x.key)))).filter(Boolean);
}
export async function lockRecord(env,key,value) {
  const old=await bucket(env).get(key);if(!old)fail('NOT_FOUND','记录不存在',404);
  const current=await old.json();
  if(current.status!=='pending')fail('ALREADY_HANDLED','此操作已处理或状态不确定，请先核实结果，不要重复提交。',409);
  const result=await bucket(env).put(key,JSON.stringify({...current,...value}),{onlyIf:{etagMatches:old.etag},httpMetadata:{contentType:'application/json'}});
  if(!result)fail('ALREADY_HANDLED','此操作已在其他请求中处理',409);return {...current,...value};
}
export function safeError(e) {return {code:e.code||'INTERNAL_ERROR',message:e instanceof BridgeError?e.message:'服务暂时不可用，请稍后重试或查看云端日志。',...(e instanceof BridgeError&&e.details?{details:safeDetails(e.details)}:{})};}
