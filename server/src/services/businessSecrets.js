import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SmartpingError } from './smartping.js';
function key(env=process.env){const value=Buffer.from(env.BUSINESS_ENCRYPTION_KEY||'','base64');if(value.length!==32)throw new SmartpingError('Configure a 32-byte base64 BUSINESS_ENCRYPTION_KEY on the server before saving credentials.',409);return value;}
export function encryptSecret(value,workspace,env=process.env){
  if(typeof value!=='string'||value.length<16||value.length>10000)throw new SmartpingError('Credential must contain 16 to 10,000 characters.');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(env),iv);cipher.setAAD(Buffer.from(String(workspace)));const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.');
}
export function decryptSecret(value,workspace,env=process.env){try{const [version,iv,tag,data]=value.split('.');if(version!=='v1')throw new Error();const cipher=createDecipheriv('aes-256-gcm',key(env),Buffer.from(iv,'base64'));cipher.setAAD(Buffer.from(String(workspace)));cipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');}catch{throw new SmartpingError('Stored credential could not be opened. Check the encryption key or rotate this credential.',409);}}
