import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {SmartpingError} from './smartping.js';
export function publicAddress(address){
  if(address.includes(':'))return !/^(::|fc|fd|fe8|fe9|fea|feb|ff|2001:db8)/i.test(address)&&!address.includes('.');
  const p=address.split('.').map(Number);return p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&![0,10,127].includes(p[0])&&p[0]<224&&!(p[0]===169&&p[1]===254)&&!(p[0]===172&&p[1]>=16&&p[1]<=31)&&!(p[0]===192&&[168,0].includes(p[1]))&&!(p[0]===100&&p[1]>=64&&p[1]<=127)&&!(p[0]===198&&[18,19,51].includes(p[1]))&&!(p[0]===203&&p[1]===0&&p[2]===113);
}
export async function safeWebhookPost(value,body,headers){
  const url=new URL(value);const resolved=await lookup(url.hostname,{all:true});if(!resolved.length||resolved.some(item=>!publicAddress(item.address)))throw new SmartpingError('Webhook DNS resolved to a non-public address.',409);
  const destination=resolved[0];return new Promise((resolve,reject)=>{
    const req=https.request(url,{method:'POST',headers:{...headers,'Content-Length':Buffer.byteLength(body)},lookup:(_host,_options,callback)=>callback(null,destination.address,destination.family),timeout:10000},res=>{res.resume();resolve(res.statusCode);});req.on('timeout',()=>req.destroy());req.on('error',()=>reject(new SmartpingError('Webhook delivery could not be confirmed.',502,true)));req.end(body);
  });
}
