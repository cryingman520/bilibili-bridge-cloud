import test from 'node:test';
import assert from 'node:assert/strict';
import {search,recommend,shuffleVideos} from '../src/bilibili.js';
import {isDiscovery,createSearchPolicy} from '../backend/search-policy.mjs';
import {handle,callTool} from '../src/index.js';

const nav={wbi_img:{img_url:'https://i0.hdslb.com/'+('a'.repeat(32))+'.png',sub_url:'https://i0.hdslb.com/'+('b'.repeat(32))+'.png'}};
const first={bvid:'BV17x411w7KC',title:'old',pubdate:1600000000,duration:61,owner:{name:'作者'},goto:'av'};
const second={bvid:'BV1H4411q7Qx',title:'new',pubdate:1792840000,duration:90,owner:{name:'作者'},goto:'av'};
async function mock(run,fn){const original=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=original;}}
const ok=data=>Response.json({code:0,data});

test('the original keyword/limit tool call supports a real keyword-free homepage feed',async()=>{
  let calls=0;
  await mock(async()=>{
    const r=await callTool({},new Request('https://bridge.test/mcp'),'bilibili_search',{keyword:'',limit:2});
    const v=JSON.parse(r.content[0].text);assert.equal(v.source,'bilibili_home_recommendations');assert.equal(v.shuffled,true);assert.equal(v.videos.length,2);assert.equal(calls,2);
  },async input=>{calls++;const u=new URL(input);if(u.pathname.endsWith('/nav'))return ok(nav);assert.equal(u.pathname,'/x/web-interface/wbi/index/top/feed/rcmd');assert.equal(u.searchParams.has('keyword'),false);return ok({item:[first,second]});});
});

test('the original keyword/limit tool call requests newest-first search while explicit relevance remains available',async()=>{
  for(const order of [undefined,'totalrank'])await mock(async()=>{
    const r=await callTool({},new Request('https://bridge.test/mcp'),'bilibili_search',{keyword:'数学',limit:2,...order?{order}:{}});
    const v=JSON.parse(r.content[0].text);assert.equal(v.order,order||'pubdate');assert.deepEqual(v.videos.map(x=>x.bvid),order?[first.bvid,second.bvid]:[second.bvid,first.bvid]);
  },async input=>{const u=new URL(input);if(u.pathname.endsWith('/nav'))return ok(nav);assert.equal(u.searchParams.get('order'),order||'pubdate');return ok({result:[first,second]});});
});

test('newest-first search requests publication sorting and the requested page, and returns actual publication dates',async()=>{
  let calls=0;
  await mock(async()=>{
    const r=await search(null,'数学',10,{order:'pubdate',page:2});assert.equal(r.page,2);assert.equal(r.order,'pubdate');assert.equal(r.has_more,true);assert.deepEqual(r.videos.map(x=>x.bvid),[second.bvid,first.bvid]);assert.equal(r.videos[0].published_at,second.pubdate);assert.equal(r.videos[0].published_at_iso,new Date(second.pubdate*1000).toISOString());assert.equal(calls,2);
  },async input=>{calls++;const u=new URL(input);if(u.pathname.endsWith('/nav'))return ok(nav);assert.equal(u.searchParams.get('order'),'pubdate');assert.equal(u.searchParams.get('page'),'2');assert.ok(u.searchParams.has('w_rid'));return ok({result:[first,second],numPages:3,numResults:60});});
});

test('home recommendations need no keyword, sign the refresh batch and filter ads, live cards and duplicates',async()=>{
  await mock(async()=>{
    const r=await recommend({cookies:{SESSDATA:'private'}},{page:2,shuffle:false});assert.deepEqual(r.videos.map(x=>x.bvid),[first.bvid,second.bvid]);assert.equal(r.source,'bilibili_home_recommendations');assert.equal(r.account_context,'logged_in');assert.equal(r.next_page,3);assert.equal(r.shuffled,false);assert.equal(r.videos[0].duration,'1:01');
  },async input=>{const u=new URL(input);if(u.pathname.endsWith('/nav'))return ok(nav);assert.equal(u.pathname,'/x/web-interface/wbi/index/top/feed/rcmd');assert.equal(u.searchParams.get('fresh_idx'),'2');assert.ok(u.searchParams.has('w_rid'));assert.equal(u.searchParams.has('keyword'),false);return ok({item:[first,{...second,goto:'live'},{...second,ad_info:{type:1}},second,first]});});
});

test('public popular results are labeled as public and do not silently substitute for homepage recommendations',async()=>{
  let calls=0;await mock(async()=>{
    const r=await recommend(null,{source:'popular',page:3,shuffle:false});assert.equal(r.source,'bilibili_popular');assert.equal(r.account_context,'guest');assert.match(r.note,/不表示账号个性化/);assert.equal(calls,1);
  },async input=>{calls++;const u=new URL(input);assert.equal(u.pathname,'/x/web-interface/popular');assert.equal(u.searchParams.get('pn'),'3');assert.equal(u.searchParams.has('keyword'),false);return ok({list:[first,second],no_more:false});});
  calls=0;await mock(async()=>{await assert.rejects(()=>recommend(null),{code:'BILI_RISK_CONTROL'});assert.equal(calls,1);},async()=>{calls++;return new Response('blocked',{status:412});});
});

test('shuffling permutes only the returned batch without fabricating or changing videos',()=>{
  const input=[first,second],output=shuffleVideos(input,()=>0);assert.deepEqual(output,[second,first]);assert.deepEqual(input,[first,second]);assert.equal(output[0],second);
});

test('recommendations share the same bounded cooldown as search instead of opening an unrestricted alternate endpoint',async()=>{
  const searchUrl=new URL('https://api.bilibili.com/x/web-interface/wbi/search/type?keyword=test'),homeUrl=new URL('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd');assert.equal(isDiscovery(searchUrl),true);assert.equal(isDiscovery(homeUrl),true);assert.equal(isDiscovery(new URL('https://api.bilibili.com/x/web-interface/popular')),true);
  const policy=createSearchPolicy();let calls=0;await policy.run(searchUrl,{},async()=>{calls++;return {status:412,payload:new Uint8Array(),signals:{risk:true}};});await assert.rejects(()=>policy.run(homeUrl,{},async()=>{calls++;}),{code:'BACKEND_SEARCH_COOLDOWN'});assert.equal(calls,1);
});

test('recommendation options are validated before making upstream requests',async()=>{
  let calls=0;await mock(async()=>{
    await assert.rejects(()=>recommend(null,{source:'unknown'}),{code:'INVALID_SOURCE'});await assert.rejects(()=>search(null,'x',2,{order:'oldest'}),{code:'INVALID_ORDER'});
    const request=new Request('https://bridge.test/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bilibili_recommend',arguments:{shuffle:'yes'}}})});const r=await (await handle(request,{})).json();assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/INVALID_INPUT/);assert.equal(calls,0);
  },async()=>{calls++;throw Error('unexpected upstream');});
});
