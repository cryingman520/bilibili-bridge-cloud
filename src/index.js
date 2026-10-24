import {PAGE} from './ui.js';
import {VERSION,BridgeError,fail,json,actor,csrf,verifyBrowserWrite,bodyJson,session,prefix,remove,listRecords,read,put,safeError,networkSession} from './platform.js';
import {accountStatus,startLogin,pollLogin,resolveVideo,videoInfo,subtitles,comments,danmaku,frames,search,recommend,myVideos,space,api} from './bilibili.js';
import {ACTION_KINDS,prepareAction,approveAction} from './actions.js';
import {uploadStart,uploadPart,uploadComplete,transferStart,transferPart,transferComplete,getUpload,uploadCover} from './uploads.js';
const INSTRUCTIONS='Bilibili Bridge 云端版：先读取视频信息和字幕，再选择时间调用 bilibili_frames 查看真实图像。时间轴帧有采样误差；不得把封面或评论当作视频画面或官方转录。字幕缺失要如实说明。用户账号须在此服务的安全页面扫码登录，不在聊天索要 Cookie、密码或验证码。写入操作只创建草稿，用户在云端页面核对账号、目标和内容后亲自确认。账号风控或验证码出现时停止，不绕过，不自动重试已发送操作。';
const str=(description,maxLength=2048)=>({type:'string',description,maxLength});
const num=(description,min=1,max=10000)=>({type:'integer',description,minimum:min,maximum:max});
function tool(name,description,properties={},required=[],write=false){return {name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:!write,destructiveHint:false,openWorldHint:true}};}
const URL_PROP={url:str('BV号、av号或带BV号的视频链接')};
export const TOOLS=[
  tool('bilibili_doctor','检查云端服务、存储与本账号登录状态，无需电脑在线'),
  tool('bilibili_login','返回安全扫码登录页面，或查看账号连接状态；不会返回登录凭据',{action:{type:'string',enum:['status','start']}}),
  tool('bilibili_video','获取视频标题、简介、UP主、分P、时长和统计',URL_PROP,['url']),
  tool('bilibili_extract','视频分析第一阶段：提取实际字幕、评论和弹幕。画面需另外调用 bilibili_frames，不虚构没有的字幕。',{...URL_PROP,commentLimit:num('评论条数',1,49)},['url']),
  tool('bilibili_extract_json','结构化提取视频字幕、评论和弹幕',{...URL_PROP,commentLimit:num('评论条数',1,49)},['url']),
  tool('bilibili_subtitles','读取带时间戳的 B站字幕轨，缺失字幕会如实说明',URL_PROP,['url']),
  tool('bilibili_comments','分页读取视频评论及部分楼中楼',{...URL_PROP,page:num('页码'),limit:num('评论条数',1,49)},['url']),
  tool('bilibili_danmaku','读取带视频时间的弹幕',{...URL_PROP,limit:num('条数',1,1000)},['url']),
  tool('bilibili_frames','返回指定时间附近的实际视频时间轴图片；无需本机 FFmpeg，注明实际采样时间。',{...URL_PROP,timestamps:{type:'array',items:str('MM:SS 或秒数字符串',20),maxItems:6},maxFrames:num('最多图像数',1,6)},['url']),
  tool('bilibili_search','搜索 B站视频。order=pubdate 按发布时间从新到旧，totalrank 为综合排序；支持翻页，返回发布时间。',{keyword:str('关键词',120),limit:num('条数',1,20),order:{type:'string',enum:['totalrank','pubdate'],description:'综合排序或发布时间最新优先'},page:num('页码',1,100)},['keyword']),
  tool('bilibili_recommend','无需关键词获取一批首页推荐或公共热门视频。shuffle 只打乱本批顺序；page 递增可换一批，不会搜索随机关键词。',{source:{type:'string',enum:['home','popular'],description:'home 为首页推荐，popular 为公共热门，默认 home'},limit:num('条数',1,20),page:num('批次',1,100),shuffle:{type:'boolean',description:'打乱本批视频顺序，默认 true'}}),
  tool('bilibili_account','验证 B站登录，读取本人账号资料和创作状态'),
  tool('bilibili_my_videos','读取本人稿件，包括审核与发布状态',{page:num('页码',1,1000)}),
  tool('bilibili_space','读取账号空间资料，默认本人',{mid:str('数字 UID',24)}),
  tool('bilibili_prepare_action','生成评论、回复、弹幕、动态、签名、公告或投稿草稿；返回确认页面，尚不向 B站发布。',{kind:{type:'string',enum:ACTION_KINDS},payload:{type:'object',description:'按操作提供参数：comment.create={url,message}; reply.create 增加 root,parent; danmaku.send={url,message,progress_seconds,color?,mode?}; dynamic.publish={text}; profile.update={sign}; space.notice={notice}; video.submit={uploadId,title,desc,tid,tag,copyright,source?,cover?}; video.edit 另加 aid。'}},['kind','payload'],true),
  tool('bilibili_action_status','查询本人操作草稿及确认后的发送结果',{draftId:str('草稿 ID',36)},['draftId']),
  tool('bilibili_upload_status','查询本人云端上传状态，获取手机或网页上传入口',{uploadId:str('上传 ID',36)}),
];
function validateTool(name,a){
  const t=TOOLS.find(x=>x.name===name);if(!t)fail('UNKNOWN_TOOL','不支持的工具');
  if(!a||typeof a!=='object'||Array.isArray(a))fail('INVALID_INPUT','参数必须是对象');
  for(const k of t.inputSchema.required)if(a[k]===undefined)fail('INVALID_INPUT','缺少参数 '+k);
  for(const [k,v]of Object.entries(a)){
    const s=t.inputSchema.properties[k];if(!s)fail('INVALID_INPUT','未知参数 '+k);
    if(s.type==='string'&&(typeof v!=='string'||v.length>(s.maxLength||2048)))fail('INVALID_INPUT',k+'必须是长度合适的文本');
    if(s.type==='integer'&&(!Number.isInteger(v)||v<s.minimum||v>s.maximum))fail('INVALID_INPUT',k+'必须是允许范围内的整数');
    if(s.type==='array'&&(!Array.isArray(v)||v.length>s.maxItems||v.some(x=>typeof x!=='string'||x.length>s.items.maxLength)))fail('INVALID_INPUT',k+'数组无效');
    if(s.type==='object'&&(!v||typeof v!=='object'||Array.isArray(v)))fail('INVALID_INPUT',k+'必须是对象');
    if(s.type==='boolean'&&typeof v!=='boolean')fail('INVALID_INPUT',k+'必须是布尔值');
    if(s.enum&&!s.enum.includes(v))fail('INVALID_INPUT',k+'不支持此取值');
  }
}
const result=v=>({content:[{type:'text',text:JSON.stringify(v,null,2)}]});
export async function callTool(env,req,name,a={}){
  validateTool(name,a);const id=actor(req,false,env),origin=env.SITE_ORIGIN||new URL(req.url).origin,s=await session(env,id);
  switch(name){
    case 'bilibili_doctor':return result({version:VERSION,runtime:'Cloudflare Workers / Sites',computer_required:false,backend_configured:!!(env.BILI_BACKEND_URL&&env.BILI_BACKEND_KEY),storage_ready:!!env.BUCKET,encryption_ready:!!env.BILI_CREDENTIAL_KEY,cloud_readiness:await read(env,readinessKey(env)),search_status:id?await read(env,await prefix(id,'diagnostics')+'search'):null,account:await accountStatus(env,id),image_source:'B站时间轴实际图像',asr:'未配置独立云端语音转录；无字幕时不会虚构文稿',login_url:origin});
    case 'bilibili_login':return result(a.action==='start'?{login_url:origin,note:'请在此私有页面登录 ChatGPT 后，用 B站客户端扫码；无需在聊天提供任何凭据。'}:await accountStatus(env,id));
    case 'bilibili_video':return result(videoInfo(await resolveVideo(s,a.url)));
    case 'bilibili_subtitles':return result(await subtitles(s,await resolveVideo(s,a.url)));
    case 'bilibili_comments':return result(await comments(s,await resolveVideo(s,a.url),a.page||1,a.limit||20));
    case 'bilibili_danmaku':return result(await danmaku(s,await resolveVideo(s,a.url),a.limit||300));
    case 'bilibili_frames':{const f=await frames(s,await resolveVideo(s,a.url),a.timestamps,a.maxFrames||4);return {content:[{type:'text',text:f.note},...f.content]};}
    case 'bilibili_extract':case 'bilibili_extract_json':{
      const d=await resolveVideo(s,a.url),r=await Promise.allSettled([subtitles(s,d),comments(s,d,1,a.commentLimit||20),danmaku(s,d,300)]),names=['transcript','comments','danmaku'],v={metadata:videoInfo(d)};
      r.forEach((x,i)=>{v[names[i]]=x.status==='fulfilled'?x.value:{error:safeError(x.reason)};});v.next_step='需要视觉证据时调用 bilibili_frames，并查看它返回的真实图片。';return result(v);
    }
    case 'bilibili_search':case 'bilibili_recommend':{
      const root=id&&env.BUCKET?await prefix(id,'diagnostics'):null,key=root?root+'discovery':null;
      const previous=key?(await read(env,key)||await read(env,root+'search')):null;
      if(previous?.status==='error'&&['BILI_RISK_CONTROL','BILI_SEARCH_COOLDOWN'].includes(previous.error?.code)){
        const seconds=previous.error.details?.retry_after_seconds??120,remaining=Math.ceil((Date.parse(previous.checked_at)+seconds*1000-Date.now())/1000);
        if(remaining>0)fail('BILI_SEARCH_COOLDOWN','推荐与搜索正在冷却，暂不向 B站发送请求。请在冷却结束后再手动操作。',429,{retry_after_seconds:remaining});
      }
      try{const value=name==='bilibili_search'?await search(s,a.keyword,a.limit||10,{order:a.order||'totalrank',page:a.page||1}):await recommend(s,a);const record={status:'ok',kind:name,checked_at:new Date().toISOString(),count:value.videos.length,...value.diagnostics};if(key){await put(env,key,record);if(name==='bilibili_search')await put(env,root+'search',record);}return result(value);}
      catch(e){if(key)await put(env,key,{status:'error',checked_at:new Date().toISOString(),error:safeError(e)});throw e;}
    }
    case 'bilibili_account':actor(req,true,env);return result(await accountStatus(env,id));
    case 'bilibili_my_videos':return result(await myVideos(await session(env,actor(req,true,env),true),a.page||1));
    case 'bilibili_space':return result(await space(s,a.mid));
    case 'bilibili_prepare_action':return result(await prepareAction(env,actor(req,true,env),a.kind,a.payload,origin));
    case 'bilibili_action_status':{const owner=actor(req,true,env);if(!/^[a-f0-9-]{36}$/.test(a.draftId))fail('INVALID_DRAFT','草稿 ID 无效');const d=await read(env,await prefix(owner,'drafts')+a.draftId);if(!d)fail('NOT_FOUND','草稿不存在',404);return result(d);}
    case 'bilibili_upload_status':return result(a.uploadId?await getUpload(env,actor(req,true,env),a.uploadId):{upload_url:origin+'/?tab=upload',note:'上传后需另行生成并确认投稿草稿，文件不会自动公开。'});
    default:fail('UNKNOWN_TOOL','未知工具');
  }
}
function readinessKey(env){return 'system/readiness/'+VERSION+'/'+(env.BILI_BACKEND_URL?encodeURIComponent(env.BILI_BACKEND_URL):'sites');}
export async function deploymentCheck(env){
  if(!env.BUCKET)return;
  const key=readinessKey(env);if(await read(env,key))return;
  await put(env,key,{status:'running',started_at:new Date().toISOString()});
  // This Site is owner-private. Use its canonical owner record to verify the
  // real cloud session after login, without copying credentials into logs.
  const owner=env.BILI_OWNER_EMAIL?'owner':null,s=await session(env,owner),authenticated=!!s?.cookies?.SESSDATA;
  const check=async(name,run)=>{let value;try{value=await run();}catch(e){value={error:safeError(e)};}console.log(JSON.stringify({event:'bridge.readiness-detail',version:VERSION,check:name,result:value}));return value;};
  const [video,login,account]=await Promise.all([
    check('video',async()=>{
      const d=await resolveVideo(s,'BV17x411w7KC');
      const [image,transcript,replies,dm]=await Promise.all([
        check('frames',async()=>{const f=await frames(s,d,['7'],1);return {images:f.frames.length>0,image_bytes:f.content.filter(x=>x.type==='image').reduce((n,x)=>n+x.data.length,0),samples:f.frames};}),
        check('subtitles',async()=>{const t=await subtitles(s,d);return {source:t.source,segments:t.segments.length,note:t.note};}),
        check('comments',async()=>({retrieved:true,count:(await comments(s,d,1,5)).comments.length})),
        check('danmaku',async()=>({retrieved:true,count:(await danmaku(s,d,5)).count}))
      ]);
      return {bvid:d.bvid,authenticated,metadata:true,frames:image,subtitles:transcript,comments:replies,danmaku:dm};
    }),
    check('login',async()=>{if(authenticated)return {credential_present:true,qr_generate:null,note:'已有云端登录，不额外生成二维码'};const d=await api(networkSession(env),'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',{source:'main-fe-header'});return {qr_generate:!!(d.qrcode_key&&d.url)};}),
    check('account',async()=>{
      if(!authenticated)return {logged_in:false};
      const a=await accountStatus(env,owner);if(!a.logged_in)return {logged_in:a.logged_in,verified:a.verified,code:a.code};
      const [videos,profile]=await Promise.all([
        check('my_videos',async()=>{await myVideos(s,1);return {retrieved:true};}),
        check('space',async()=>{await space(s);return {retrieved:true};})
      ]);
      return {logged_in:true,verified:a.verified,my_videos:videos,space:profile};
    })
  ]);
  const data={status:'completed',version:VERSION,completed_at:new Date().toISOString(),video,login,account};
  await put(env,key,data);console.log(JSON.stringify({event:'bridge.deployment-check',...data}));
}
async function mcp(req,env,ctx){
  if(req.method==='GET')return new Response(null,{status:405,headers:{allow:'POST'}});
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const b=await bodyJson(req),id=b.id;
  if(b.jsonrpc!=='2.0'||typeof b.method!=='string')return json({jsonrpc:'2.0',id:id??null,error:{code:-32600,message:'Invalid Request'}},400);
  if(id===undefined)return new Response(null,{status:202});
  let value;
  switch(b.method){
    case 'server/discover':value={supportedVersions:['2026-07-28'],capabilities:{tools:{}},serverInfo:{name:'bilibili-bridge',version:VERSION},instructions:INSTRUCTIONS};break;
    case 'initialize':value={protocolVersion:['2026-07-28','2025-11-25','2025-06-18','2025-03-26'].includes(b.params?.protocolVersion)?b.params.protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'bilibili-bridge',version:VERSION},instructions:INSTRUCTIONS};break;
    case 'ping':value={};break;
    // Tool discovery is side-effect free. Do not burst Bilibili requests merely
    // because a host refreshes its tool catalog.
    case 'tools/list':value={tools:TOOLS};break;
    case 'tools/call':try{value=await callTool(env,req,b.params?.name,b.params?.arguments||{});}catch(e){value={isError:true,content:[{type:'text',text:JSON.stringify(safeError(e))}]};}break;
    default:return json({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
  }
  return json({jsonrpc:'2.0',id,result:value});
}
export async function handle(req,env,ctx){
  const url=new URL(req.url),path=url.pathname;
  if(path==='/mcp')return mcp(req,env,ctx);
  if(path==='/health')return json({ok:true,version:VERSION,computer_required:false,mcp:true,storage:!!env.BUCKET});
  if(path==='/'&&req.method==='GET')return new Response(PAGE,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.hdslb.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}});
  if(!path.startsWith('/api/'))return json({error:{code:'NOT_FOUND',message:'页面不存在'}},404);
  const id=actor(req,true,env);
  if(!['GET','POST','PUT','DELETE'].includes(req.method))return json({error:{code:'METHOD_NOT_ALLOWED'}},405);
  if(req.method!=='GET')await verifyBrowserWrite(req,env);
  if(path==='/api/bootstrap'&&req.method==='GET')return json({csrf:await csrf(env,id),version:VERSION,account:await accountStatus(env,id),backend_configured:!!(env.BILI_BACKEND_URL&&env.BILI_BACKEND_KEY),cloud_readiness:await read(env,readinessKey(env)),capabilities:{cloud:true,computer_required:false,video_analysis:true,images:'timeline',account_actions:ACTION_KINDS,publication_requires_confirmation:true}});
  if(path==='/api/login/start'&&req.method==='POST'){const value=await startLogin(env,id);console.log(JSON.stringify({event:'bridge.qr-ready',version:VERSION}));return json(value);}
  if(path==='/api/login/poll'&&req.method==='POST')return json(await pollLogin(env,id,(await bodyJson(req)).id));
  if(path==='/api/logout'&&req.method==='POST'){await remove(env,await prefix(id,'auth')+'session');return json({ok:true,logged_in:false});}
  if(path==='/api/tool'&&req.method==='POST'){const b=await bodyJson(req);return json(await callTool(env,req,b.name,b.arguments||{}));}
  if(path==='/api/drafts'&&req.method==='GET')return json({drafts:await listRecords(env,id,'drafts')});
  if(path==='/api/audit'&&req.method==='GET')return json({events:await listRecords(env,id,'audit',40)});
  if(path==='/api/covers/upload'&&req.method==='POST')return json(await uploadCover(env,id,await bodyJson(req,3*1024*1024)));
  let match=path.match(/^\/api\/drafts\/([a-f0-9-]{36})(\/approve)?$/);
  if(match){if(match[2]&&req.method==='POST')return json(await approveAction(env,id,match[1]));if(!match[2]&&req.method==='GET'){const d=await read(env,await prefix(id,'drafts')+match[1]);return d?json(d):json({error:{code:'NOT_FOUND',message:'草稿不存在'}},404);}}
  if(path==='/api/uploads/start'&&req.method==='POST')return json(await uploadStart(env,id,await bodyJson(req)));
  match=path.match(/^\/api\/uploads\/([a-f0-9-]{36})\/(parts\/(\d+)|complete|transfer\/(start|part|complete))$/);
  if(match){const uploadId=match[1];
    if(match[3]&&req.method==='PUT')return json(await uploadPart(env,id,uploadId,match[3],req));
    if(req.method==='POST'){
      if(match[2]==='complete')return json(await uploadComplete(env,id,uploadId,(await bodyJson(req)).parts));
      if(match[4]==='start')return json(await transferStart(env,id,uploadId));
      if(match[4]==='part')return json(await transferPart(env,id,uploadId,(await bodyJson(req)).index));
      if(match[4]==='complete')return json(await transferComplete(env,id,uploadId));
    }
  }
  return json({error:{code:'NOT_FOUND',message:'接口不存在'}},404);
}
export default {async fetch(req,env,ctx){try{return await handle(req,env,ctx);}catch(e){if(!(e instanceof BridgeError))console.error(JSON.stringify({event:'bridge.error',name:e?.name,message:String(e?.message||'').replace(/(SESSDATA|bili_jct|refresh_token|csrf)[=:][^\s,;]+/gi,'$1=[redacted]').slice(0,250)}));return json({error:safeError(e)},e.status||500);}}};
