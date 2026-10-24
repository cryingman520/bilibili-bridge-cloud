import jpeg from 'jpeg-js';
import {PNG} from 'pngjs';
import {fail} from '../src/platform.js';

export function cropFrame(payload,crop){
  const {x,y,width,height}=crop||{};
  if(![x,y,width,height].every(Number.isSafeInteger)||x<0||y<0||width<1||height<1||width>1920||height>1080)fail('BACKEND_FRAME_INPUT','时间轴裁剪坐标无效',400);
  let image;
  try{
    if(payload[0]===0xff&&payload[1]===0xd8)image=jpeg.decode(payload,{useTArray:true,maxMemoryUsageInMB:256,maxResolutionInMP:32});
    else if(payload[0]===137&&payload[1]===80&&payload[2]===78&&payload[3]===71){
      const buffer=Buffer.from(payload);if(buffer.length<24||buffer.readUInt32BE(16)*buffer.readUInt32BE(20)>32000000)fail('BACKEND_FRAME_LIMIT','时间轴图像超过云端处理上限',502);image=PNG.sync.read(buffer,{checkCRC:true});
    }else fail('BACKEND_FRAME_FORMAT','暂不支持此时间轴图像格式',502);
  }catch(e){if(e.code?.startsWith('BACKEND_FRAME_'))throw e;fail('BACKEND_FRAME_DECODE','时间轴图像解码失败或超过处理上限',502);}
  if(x+width>image.width||y+height>image.height)fail('BACKEND_FRAME_INPUT','裁剪区域超出时间轴图像',400);
  const pixels=new Uint8Array(width*height*4);for(let row=0;row<height;row++)pixels.set(image.data.subarray(((y+row)*image.width+x)*4,((y+row)*image.width+x+width)*4),row*width*4);
  return jpeg.encode({data:pixels,width,height},82).data;
}
