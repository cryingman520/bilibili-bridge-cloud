// Read {url,key} from stdin. Never place secrets in command-line arguments.
import {backendFetch} from '../src/transport.js';
import {headers} from '../src/bilibili.js';
let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>12000)throw new Error('Input too large');}
const backend=JSON.parse(raw),results=[];
for(const [name,url]of [['video','https://api.bilibili.com/x/web-interface/view?bvid=BV17x411w7KC'],['qr','https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header']]){
  try{const response=await backendFetch(url,{headers:headers(null)},backend),data=await response.json();results.push({check:name,http:response.status,api_code:data.code,ok:response.ok&&data.code===0&&(name==='qr'?!!(data.data?.url&&data.data?.qrcode_key):!!data.data?.bvid)});}
  catch(e){results.push({check:name,ok:false,code:e.code||'PROBE_FAILED'});}
}
console.log(JSON.stringify({checks:results,ready:results.every(x=>x.ok)}));
if(results.some(x=>!x.ok))process.exitCode=1;
