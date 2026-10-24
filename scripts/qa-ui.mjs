import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {handle} from '../src/index.js';
import {PNG} from 'pngjs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.BRIDGE_QA_PLAYWRIGHT||'playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const fixture=new PNG({width:2,height:2});fixture.data.fill(255);const fixturePng=PNG.sync.write(fixture);
try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],discoveryRequests=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://i0.hdslb.com/**',route=>route.fulfill({contentType:'image/png',body:fixturePng}));
  await page.route('https://bridge.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/'){const response=await handle(new Request('https://bridge.test/'),{});return route.fulfill({headers:Object.fromEntries(response.headers),body:await response.text()});}
    if(path==='/api/bootstrap')return route.fulfill({json:{csrf:'qa-only',version:'3.0.0',account:{logged_in:false,verified:true,message:'尚未连接 B站账号'},capabilities:{cloud:true,computer_required:false}}});
    if(path==='/api/drafts')return route.fulfill({json:{drafts:[]}});
    if(path==='/api/audit')return route.fulfill({json:{events:[]}});
    if(path==='/api/login/start')return route.fulfill({json:{id:'qa-login',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><rect x="30" y="30" width="140" height="140" fill="black"/></svg>',expires_at:Date.now()+180000}});
    if(path==='/api/login/poll')return route.fulfill({json:{status:'waiting',message:'QA only'}});
    if(path==='/api/covers/upload')return route.fulfill({json:{url:'https://i0.hdslb.com/bfs/archive/qa-cover.jpg'}});
    if(path==='/api/tool'){
      const request=route.request().postDataJSON();discoveryRequests.push(request);
      if(['bilibili_search','bilibili_recommend'].includes(request.name)){
        const args=request.arguments||{},feed=request.name==='bilibili_recommend';
        const value={videos:[{bvid:'BV17x411w7KC',title:'测试视频一',uploader:'测试作者',duration:'2:01',published_at:1792840000,cover:'https://i0.hdslb.com/qa.jpg'},{bvid:'BV1H4411q7Qx',title:'测试视频二',uploader:'测试作者',duration:'3:02',published_at:1792800000}],page:args.page,order:args.order,has_more:true,next_page:args.page+1,note:feed?(args.source==='home'?'首页推荐，由账号设置决定。':'公共热门，不表示个性化推荐。'):'发布时间从新到旧'};
        return route.fulfill({json:{content:[{type:'text',text:JSON.stringify(value)}]}});
      }
    }
    return route.fulfill({status:400,json:{error:{message:'UI QA does not call Bilibili'}}});
  });
  await page.goto('https://bridge.test/');await page.waitForTimeout(300);
  await mkdir('qa',{recursive:true});await page.screenshot({path:'qa/desktop.png',fullPage:true});
  const desktopOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  assert.equal(discoveryRequests.length,0,'opening the workspace must not automatically fetch recommendations');
  await page.locator('#search-keyword').fill('测试');await page.locator('#search-submit').click();await page.waitForFunction(()=>document.querySelectorAll('.discovery-card').length===2);
  assert.equal(discoveryRequests.at(-1).arguments.order,'pubdate');assert.equal(discoveryRequests.at(-1).arguments.page,1);
  await page.locator('#search-next').click();await page.waitForFunction(()=>document.querySelector('#result-count').textContent.includes('第 2 批'));assert.equal(discoveryRequests.at(-1).arguments.page,2);
  await page.locator('#feed-load').click();await page.waitForFunction(()=>document.querySelector('.discovery-note').textContent.includes('首页推荐'));assert.equal(discoveryRequests.at(-1).name,'bilibili_recommend');assert.equal('keyword' in discoveryRequests.at(-1).arguments,false);
  await page.locator('#feed-load').click();await page.waitForFunction(()=>document.querySelector('#result-count').textContent.includes('第 2 批'));assert.equal(discoveryRequests.at(-1).arguments.page,2);
  await page.locator('#feed-source').selectOption('popular');await page.locator('#feed-load').click();await page.waitForFunction(()=>document.querySelector('.discovery-note').textContent.includes('公共热门'));assert.equal(discoveryRequests.at(-1).arguments.page,1);assert.equal(discoveryRequests.at(-1).arguments.source,'popular');
  await page.screenshot({path:'qa/discovery-desktop.png',fullPage:true});
  await page.locator('.nav button').nth(1).click();await page.locator('#login-start').click();
  await page.waitForFunction(()=>{const image=document.querySelector('#qr-image');return image.complete&&image.naturalWidth>0;},{},{timeout:5000});
  const qrImageRendered=await page.locator('#qr-image').evaluate(img=>img.naturalWidth>0);
  await page.screenshot({path:'qa/qr-desktop.png',fullPage:true});
  await page.locator('.nav button').nth(2).click();
  await page.locator('#cover-file').setInputFiles({name:'qa-cover.png',mimeType:'image/png',buffer:fixturePng});await page.locator('#cover-upload').click();
  await page.waitForFunction(()=>document.querySelector('#upload-cover').value==='https://i0.hdslb.com/bfs/archive/qa-cover.jpg');
  const coverUploaded=await page.locator('#cover-preview').evaluate(img=>!img.hidden);
  await page.screenshot({path:'qa/upload-desktop.png',fullPage:true});
  await page.locator('.nav button').nth(0).click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'qa/mobile.png',fullPage:true});
  const mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  await page.locator('.nav button').nth(2).click();await page.screenshot({path:'qa/upload-mobile.png',fullPage:true});
  const mobileUploadOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  const tabs=await page.locator('.nav button').allTextContents();
  const output={pageErrors:errors,desktopOverflow,mobileOverflow,mobileUploadOverflow,qrImageRendered,coverUploaded,discoveryRequests:discoveryRequests.map(x=>({name:x.name,args:x.arguments})),tabs};
  await writeFile('qa/report.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output));
  if(errors.length||desktopOverflow||mobileOverflow||mobileUploadOverflow||!qrImageRendered||!coverUploaded)process.exitCode=1;
}finally{await browser.close();}
