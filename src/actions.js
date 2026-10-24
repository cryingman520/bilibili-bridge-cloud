import {fail,text,integer,numericId,now,prefix,read,put,audit,lockRecord,session} from './platform.js';
import {resolveVideo,postForm,postJson,api} from './bilibili.js';
export const ACTION_KINDS=['comment.create','reply.create','danmaku.send','dynamic.publish','profile.update','space.notice','video.submit','video.edit'];
export async function prepareAction(env,id,kind,payload,origin) {
  if(!ACTION_KINDS.includes(kind))fail('UNKNOWN_ACTION','不支持此账号操作');
  const s=await session(env,id,true),p={};
  if(['comment.create','reply.create','danmaku.send'].includes(kind)){
    const v=await resolveVideo(s,text(payload.url,'视频地址',2048));
    Object.assign(p,{bvid:v.bvid,aid:v.aid,cid:v.cid,video_title:v.title,message:text(payload.message,'发送内容',kind==='danmaku.send'?100:1000)});
    if(kind==='reply.create'){p.root=numericId(payload.root,'根评论 ID');p.parent=numericId(payload.parent||payload.root,'回复目标 ID');}
    if(kind==='danmaku.send'){
      const t=Number(payload.progress_seconds);if(!Number.isFinite(t)||t<0||t>v.duration)fail('INVALID_PROGRESS','弹幕时间必须在视频时长内');
      p.progress=Math.round(t*1000);p.color=integer(payload.color??16777215,'弹幕颜色',0,16777215);p.mode=integer(payload.mode??1,'弹幕模式',1,5);
      if(![1,4,5].includes(p.mode))fail('INVALID_MODE','只支持滚动、顶部和底部弹幕');
    }
  } else if(kind==='dynamic.publish')p.text=text(payload.text,'动态正文',2000);
  else if(kind==='profile.update') {if(typeof payload.sign!=='string'||payload.sign.length>70)fail('INVALID_SIGN','个人签名不能超过 70 字符');p.sign=payload.sign;}
  else if(kind==='space.notice') {if(typeof payload.notice!=='string'||payload.notice.length>150)fail('INVALID_NOTICE','空间公告不能超过 150 字符');p.notice=payload.notice;}
  else if(kind==='video.submit'||kind==='video.edit'){
    if(!/^[a-f0-9-]{36}$/.test(String(payload.uploadId)))fail('UPLOAD_REQUIRED','请先在云端页面上传并完成传输');
    const upload=await read(env,await prefix(id,'uploads')+payload.uploadId);
    if(!upload||upload.status!=='transferred'||String(upload.accountMid)!==String(s.mid))fail('UPLOAD_NOT_READY','视频尚未传输完成，或上传账号已变化');
    p.uploadId=payload.uploadId;p.title=text(payload.title,'稿件标题',80);p.desc=String(payload.desc||'').slice(0,2000);p.tid=integer(payload.tid,'分区 ID',1,10000);
    p.tag=text(payload.tag,'稿件标签',250);p.copyright=integer(payload.copyright??1,'创作类型',1,2);
    if(p.copyright===2)p.source=text(payload.source,'转载来源',200);
    if(payload.cover){const c=new URL(payload.cover);if(c.protocol!=='https:'||!c.hostname.endsWith('.hdslb.com'))fail('INVALID_COVER','封面必须是已上传到 B站的图片地址');p.cover=c.href;}
    p.videos=[{filename:upload.biliFilename,title:p.title,desc:''}];
    if(kind==='video.edit'){
      p.aid=numericId(payload.aid,'稿件 av 号');
      const existing=await api(s,'https://member.bilibili.com/x/web/archive/view',{aid:p.aid});
      if(!existing?.archive||!Array.isArray(existing.videos))fail('EDIT_UNAVAILABLE','无法读取原稿件的完整分P信息，未创建编辑操作',502);
      // Preserve all existing parts and append the uploaded part; never silently replace cids.
      p.videos=[...existing.videos.map(v=>({cid:v.cid,filename:v.filename,title:v.title,desc:v.desc||''})),...p.videos];
      p.preserve_existing_parts=true;
    }
  }
  const d={id:crypto.randomUUID(),kind,payload:p,status:'pending',account:{mid:s.mid,name:s.name},created_at:now(),expires_at:Date.now()+24*3600000};
  await put(env,await prefix(id,'drafts')+d.id,d);
  await audit(env,id,{type:'draft.created',draftId:d.id,kind});
  return {...d,confirmation_url:origin+'/?draft='+d.id,note:'尚未向 B站发布。请打开确认链接，检查账号、目标与内容后点击确认。'};
}
export async function approveAction(env,id,draftId) {
  if(!/^[a-f0-9-]{36}$/.test(draftId))fail('INVALID_DRAFT','操作草稿 ID 无效');
  const key=await prefix(id,'drafts')+draftId,d=await read(env,key);if(!d)fail('NOT_FOUND','操作草稿不存在',404);
  const s=await session(env,id,true);
  if(String(s.mid)!==String(d.account.mid))fail('ACCOUNT_CHANGED','登录账号已变更，请重新生成操作草稿',409);
  if(d.expires_at<Date.now())fail('DRAFT_EXPIRED','操作草稿已过期，请重新生成',409);
  const locked=await lockRecord(env,key,{status:'sending',approved_at:now()});
  try{
    const result=await execute(s,locked);
    const saved={...locked,status:'completed',completed_at:now(),result};await put(env,key,saved);
    await audit(env,id,{type:'action.completed',kind:d.kind,draftId,accountMid:s.mid});return {draft:saved,result};
  }catch(e){
    const error={code:e.code||'NETWORK_ERROR',message:String(e.message).slice(0,400)};
    // A response may be lost after an upstream side effect: never retry automatically.
    await put(env,key,{...locked,status:'needs_verification',error,failed_at:now()});
    await audit(env,id,{type:'action.needs_verification',kind:d.kind,draftId,error});throw e;
  }
}
async function execute(s,d) {
  const p=d.payload;
  switch(d.kind){
    case 'comment.create':return postForm(s,'/x/v2/reply/add',{type:1,oid:p.aid,message:p.message,plat:1});
    case 'reply.create':return postForm(s,'/x/v2/reply/add',{type:1,oid:p.aid,root:p.root,parent:p.parent,message:p.message,plat:1});
    case 'danmaku.send':return postForm(s,'/x/v2/dm/post',{type:1,oid:p.cid,bvid:p.bvid,msg:p.message,progress:p.progress,color:p.color,mode:p.mode,fontsize:25,pool:0,rnd:Date.now()*1000});
    case 'profile.update':return postForm(s,'/x/member/web/sign/update',{user_sign:p.sign});
    case 'space.notice':return postForm(s,'/x/space/notice/set',{notice:p.notice});
    case 'dynamic.publish':return postJson(s,'/x/dynamic/feed/create/dyn',{dyn_req:{content:{contents:[{raw_text:p.text,type:1,biz_id:''}]},scene:1,attach_card:null,upload_id:s.mid+'_'+Math.floor(Date.now()/1000)+'_'+Math.floor(1000+Math.random()*9000),meta:{app_meta:{from:'create.dynamic.web',mobi_app:'web'}}}},{platform:'web','x-bili-device-req-json':JSON.stringify({platform:'web',device:'pc'}),'x-bili-web-req-json':JSON.stringify({spm_id:'333.999'})});
    case 'video.submit':return postJson(s,'https://member.bilibili.com/x/vu/web/add/v3',studio(p),{t:Date.now()});
    case 'video.edit':return postJson(s,'https://member.bilibili.com/x/vu/web/edit',{...studio(p),aid:Number(p.aid)},{t:Date.now()});
    default:fail('UNKNOWN_ACTION','未知操作');
  }
}
function studio(p){return {copyright:p.copyright,source:p.source||'',tid:p.tid,cover:p.cover||'',title:p.title,tag:p.tag,desc_format_id:0,desc:p.desc,dynamic:'',subtitle:{open:0,lan:''},interactive:0,videos:p.videos,act_reserve_create:0,no_reprint:p.copyright===1?1:0,open_elec:0};}
