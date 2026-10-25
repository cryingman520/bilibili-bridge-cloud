import test from 'node:test';
import assert from 'node:assert/strict';
import {saveSession,prefix,put,read} from '../src/platform.js';
import {prepareAction,sendCommentDraft} from '../src/actions.js';
import {callTool} from '../src/index.js';

class Bucket {
  values=new Map();revision=0;
  async get(key){const v=this.values.get(key);return v?{etag:v.etag,json:async()=>JSON.parse(v.body)}:null;}
  async put(key,body,options={}){if(options.onlyIf?.etagMatches&&this.values.get(key)?.etag!==options.onlyIf.etagMatches)return null;const etag=String(++this.revision);this.values.set(key,{body,etag});return {etag};}
}
const credentials={mid:123,name:'test',cookies:{SESSDATA:'test-session',bili_jct:'test-csrf'}};
const ok=data=>Response.json({code:0,data});
async function fixture(run,{navMid=123,post}={}){
  const env={BUCKET:new Bucket(),BILI_CREDENTIAL_KEY:Buffer.alloc(32,9).toString('base64')};
  await saveSession(env,'owner',credentials);let posts=0,navs=0;const previous=globalThis.fetch;
  globalThis.fetch=async(input,options={})=>{
    const u=new URL(input);
    if(options.method==='POST'){
      assert.equal(u.pathname,'/x/v2/reply/add');assert.equal(new URLSearchParams(options.body).get('csrf'),'test-csrf');posts++;
      return post?await post():ok({rpid_str:'456'});
    }
    if(u.pathname==='/x/web-interface/nav'){navs++;return ok({isLogin:true,mid:navMid,uname:'current name'});}
    assert.equal(u.pathname,'/x/web-interface/view');return ok({bvid:'BV17x411w7KC',aid:42,cid:9,title:'test video',duration:10});
  };
  try{await run({env,counts:()=>({posts,navs}),draft:()=>prepareAction(env,'owner','comment.create',{url:'BV17x411w7KC',message:'specific authorized comment'},'https://site.test')});}
  finally{globalThis.fetch=previous;}
}
const request=owner=>new Request('https://site.test/mcp',{headers:owner?{'oai-authenticated-user-id':owner}:{}});
const value=r=>JSON.parse(r.content[0].text);

test('preparation stays a draft, and the authenticated comment tool sends that exact draft once without a browser',async()=>{
  await fixture(async({env,draft,counts})=>{
    const d=await draft();assert.equal(d.status,'pending');assert.equal(counts().posts,0);
    const r=value(await callTool(env,request('owner'),'bilibili_send_comment',{draftId:d.id}));
    assert.equal(r.comment_id,'456');assert.equal(r.draft.status,'completed');assert.equal(r.draft.approved_via,'mcp');assert.equal(r.draft.payload.message,d.payload.message);
    assert.equal(counts().posts,1);assert.match(r.comment_url,/#reply456$/);
    const repeated=value(await callTool(env,request('owner'),'bilibili_send_comment',{draftId:d.id}));
    assert.equal(repeated.reused,true);assert.equal(repeated.comment_id,'456');assert.deepEqual(counts(),{posts:1,navs:1});
  });
});

test('the documented original-tool compatibility route sends only an unchanged existing comment draft',async()=>{
  await fixture(async({env,draft,counts})=>{
    const d=await draft();
    for(const payload of [{delivery:'send',draftId:d.id,message:'changed'},{delivery:'unknown',draftId:d.id}])await assert.rejects(()=>callTool(env,request('owner'),'bilibili_prepare_action',{kind:'comment.create',payload}),{code:'INVALID_DELIVERY'});
    assert.equal(counts().posts,0);
    const r=value(await callTool(env,request('owner'),'bilibili_prepare_action',{kind:'comment.create',payload:{delivery:'send',draftId:d.id}}));
    assert.equal(r.comment_id,'456');assert.equal(counts().posts,1);
  });
});

test('comment sending requires a verified platform identity and draft ownership',async()=>{
  await fixture(async({env,draft,counts})=>{
    const d=await draft();
    await assert.rejects(()=>callTool(env,request(),'bilibili_send_comment',{draftId:d.id}),{code:'SIGN_IN_REQUIRED'});
    await assert.rejects(()=>callTool(env,request('another'),'bilibili_send_comment',{draftId:d.id}),{code:'NOT_FOUND'});
    assert.equal(counts().posts,0);
  });
});

test('a changed live Bilibili account blocks sending even when the stored session identity is unchanged',async()=>{
  await fixture(async({env,draft,counts})=>{
    const d=await draft();await assert.rejects(()=>sendCommentDraft(env,'owner',d.id),{code:'ACCOUNT_CHANGED'});assert.equal(counts().posts,0);
    assert.equal((await read(env,await prefix('owner','drafts')+d.id)).status,'pending');
  },{navMid:999});
});

test('non-comment and expired drafts cannot be sent through the comment tool',async()=>{
  await fixture(async({env,draft,counts})=>{
    const other=await prepareAction(env,'owner','dynamic.publish',{text:'not a video comment'},'https://site.test');
    await assert.rejects(()=>sendCommentDraft(env,'owner',other.id),{code:'COMMENT_ONLY'});
    const d=await draft();await put(env,await prefix('owner','drafts')+d.id,{...d,expires_at:Date.now()-1});
    await assert.rejects(()=>sendCommentDraft(env,'owner',d.id),{code:'DRAFT_EXPIRED'});assert.equal(counts().posts,0);
  });
});

test('concurrent calls cannot publish the same comment twice',async()=>{
  await fixture(async({env,draft,counts})=>{
    const d=await draft();const r=await Promise.allSettled([sendCommentDraft(env,'owner',d.id),sendCommentDraft(env,'owner',d.id)]);
    assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.find(x=>x.status==='rejected').reason.code,'ALREADY_HANDLED');assert.equal(counts().posts,1);
  },{post:async()=>{await new Promise(resolve=>setImmediate(resolve));return ok({rpid_str:'456'});}});
});

for(const [name,post,code]of [
  ['lost response',async()=>{throw new TypeError('connection closed');},undefined],
  ['missing comment ID',async()=>ok({}),'COMMENT_SEND_UNVERIFIED'],
  ['risk response',async()=>new Response('blocked',{status:412}),'BILI_RISK_CONTROL'],
])test(name+' is preserved as uncertain and is never automatically sent again',async()=>{
  await fixture(async({env,draft,counts})=>{
    const d=await draft();await assert.rejects(()=>sendCommentDraft(env,'owner',d.id),code?{code}:undefined);
    assert.equal((await read(env,await prefix('owner','drafts')+d.id)).status,'needs_verification');
    await assert.rejects(()=>sendCommentDraft(env,'owner',d.id),{code:'ALREADY_HANDLED'});assert.equal(counts().posts,1);
  },{post});
});
