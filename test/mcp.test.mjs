import test from 'node:test';
import assert from 'node:assert/strict';
import {handle,TOOLS} from '../src/index.js';
import {VERSION} from '../src/platform.js';
const req=b=>new Request('https://bridge.test/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
test('new MCP discovery and legacy initialization both succeed',async()=>{
  const a=await (await handle(req({jsonrpc:'2.0',id:1,method:'server/discover'}),{})).json();
  assert.ok(a.result.supportedVersions.includes('2026-07-28'));
  const b=await (await handle(req({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-06-18'}}),{})).json();
  assert.equal(b.result.protocolVersion,'2025-06-18');assert.equal(b.result.serverInfo.version,VERSION);
});
test('discovery exposes all intended tools with no public posting executor',async()=>{
  const r=await (await handle(req({jsonrpc:'2.0',id:1,method:'tools/list'}),{},{waitUntil(){assert.fail('tool discovery must not start upstream probes');}})).json();
  assert.equal(r.result.tools.length,16);assert.ok(r.result.tools.some(t=>t.name==='bilibili_prepare_action'));
  assert.ok(!r.result.tools.some(t=>/approve|execute|commit/.test(t.name)));
  assert.equal(r.result.tools.find(t=>t.name==='bilibili_prepare_action').annotations.readOnlyHint,false);
});
test('MCP errors do not leak source, credentials or stack traces',async()=>{
  const r=await (await handle(req({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'unknown',arguments:{}}}),{})).json();
  assert.equal(r.result.isError,true);assert.ok(r.result.content[0].text.includes('UNKNOWN_TOOL'));assert.ok(!JSON.stringify(r).includes('stack'));
});
test('private account APIs require authenticated platform identity',async()=>{
  await assert.rejects(()=>handle(new Request('https://bridge.test/api/bootstrap'),{}),{code:'SIGN_IN_REQUIRED'});
});
test('readiness shows independent cloud runtime',async()=>{
  const r=await (await handle(new Request('https://bridge.test/health'),{BUCKET:{}})).json();assert.equal(r.computer_required,false);assert.equal(r.mcp,true);
});

test('a stored search cooldown stops before fetching WBI material, even after backend restart',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('must not call Bilibili');};
  const env={BUCKET:{async get(key){return key.endsWith('/diagnostics/search')?{json:async()=>({status:'error',checked_at:new Date().toISOString(),error:{code:'BILI_RISK_CONTROL'}})}:null;}}};
  try{
    const request=new Request('https://bridge.test/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bilibili_search',arguments:{keyword:'test'}}})});
    const result=await (await handle(request,env)).json();assert.equal(result.result.isError,true);assert.equal(JSON.parse(result.result.content[0].text).code,'BILI_SEARCH_COOLDOWN');assert.equal(calls,0);
  }finally{globalThis.fetch=original;}
});
