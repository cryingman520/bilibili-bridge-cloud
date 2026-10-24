import {fail,text,integer,now,prefix,read,put,secretRead,secretPut,session} from './platform.js';
import {api,headers,checkedFetch} from './bilibili.js';
const CHUNK=8*1024*1024,MAX_SIZE=4*1024*1024*1024;
export async function uploadStart(env,id,input){
  const s=await session(env,id,true),filename=text(input.filename,'文件名',200),size=integer(input.size,'文件大小',1,MAX_SIZE);
  if(!/\.(mp4|mov|mkv|webm|flv|avi)$/i.test(filename))fail('BAD_FILE_TYPE','请选择支持的视频文件');
  const uploadId=crypto.randomUUID(),key=await prefix(id,'media')+uploadId;
  const multi=await env.BUCKET.createMultipartUpload(key,{httpMetadata:{contentType:'application/octet-stream'}});
  const record={id:uploadId,filename,size,key,multipartId:multi.uploadId,chunkSize:CHUNK,status:'uploading',created_at:now(),accountMid:s.mid};
  await put(env,await prefix(id,'uploads')+uploadId,record);return {id:uploadId,chunkSize:CHUNK};
}
export async function getUpload(env,id,uploadId){
  if(!/^[a-f0-9-]{36}$/.test(String(uploadId)))fail('INVALID_UPLOAD','上传 ID 无效');
  const x=await read(env,await prefix(id,'uploads')+uploadId);if(!x)fail('NOT_FOUND','上传记录不存在',404);return x;
}
export async function uploadPart(env,id,uploadId,partNumber,req){
  const x=await getUpload(env,id,uploadId);if(x.status!=='uploading')fail('UPLOAD_STATE','此文件不在上传状态',409);
  const part=integer(partNumber,'分片序号',1,Math.ceil(x.size/CHUNK)),expected=Math.min(CHUNK,x.size-(part-1)*CHUNK);
  const len=Number(req.headers.get('content-length'));if(len&&len!==expected)fail('PART_SIZE','分片大小不匹配');
  const buf=await req.arrayBuffer();if(buf.byteLength!==expected)fail('PART_SIZE','分片数据不完整');
  const r=await env.BUCKET.resumeMultipartUpload(x.key,x.multipartId).uploadPart(part,buf);return r;
}
export async function uploadComplete(env,id,uploadId,parts){
  const x=await getUpload(env,id,uploadId);if(x.status!=='uploading')fail('UPLOAD_STATE','上传状态已变更',409);
  if(!Array.isArray(parts)||parts.length!==Math.ceil(x.size/CHUNK))fail('MISSING_PARTS','上传分片数量不正确');
  const sorted=parts.map(p=>({partNumber:integer(p.partNumber,'分片编号',1,parts.length),etag:text(p.etag,'分片校验',200)})).sort((a,b)=>a.partNumber-b.partNumber);
  if(sorted.some((p,i)=>p.partNumber!==i+1))fail('MISSING_PARTS','上传分片序号不连续');
  await env.BUCKET.resumeMultipartUpload(x.key,x.multipartId).complete(sorted);
  const head=await env.BUCKET.head(x.key);if(head.size!==x.size)fail('FILE_SIZE','云端文件大小校验失败',502);
  await put(env,await prefix(id,'uploads')+uploadId,{...x,status:'stored',stored_at:now()});return {id:uploadId,status:'stored'};
}
function uposUrl(endpoint,uri){const host=new URL(endpoint.startsWith('//')?'https:'+endpoint:endpoint);if(host.protocol!=='https:'||!['.bilibili.com','.bilivideo.com','.bilivideo.cn'].some(d=>host.hostname.endsWith(d)))fail('UNSUPPORTED_UPLOAD_HOST','B站返回了未支持的上传域名，传输已停止',502);return new URL(uri.replace(/^upos:\/\//,''),host.origin+'/');}
export async function transferStart(env,id,uploadId){
  const s=await session(env,id,true),x=await getUpload(env,id,uploadId);if(x.status!=='stored')fail('UPLOAD_STATE','请先完成云端文件上传',409);
  if(String(x.accountMid)!==String(s.mid))fail('ACCOUNT_CHANGED','登录账号已变更',409);
  const pre=new URL('https://member.bilibili.com/preupload');
  for(const [k,v] of Object.entries({name:x.filename,size:x.size,r:'upos',profile:'ugcupos/bup',ssl:0,version:'2.14.0',build:2140000}))pre.searchParams.set(k,String(v));
  // Unlike standard Bilibili APIs, preupload returns its fields at the root.
  const preResponse=await checkedFetch(pre,{headers:headers(s)},s?.backend),p=await preResponse.json();
  if(!p.auth||!p.endpoint||!p.upos_uri||!p.chunk_size)fail('PREUPLOAD_RESPONSE','B站未返回完整上传信息',502);
  const url=uposUrl(p.endpoint,p.upos_uri),u=new URL(url);u.searchParams.set('uploads','');u.searchParams.set('output','json');
  const r=await checkedFetch(u,{method:'POST',headers:{...headers(s),'x-upos-auth':p.auth}},s?.backend),j=await r.json();if(!j.upload_id)fail('UPOS_INIT','B站上传初始化失败',502);
  const chunkSize=integer(p.chunk_size,'B站分片大小',1024,16*1024*1024),chunks=Math.ceil(x.size/chunkSize);
  await secretPut(env,id,await prefix(id,'transfer')+uploadId,{url:url.href,auth:p.auth,uploadId:j.upload_id,bizId:p.biz_id,uposUri:p.upos_uri,chunkSize,chunks,parts:{}});
  await put(env,await prefix(id,'uploads')+uploadId,{...x,status:'transferring'});return {id:uploadId,chunks,chunkSize};
}
export async function transferPart(env,id,uploadId,index){
  const s=await session(env,id,true),x=await getUpload(env,id,uploadId),key=await prefix(id,'transfer')+uploadId,t=await secretRead(env,id,key);
  if(x.status!=='transferring'||!t)fail('UPLOAD_STATE','B站传输尚未开始',409);
  if(String(x.accountMid)!==String(s.mid))fail('ACCOUNT_CHANGED','登录账号已变更',409);
  const i=integer(index,'分片序号',0,t.chunks-1);if(t.parts[i])return {done:true,index:i,already_uploaded:true};
  const start=i*t.chunkSize,end=Math.min(x.size,start+t.chunkSize),obj=await env.BUCKET.get(x.key,{range:{offset:start,length:end-start}});
  if(!obj)fail('FILE_MISSING','云端视频文件不存在',404);
  const u=new URL(t.url);for(const [k,v]of Object.entries({uploadId:t.uploadId,chunks:t.chunks,total:x.size,chunk:i,size:end-start,partNumber:i+1,start,end}))u.searchParams.set(k,String(v));
  const r=await checkedFetch(u,{method:'PUT',headers:{...headers(s),'x-upos-auth':t.auth,'content-type':'application/octet-stream'},body:obj.body},s?.backend);await r.body?.cancel();
  t.parts[i]=true;await secretPut(env,id,key,t);return {done:true,index:i};
}
export async function transferComplete(env,id,uploadId){
  const s=await session(env,id,true),x=await getUpload(env,id,uploadId),key=await prefix(id,'transfer')+uploadId,t=await secretRead(env,id,key);
  if(x.status!=='transferring'||!t||Object.keys(t.parts).length!==t.chunks)fail('TRANSFER_INCOMPLETE','B站分片尚未传输完成',409);
  if(String(x.accountMid)!==String(s.mid))fail('ACCOUNT_CHANGED','登录账号已变更',409);
  const u=new URL(t.url);for(const [k,v]of Object.entries({name:x.filename,uploadId:t.uploadId,biz_id:t.bizId,output:'json',profile:'ugcupos/bup'}))u.searchParams.set(k,String(v));
  const r=await checkedFetch(u,{method:'POST',headers:{...headers(s),'x-upos-auth':t.auth,'content-type':'application/json'},body:JSON.stringify({parts:Array.from({length:t.chunks},(_,i)=>({partNumber:i+1,eTag:'etag'}))})},s?.backend);
  const j=await r.json();if(j.OK!==1)fail('UPOS_COMPLETE','B站没有确认视频上传完成',502);
  const filename=t.uposUri.split('/').pop().replace(/\.[^.]+$/,'');
  await put(env,await prefix(id,'uploads')+uploadId,{...x,status:'transferred',biliFilename:filename,transferred_at:now()});return {id:uploadId,filename,status:'transferred',note:'文件已上传到 B站存储，尚未发布稿件'};
}
