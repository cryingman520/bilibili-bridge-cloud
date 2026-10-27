import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {publicAddress,callbackURL,signingKey,webhookHeaders,verifyCallback,deliverEvent} from './events.mjs';
const secret='whsec_'+Buffer.alloc(32,7).toString('base64'),subscription={id:'qa-subscription',url:'https://example.com/callback',secret};
test('reject non-public destinations, mappings and invalid schemes',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','100.100.100.200','172.16.1.1','192.168.1.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
 for(const ip of ['1.1.1.1','8.8.8.8','2606:4700::1111'])assert.equal(publicAddress(ip),true,ip);
 for(const url of ['http://example.com','https://user:pass@example.com','https://example.com:8080','https://example.com/#fragment'])assert.throws(()=>callbackURL(url));
});
test('Standard Webhooks signature signs id timestamp and exact body',()=>{
 const body='{"text":"你好"}',headers=webhookHeaders(subscription,'evt1',body,1700000000000);
 assert.equal(headers['webhook-timestamp'],'1700000000');assert.equal(headers['webhook-signature'],'v1,'+createHmac('sha256',Buffer.alloc(32,7)).update('evt1.1700000000.'+body).digest('base64'));
 assert.throws(()=>signingKey('whsec_AA=='));assert.throws(()=>signingKey('bad'));
 const rotating=webhookHeaders({...subscription,previousSecret:'whsec_'+Buffer.alloc(32,8).toString('base64'),previousUntil:1800000000000},'evt1',body,1700000000000);assert.equal(rotating['webhook-signature'].split(' ').length,2);
});
test('callback challenge must be correctly echoed and acknowledged',async()=>{
 await verifyCallback(subscription,async(url,body,headers)=>{assert.equal(url,subscription.url);assert.equal(headers['X-MCP-Subscription-Id'],subscription.id);return {status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})};});
 await assert.rejects(()=>verifyCallback(subscription,async()=>({status:200,body:'{"challenge":"wrong"}'})),/challenge/);
 await assert.rejects(()=>verifyCallback(subscription,async()=>({status:302,body:'{}'})),/challenge/);
});
test('delivery preserves original event id, enforces byte limit and does not follow redirects',async()=>{
 const event={eventId:'qq:original',name:'qq.message.created',data:{text:'你好'}};
 const result=await deliverEvent(subscription,event,async(url,body,headers)=>{assert.equal(headers['webhook-id'],'qq:original');assert.deepEqual(JSON.parse(body),event);return {status:302,body:''};});assert.equal(result.status,302);
 assert.equal((await deliverEvent(subscription,{...event,data:{text:'字'.repeat(90000)}},()=>{throw new Error('Must not call');})).status,413);
});
