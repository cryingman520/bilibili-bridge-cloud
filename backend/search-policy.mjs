import {createHash} from 'node:crypto';

export const isSearch=target=>target.hostname==='api.bilibili.com'&&['/x/web-interface/search/type','/x/web-interface/wbi/search/type'].includes(target.pathname);

// One bounded queue across all callers of this single-instance backend. No
// alternate endpoints, credential rotation or retries after a risk response.
export function createSearchPolicy({clock=Date.now,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),intervalMs=2000,cacheMs=120000,cooldownMs=120000,maxQueueMs=15000}={}){
  const cache=new Map(),inflight=new Map();let tail=Promise.resolve(),nextAt=0,blockedUntil=0;
  const fail=(code,status,extra={})=>Object.assign(new Error(code),{code,status,...extra});
  const checkBlock=()=>{if(clock()<blockedUntil)throw fail('BACKEND_SEARCH_COOLDOWN',429,{retryAfter:Math.ceil((blockedUntil-clock())/1000)});};
  return {async run(target,headers,load){
    const url=new URL(target);for(const key of ['wts','w_rid'])url.searchParams.delete(key);url.searchParams.sort();
    const key=createHash('sha256').update(headers.cookie||'').update('\n').update(url.href).digest('hex');
    for(const [k,value]of cache)if(value.expires<=clock())cache.delete(k);
    checkBlock();
    const cached=cache.get(key);if(cached)return {...cached.value,cacheStatus:'hit'};
    if(inflight.has(key))return {...await inflight.get(key),cacheStatus:'shared'};
    if(inflight.size>=8)throw fail('BACKEND_BUSY',503);
    const enqueued=clock();
    const task=tail.then(async()=>{
      checkBlock();
      if(clock()-enqueued>maxQueueMs)throw fail('BACKEND_BUSY',503);
      const wait=Math.max(0,nextAt-clock());if(wait)await delay(wait);
      checkBlock();if(clock()-enqueued>maxQueueMs)throw fail('BACKEND_BUSY',503);
      nextAt=clock()+intervalMs;
      let value;
      try{value=await load();}catch(e){nextAt=Math.max(nextAt,clock()+intervalMs);throw e;}
      if(value.signals.risk){
        const requested=Number(value.retryAfter);
        blockedUntil=clock()+Math.max(cooldownMs,Number.isFinite(requested)?Math.min(3600000,Math.max(0,requested*1000)):0);
        cache.clear();
      }else if(value.status===200&&value.signals.upstream_code===0&&value.payload.length<=1024*1024){
        if(cache.size>=32)cache.delete(cache.keys().next().value);
        cache.set(key,{expires:clock()+cacheMs,value});
      }
      return {...value,cacheStatus:'miss'};
    });
    tail=task.then(()=>{},()=>{});inflight.set(key,task);
    try{return await task;}finally{inflight.delete(key);}
  }};
}
