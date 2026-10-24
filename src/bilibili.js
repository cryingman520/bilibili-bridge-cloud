// WBI signing and subtitle flow adapted from CZX2244/dsh-bilibili (MIT).
import {md5} from '@noble/hashes/legacy.js';
import jpeg from 'jpeg-js';
import qrcode from 'qrcode-generator';
import {fail,BridgeError,text,integer,numericId,now,base64,prefix,read,put,remove,session,saveSession,secretPut,secretRead,networkSession} from './platform.js';
import {backendFetch} from './transport.js';
import {RISK_CODES} from './diagnostics.js';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TABLE=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const API_HOSTS=new Set(['api.bilibili.com','passport.bilibili.com','member.bilibili.com']);
export function headers(s) {
  const h={'user-agent':UA,referer:'https://www.bilibili.com/',origin:'https://www.bilibili.com',accept:'application/json, text/plain, */*'};
  if(s?.cookies)h.cookie=Object.entries(s.cookies).filter(([k,v])=>['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5','sid','buvid3','buvid4'].includes(k)&&!/\r|\n|;/.test(String(v))).map(([k,v])=>k+'='+v).join('; ');
  return h;
}
export async function checkedFetch(url,options={},backend=null,frameCrop=null) {
  // Workers supports manual/follow, but rejects the standard "error" option.
  const r=backend?await backendFetch(url,{...options,...(frameCrop?{frameCrop}:{})},backend):await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(25000)});
  if(r.status>=300&&r.status<400){await r.body?.cancel();fail('BILI_REDIRECT','B站要求跳转验证，本次请求已停止，请在 B站客户端检查账号。',502);}
  if(r.status===412||r.status===429){await r.body?.cancel();fail('BILI_RISK_CONTROL','B站 HTTP '+r.status+'：本次请求受到限制，已停止。搜索会进入冷却；如需验证，请使用 B站官方页面。',502,{request_id:r.headers.get('x-bili-request-id'),http_status:r.status,upstream_code:r.headers.get('x-bili-upstream-code')?Number(r.headers.get('x-bili-upstream-code')):null,requires_verification:r.headers.get('x-bili-requires-verification')==='true'});}
  if(!r.ok){await r.body?.cancel();fail('BILI_HTTP_ERROR','B站接口 HTTP '+r.status,502);}return r;
}
export async function api(s,path,params={},options={}) {
  const u=new URL(path,'https://api.bilibili.com');if(!API_HOSTS.has(u.hostname)||u.protocol!=='https:')fail('BAD_API_HOST','接口主机不在允许列表');
  for(const [k,v]of Object.entries(params))if(v!==undefined&&v!==null)u.searchParams.set(k,String(v));
  const r=await checkedFetch(u,{...options,headers:{...headers(s),...options.headers}},s?.backend);
  let j;try{j=await r.json();}catch{fail('BILI_BAD_RESPONSE','B站返回了无法解析的响应',502);}
  const value=j.data??j.result;
  if(RISK_CODES.has(j.code)||j.v_voucher||value?.v_voucher||value?.gaia_voucher)fail('BILI_RISK_CONTROL','B站接口需要风控验证或暂时限制此请求，服务已停止，不会当成空结果。',502,{request_id:r.headers.get('x-bili-request-id'),http_status:r.status,upstream_code:j.code,requires_verification:!!(j.v_voucher||value?.v_voucher||value?.gaia_voucher)});
  if(j.code!==0)fail(j.code===-101?'BILI_LOGIN_EXPIRED':'BILI_API_ERROR','B站接口 '+j.code+'：'+String(j.message||j.msg||'请求失败').slice(0,220),j.code===-101?401:502);
  if(value&&typeof value==='object')Object.defineProperty(value,'_bridge',{value:{request_id:r.headers.get('x-bili-request-id'),cache_status:r.headers.get('x-bili-cache-status')||'none',fetched_at:r.headers.get('x-bili-fetched-at')||now()},enumerable:false});
  return value;
}
export function wbiParams(params,img,sub,time=Math.floor(Date.now()/1000)) {
  const full=img+sub,key=TABLE.map(n=>full[n]).join('').slice(0,32),p={...params,wts:time};
  const query=Object.keys(p).sort().map(k=>encodeURIComponent(k)+'='+encodeURIComponent(String(p[k]).replace(/[!'()*]/g,''))).join('&');
  p.w_rid=Array.from(md5(new TextEncoder().encode(query+key)),x=>x.toString(16).padStart(2,'0')).join('');return p;
}
async function signed(s,params) {
  const n=await api(s,'/x/web-interface/nav');const f=u=>String(u||'').split('/').pop().split('.')[0];
  const i=f(n.wbi_img?.img_url),j=f(n.wbi_img?.sub_url);if(!i||!j)fail('WBI_NOT_AVAILABLE','B站签名参数暂不可用',502);return wbiParams(params,i,j);
}
export async function resolveVideo(s,input) {
  const v=text(input,'视频地址',2048),b=v.match(/BV[0-9A-Za-z]{10}/)?.[0],av=v.match(/(?:^|\/)av(\d+)/i)?.[1];
  if(!b&&!av)fail('INVALID_VIDEO','请提供 BV 号、av 号或带 BV 号的视频链接。');
  const d=await api(s,'/x/web-interface/view',b?{bvid:b}:{aid:av}),part=v.match(/[?&]p=([^&#]*)/)?.[1],page=part===undefined?1:integer(part,'分P',1,10000),selected=d.pages?.find(x=>x.page===page)||d.pages?.[page-1];
  if(!selected&&page!==1)fail('INVALID_PART','视频不存在指定的分P');
  return selected?{...d,cid:selected.cid,duration:selected.duration,total_duration:d.duration,selected_page:{page:selected.page,part:selected.part,cid:selected.cid,duration:selected.duration}}:d;
}
export function videoInfo(d) {return {aid:d.aid,bvid:d.bvid,cid:d.cid,title:d.title,description:d.desc,cover:d.pic,owner:d.owner,duration:d.duration,total_duration:d.total_duration??d.duration,selected_page:d.selected_page,pages:d.pages,stats:d.stat,published_at:d.pubdate,url:'https://www.bilibili.com/video/'+d.bvid+(d.selected_page?.page>1?'?p='+d.selected_page.page:'')};}
export async function accountStatus(env,id) {
  const s=await session(env,id);if(!s?.cookies?.SESSDATA)return {logged_in:false,verified:true,message:'尚未连接 B站账号'};
  try {const n=await api(s,'/x/web-interface/nav');return {logged_in:n.isLogin===true,verified:true,mid:n.mid,name:n.uname,face:n.face,level:n.level_info?.current_level,vip:n.vipStatus,saved_at:s.saved_at,message:n.isLogin?'登录已验证':'登录已失效，请重新扫码'};}
  catch(e){return {logged_in:e.code==='BILI_LOGIN_EXPIRED'?false:null,verified:e.code==='BILI_LOGIN_EXPIRED',credential_present:true,message:e.message,code:e.code};}
}
export async function startLogin(env,id) {
  const d=await api(networkSession(env),'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',{source:'main-fe-header'});
  if(!d.url||!d.qrcode_key)fail('QR_INVALID','B站未返回有效二维码',502);
  const key=crypto.randomUUID(),expires_at=Date.now()+180000;
  await secretPut(env,id,await prefix(id,'login')+key,{key:d.qrcode_key,expires_at});
  const qr=qrcode(0,'M');qr.addData(d.url);qr.make();
  return {id:key,svg:qr.createSvgTag({cellSize:5,margin:12,scalable:true}),expires_at};
}
export function parseCookies(r,url) {
  const allowed=new Set(['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5','sid','buvid3','buvid4']);const jar={};
  for(const line of r.headers.getSetCookie?.()||[]){const first=line.split(';')[0],i=first.indexOf('=');if(i>0&&allowed.has(first.slice(0,i)))jar[first.slice(0,i)]=first.slice(i+1);}
  const queue=[url],seen=new Set();while(queue.length){const str=queue.shift();if(!str||seen.has(str))continue;seen.add(str);let u;try{u=new URL(str);}catch{continue;}
    if(!u.hostname.endsWith('.bilibili.com')&&u.hostname!=='bilibili.com')continue;
    for(const [k,v]of u.searchParams){if(allowed.has(k))jar[k]=v;else if(/^https?:/.test(v))queue.push(v);}}
  return jar;
}
export async function pollLogin(env,id,loginId) {
  if(!/^[a-f0-9-]{36}$/.test(String(loginId)))fail('INVALID_LOGIN','登录会话无效');
  const key=await prefix(id,'login')+loginId,x=await secretRead(env,id,key);if(!x||x.expires_at<Date.now())return {status:'expired',message:'二维码已过期，请重新生成'};
  const u=new URL('https://passport.bilibili.com/x/passport-login/web/qrcode/poll');u.searchParams.set('qrcode_key',x.key);u.searchParams.set('source','main-fe-header');
  const r=await checkedFetch(u,{headers:headers(null)},networkSession(env)?.backend),j=await r.json();
  const c=j.code===0?j.data?.code:j.code,map={86101:'waiting',86090:'scanned',86038:'expired'};
  if(map[c])return {status:map[c],message:{waiting:'请用 B站手机客户端扫码',scanned:'已扫码，请在 B站手机端确认',expired:'二维码已过期'}[map[c]]};
  if(c!==0)fail('QR_LOGIN_FAILED','B站登录返回 '+c+'：'+(j.message||j.data?.message||''),502);
  const cookies=parseCookies(r,j.data?.url);if(!cookies.SESSDATA||!cookies.bili_jct)fail('QR_COOKIE_MISSING','登录返回不完整，未保存凭据，请重新扫码。',502);
  const n=await api(networkSession(env,{cookies}),'/x/web-interface/nav');if(!n.isLogin)fail('LOGIN_VERIFY_FAILED','无法验证 B站登录',502);
  await saveSession(env,id,{cookies,mid:n.mid,name:n.uname,saved_at:now(),refresh_token:j.data?.refresh_token||null});await remove(env,key);
  return {status:'success',message:'B站账号已安全连接到云端',account:{logged_in:true,verified:true,mid:n.mid,name:n.uname,face:n.face}};
}
function assetUrl(input,kind='image') {
  const u=new URL(String(input).startsWith('//')?'https:'+input:input);
  const domains=kind==='subtitle'?['.hdslb.com','.bilibili.com']:['.hdslb.com','.bilibili.com','.bilivideo.com','.bilivideo.cn'];
  if(u.protocol!=='https:'||u.port||!domains.some(x=>u.hostname.endsWith(x)))fail('INVALID_ASSET_HOST','B站资源域名不受支持');return u;
}
export async function subtitles(s,d) {
  let p;try{p=await api(s,'/x/player/wbi/v2',await signed(s,{bvid:d.bvid,cid:d.cid}));}
  catch(e){if(e.code==='BILI_RISK_CONTROL')throw e;p=await api(s,'/x/player/v2',{bvid:d.bvid,cid:d.cid});}
  const tracks=p.subtitle?.subtitles||[],t=tracks.find(x=>x.lan?.includes('zh'))||tracks[0];
  if(!t?.subtitle_url)return {source:'none',segments:[],text:'',note:p.need_login_subtitle?'字幕需要有效登录':'该视频没有可用字幕轨；未生成或虚构转录'};
  const r=await checkedFetch(assetUrl(t.subtitle_url,'subtitle'),{headers:headers(null)},s?.backend);const v=await r.json();
  const segments=(v.body||[]).slice(0,12000).map(x=>({from:x.from,to:x.to,text:x.content}));
  return {source:'bilibili_subtitle',language:t.lan_name||t.lan,segments,text:segments.map(x=>x.text).join('\n'),total_segments:segments.length};
}
export async function comments(s,d,page=1,limit=20) {
  const v=await api(s,'/x/v2/reply',{type:1,oid:d.aid,pn:integer(page,'页码',1,10000),ps:integer(limit,'条数',1,49),sort:2});
  return {page:v.page,comments:(v.replies||[]).map(x=>({rpid:x.rpid_str||String(x.rpid),root:x.root_str||String(x.root||0),message:x.content?.message,time:x.ctime,likes:x.like,replies:x.rcount,member:{mid:x.member?.mid,name:x.member?.uname},preview_replies:(x.replies||[]).map(r=>({rpid:r.rpid_str||String(r.rpid),message:r.content?.message,name:r.member?.uname}))}))};
}
export async function danmaku(s,d,limit=300) {
  const r=await checkedFetch('https://api.bilibili.com/x/v1/dm/list.so?oid='+d.cid,{headers:headers(s)},s?.backend);
  const xml=await r.text();if(xml.length>12000000)fail('DANMAKU_TOO_LARGE','弹幕数据过大，请换用分段数据',502);
  const unescape=x=>x.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  const out=[];for(const m of xml.matchAll(/<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g)){const p=m[1].split(',');out.push({time:Number(p[0]),mode:Number(p[1]),color:Number(p[3]),text:unescape(m[2])});if(out.length>=limit)break;}
  return {danmaku:out,count:out.length,limited:out.length>=limit};
}
export async function frames(s,d,timestamps,max=4) {
  const shot=await api(s,'/x/player/videoshot',{bvid:d.bvid,cid:d.cid,index:1});
  // The leading timestamp is a sentinel; index[1] identifies sprite cell 0.
  const indexes=(shot.index||[]).slice(1),urls=shot.image||[],cols=shot.img_x_len,rows=shot.img_y_len,w=shot.img_x_size,h=shot.img_y_size;
  if(!indexes.length||!urls.length||!cols||!rows||!w||!h)fail('FRAMES_UNAVAILABLE','此视频未提供云端时间轴图像；没有用封面冒充视频帧。',502);
  const times=(timestamps?.length?timestamps:[0,d.duration/3,d.duration*2/3]).slice(0,max).map(parseTime);
  const decoded=new Map(),content=[],info=[];
  for(const requested of times){if(requested<0||requested>d.duration)fail('INVALID_TIME','抓帧时间超出视频时长');let idx=0;for(let i=0;i<indexes.length;i++){if(Math.abs(indexes[i]-requested)<Math.abs(indexes[idx]-requested))idx=i;}
    const sheet=Math.floor(idx/(cols*rows)),cell=idx%(cols*rows);if(!urls[sheet])continue;
    const x=(cell%cols)*w,y=Math.floor(cell/cols)*h;let jpg;
    if(s?.backend){const r=await checkedFetch(assetUrl(urls[sheet]),{headers:headers(null)},s.backend,{x,y,width:w,height:h});jpg=new Uint8Array(await r.arrayBuffer());}
    else{
      if(!decoded.has(sheet)){const r=await checkedFetch(assetUrl(urls[sheet]),{headers:headers(null)});const buf=new Uint8Array(await r.arrayBuffer());if(buf.length>5000000)fail('FRAME_SHEET_TOO_LARGE','时间轴图像超过云端处理上限',502);try{decoded.set(sheet,jpeg.decode(buf,{useTArray:true,maxMemoryUsageInMB:64,maxResolutionInMP:12}));}catch{fail('FRAME_PROCESSING_LIMIT','时间轴图像较大，请配置云端托管后端处理',502);}}
      const image=decoded.get(sheet);if(x+w>image.width||y+h>image.height)continue;
      const pixels=new Uint8Array(w*h*4);for(let row=0;row<h;row++)pixels.set(image.data.subarray(((y+row)*image.width+x)*4,((y+row)*image.width+x+w)*4),row*w*4);jpg=jpeg.encode({data:pixels,width:w,height:h},80).data;
    }
    const record={requested_time:requested,time:indexes[idx],source:'bilibili_videoshot',width:w,height:h};info.push(record);content.push({type:'text',text:JSON.stringify(record)},{type:'image',mimeType:'image/jpeg',data:base64(jpg)});
  }
  if(!info.length)fail('FRAMES_UNAVAILABLE','未取得对应时间的视频图像',502);return {frames:info,content,note:'这是 B站时间轴实际图像，采样时刻可能与请求时间不同，清晰度受原图限制。'};
}
export function parseTime(v){if(typeof v==='number'&&Number.isFinite(v))return v;if(typeof v==='string'&&/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(v))return v.split(':').reduce((a,x)=>a*60+Number(x),0);fail('INVALID_TIME','时间格式必须是秒数或 MM:SS / HH:MM:SS');}
export async function search(s,keyword,limit=10,{order='totalrank',page=1}={}) {
  const query=text(keyword,'关键词',120),count=integer(limit,'数量',1,20),pn=integer(page,'页码',1,100);
  if(!['totalrank','pubdate'].includes(order))fail('INVALID_ORDER','请选择综合排序或发布时间最新优先');
  const params=await signed(s,{search_type:'video',keyword:query,page:pn,order,page_size:20,platform:'pc',web_location:1430654});
  const v=await api(s,'/x/web-interface/wbi/search/type',params,{headers:{origin:'https://search.bilibili.com',referer:'https://search.bilibili.com/video?keyword='+encodeURIComponent(query)}});
  if(!v||!Array.isArray(v.result))fail('BILI_SEARCH_BAD_RESPONSE','B站搜索返回格式异常，未将其当作没有结果。',502,{request_id:v?._bridge?.request_id});
  const videos=v.result.map(x=>({...videoCard(x),description:x.description}));
  if(order==='pubdate')videos.sort((a,b)=>(b.published_at||0)-(a.published_at||0));
  return {videos:videos.slice(0,count),order,page:pn,total:Number(v.numResults)||null,has_more:Number(v.numPages)?pn<Number(v.numPages):v.result.length>=20,diagnostics:{strategy:'wbi',...v._bridge}};
}
function videoCard(x){
  const timestamp=Number(x.pubdate),published=Number.isInteger(timestamp)&&timestamp>0&&timestamp<253402300800?timestamp:null;
  const duration=typeof x.duration==='number'?Math.floor(x.duration/60)+':'+String(x.duration%60).padStart(2,'0'):x.duration;
  return {bvid:x.bvid,title:String(x.title||'').replace(/<[^>]*>/g,''),uploader:x.author||x.owner?.name||'',cover:String(x.pic||'').replace(/^http:/,'https:').replace(/^\/\//,'https://'),duration,duration_seconds:typeof x.duration==='number'?x.duration:null,views:x.play??x.stat?.view,published_at:published,published_at_iso:published?new Date(published*1000).toISOString():null,url:'https://www.bilibili.com/video/'+x.bvid};
}
export function shuffleVideos(videos,random=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296){
  const out=[...videos];for(let i=out.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[out[i],out[j]]=[out[j],out[i]];}return out;
}
export async function recommend(s,{source='home',limit=8,page=1,shuffle=true}={}){
  if(!['home','popular'].includes(source))fail('INVALID_SOURCE','请选择首页推荐或公共热门');
  if(typeof shuffle!=='boolean')fail('INVALID_INPUT','随机顺序必须为布尔值');
  const count=integer(limit,'数量',1,20),pn=integer(page,'批次',1,100);
  const params=source==='home'?await signed(s,{version:1,feed_version:'V8',homepage_ver:1,ps:20,fresh_idx:pn,brush:pn,fresh_type:4}):{pn,ps:20};
  const value=await api(s,source==='home'?'/x/web-interface/wbi/index/top/feed/rcmd':'/x/web-interface/popular',params);
  const items=source==='home'?value?.item:value?.list;
  if(!Array.isArray(items))fail('BILI_RECOMMEND_BAD_RESPONSE','B站没有返回有效的视频推荐列表',502,{request_id:value?._bridge?.request_id});
  const seen=new Set();let videos=items.filter(x=>/^BV[0-9A-Za-z]{10}$/.test(x.bvid||'')&&(source!=='home'||x.goto==='av')&&!x.ad_info&&!x.is_ad).filter(x=>{if(seen.has(x.bvid))return false;seen.add(x.bvid);return true;}).map(x=>({...videoCard(x),recommendation_reason:x.rcmd_reason?.content||null}));
  if(shuffle)videos=shuffleVideos(videos);
  return {videos:videos.slice(0,count),source:source==='home'?'bilibili_home_recommendations':'bilibili_popular',account_context:s?.cookies?.SESSDATA?'logged_in':'guest',page:pn,next_page:value?.no_more||pn>=100?null:pn+1,shuffled:shuffle,note:(source==='home'?'来自 B站首页推荐接口，是否个性化由 B站和账号设置决定。':'来自 B站公共热门列表，不表示账号个性化推荐。')+(shuffle?'随机仅打乱本批返回视频的顺序。':''),diagnostics:{strategy:source==='home'?'wbi_feed':'popular',...value._bridge}};
}
export async function myVideos(s,page=1) {return api(s,'https://member.bilibili.com/x/web/archives',{status:'is_pubing,pubed,not_pubed',pn:integer(page,'页码',1,1000),ps:10,coop:1,interactive:1});}
export async function space(s,mid) {const id=numericId(mid||s?.mid,'用户 UID');return api(s,'/x/space/wbi/acc/info',await signed(s,{mid:id}));}
export async function postForm(s,path,params={},query={}) {
  if(!s?.cookies?.bili_jct)fail('CSRF_MISSING','登录缺少写入凭据，请重新扫码',401);
  return api(s,path,query,{method:'POST',headers:{...headers(s),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,csrf:s.cookies.bili_jct,csrf_token:s.cookies.bili_jct})});
}
export async function postJson(s,path,payload,query={}) {
  if(!s?.cookies?.bili_jct)fail('CSRF_MISSING','登录缺少写入凭据，请重新扫码',401);
  return api(s,path,{...query,csrf:s.cookies.bili_jct},{method:'POST',headers:{...headers(s),'content-type':'application/json'},body:JSON.stringify(payload)});
}
