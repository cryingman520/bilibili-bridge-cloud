import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {handle} from '../src/index.js';
import {PNG} from 'pngjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.BRIDGE_QA_PLAYWRIGHT||'playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const fixture=new PNG({width:2,height:2});fixture.data.fill(255);const fixturePng=PNG.sync.write(fixture);
try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
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
    return route.fulfill({status:400,json:{error:{message:'UI QA does not call Bilibili'}}});
  });
  await page.goto('https://bridge.test/');await page.waitForTimeout(300);
  await mkdir('qa',{recursive:true});await page.screenshot({path:'qa/desktop.png',fullPage:true});
  const desktopOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
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
  const output={pageErrors:errors,desktopOverflow,mobileOverflow,mobileUploadOverflow,qrImageRendered,coverUploaded,tabs};
  await writeFile('qa/report.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output));
  if(errors.length||desktopOverflow||mobileOverflow||mobileUploadOverflow||!qrImageRendered||!coverUploaded)process.exitCode=1;
}finally{await browser.close();}
