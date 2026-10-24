// Only fixed diagnostic fields leave the backend. Never retain response text,
// query strings, cookie values, verification tokens or account contents.
export const RISK_CODES=new Set([-412,-352,-799]);
export function responseSignals(status,contentType,payload){
  let code=null,verification=false;
  if(payload?.length<=2*1024*1024&&(String(contentType).includes('json')||payload?.[0]===123)){
    try{const value=JSON.parse(new TextDecoder().decode(payload));
      if(Number.isInteger(value?.code))code=value.code;
      verification=!!(value?.v_voucher||value?.data?.v_voucher||value?.data?.gaia_voucher);
    }catch{}
  }
  return {http_status:status,upstream_code:code,requires_verification:verification,risk:status===412||status===429||RISK_CODES.has(code)||verification,response_type:String(contentType||'').split(';')[0].replace(/[^a-z0-9/+.-]/gi,'').slice(0,60)};
}
export function cookiePresence(cookie=''){
  const names=new Set(String(cookie).split(';').map(x=>x.trim().split('=')[0]));
  return {session_present:names.has('SESSDATA'),buvid3_present:names.has('buvid3'),buvid4_present:names.has('buvid4')};
}
export function safeDetails(value={}){
  const out={};
  if(/^[a-f0-9-]{36}$/.test(value.request_id||''))out.request_id=value.request_id;
  if(Number.isInteger(value.http_status)&&value.http_status>=100&&value.http_status<=599)out.http_status=value.http_status;
  if(Number.isInteger(value.upstream_code))out.upstream_code=value.upstream_code;
  if(typeof value.requires_verification==='boolean')out.requires_verification=value.requires_verification;
  if(Number.isInteger(value.retry_after_seconds)&&value.retry_after_seconds>=0&&value.retry_after_seconds<=3600)out.retry_after_seconds=value.retry_after_seconds;
  return out;
}
