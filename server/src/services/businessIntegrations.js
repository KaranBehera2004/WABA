import { BusinessIntegration } from '../models/Business.js';
import { decryptSecret } from './businessSecrets.js';
import { SmartpingError } from './smartping.js';
export async function metaRequest(workspace,endpoint,{method='GET',body,query={}}={}){
  const integration=await BusinessIntegration.findOne({workspace,provider:'meta',enabled:true}).select('+secret');
  if(!integration?.secret)throw new SmartpingError('Configure Meta management credentials for this business. Smartping has no documented template-approval or number-profile API.',409);
  if(!/^v\d+\.\d+$/.test(integration.config?.version||'')||!/^\d+$/.test(integration.config?.businessAccountId||''))throw new SmartpingError('Configure a valid Graph API version and WhatsApp Business Account ID.',409);
  if(!/^\d+(?:\/[a-z_]+)?$/.test(endpoint))throw new SmartpingError('Invalid provider operation.');
  if(Object.keys(query).some(key=>!['after','limit','fields'].includes(key))||Object.values(query).some(value=>typeof value!=='string'||value.length>4000))throw new SmartpingError('Invalid provider query.');
  const url=new URL('https://graph.facebook.com/'+integration.config.version+'/'+endpoint);for(const[key,value]of Object.entries(query))url.searchParams.set(key,value);
  let response;try{response=await fetch(url,{method,redirect:'error',headers:{Authorization:'Bearer '+decryptSecret(integration.secret,workspace),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});}catch{throw new SmartpingError('Meta did not confirm the operation. Check provider records before retrying.',502,true);}
  const data=await response.json().catch(()=>null);if(!response.ok||data?.error)throw new SmartpingError('Meta rejected the operation'+(data?.error?.code?' (code '+data.error.code+')':'')+'. Check account permissions and provider records.',502);
  return data;
}
export async function metaCollection(workspace,endpoint){
  const items=[];let cursor;const seen=new Set();
  for(let page=0;page<100;page++){
    const data=await metaRequest(workspace,endpoint,{query:{limit:'100',...(cursor?{after:cursor}:{})}});items.push(...(data.data||[]));
    if(!data.paging?.next)return{data:items,paging:{}};
    cursor=data.paging?.cursors?.after;
    if(!cursor||seen.has(cursor))throw new SmartpingError('Provider pagination could not complete. Retry synchronization.',502);
    seen.add(cursor);
  }
  throw new SmartpingError('Provider returned too many records for one synchronization.',409);
}
export async function managementAccount(workspace){const integration=await BusinessIntegration.findOne({workspace,provider:'meta',enabled:true});if(!integration)throw new SmartpingError('Meta management integration is not configured.',409);return integration.config.businessAccountId;}
export function webhookUrl(value,env=process.env){
  let url;try{url=new URL(value);}catch{throw new SmartpingError('Use a valid HTTPS webhook URL.');}
  const allowed=(env.BUSINESS_WEBHOOK_ALLOWED_HOSTS||'').split(',').map(value=>value.trim()).filter(Boolean);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||url.port&&url.port!=='443'||!allowed.includes(url.hostname)||/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(url.hostname))throw new SmartpingError('Webhook host must be explicitly allowed by BUSINESS_WEBHOOK_ALLOWED_HOSTS; use public HTTPS without credentials or query strings.',409);
  return url.toString();
}
