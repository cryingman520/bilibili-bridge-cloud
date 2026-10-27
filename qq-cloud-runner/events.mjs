import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';

export function signingKey(secret){
 if(typeof secret!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))throw new Error('Invalid signing key');
 const key=Buffer.from(secret.slice(6),'base64');
 if(key.length<24||key.length>64||key.toString('base64').replace(/=+$/,'')!==secret.slice(6).replace(/=+$/,''))throw new Error('Invalid signing key');
 return key;
}
export function webhookHeaders(subscription,eventId,body,now=Date.now()){
 const timestamp=String(Math.floor(now/1000));
 const keys=[subscription.secret,...(subscription.previousSecret&&now<subscription.previousUntil?[subscription.previousSecret]:[])];
 return {'Content-Type':'application/json','webhook-id':eventId,'webhook-timestamp':timestamp,'webhook-signature':keys.map(s=>'v1,'+createHmac('sha256',signingKey(s)).update(eventId+'.'+timestamp+'.'+body).digest('base64')).join(' '),'X-MCP-Subscription-Id':subscription.id};
}
export function publicAddress(address){
 const family=isIP(address);
 if(family===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===88&&c===99))||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));}
 // Global unicast only; reject IPv4 mappings, local, multicast and documentation ranges.
 if(family===6)return /^[23]/i.test(address)&&!/^2001:(?:db8|0*0:|0*2:|0*10:)/i.test(address)&&!address.includes('.');
 return false;
}
export function callbackURL(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443'||u.href.length>4096)throw new Error('Invalid callback URL');return u;}
export async function webhookPost(url,body,headers){
 const u=callbackURL(url),host=u.hostname.replace(/^\[|\]$/g,'');
 const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw new Error('Non-public callback destination');
 const pinned=addresses[0];
 return new Promise((resolve,reject)=>{
  const req=https.request(u,{method:'POST',headers:{...headers,'Content-Length':Buffer.byteLength(body)},lookup:(_host,options,cb)=>options?.all?cb(null,[pinned]):cb(null,pinned.address,pinned.family)},res=>{
   let bytes=0;const chunks=[];
   res.on('data',c=>{bytes+=c.length;if(bytes>262144){res.destroy(new Error('Callback response too large'));return;}chunks.push(c);});
   res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
  });
  const timeout=setTimeout(()=>req.destroy(new Error('Callback timeout')),10000);timeout.unref();
  req.on('close',()=>clearTimeout(timeout));req.on('error',reject);req.end(body);
 });
}
export async function verifyCallback(subscription,post=webhookPost){
 signingKey(subscription.secret);callbackURL(subscription.url);
 const challenge=randomUUID(),body=JSON.stringify({type:'verification',challenge}),eventId='verify_'+randomUUID();
 const response=await post(subscription.url,body,webhookHeaders(subscription,eventId,body));
 if(response.status<200||response.status>=300)throw new Error('Callback challenge HTTP '+response.status);
 let echoed;try{echoed=JSON.parse(response.body).challenge;}catch{throw new Error('Callback challenge failed');}
 if(typeof echoed!=='string')throw new Error('Callback challenge failed');
 const a=Buffer.from(challenge),b=Buffer.from(echoed);if(a.length!==b.length||!timingSafeEqual(a,b))throw new Error('Callback challenge failed');
 return {verified:true};
}
export async function deliverEvent(subscription,event,post=webhookPost){
 const body=JSON.stringify(event);if(Buffer.byteLength(body)>262144)return {status:413};
 const response=await post(subscription.url,body,webhookHeaders(subscription,event.eventId,body));return {status:response.status};
}
