import { Router } from 'express';
import { randomUUID, createHmac } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { adminOnly, audit, notify, objectId } from '../services/businessPolicy.js';
import { BusinessIntegration, BusinessJob, BusinessTeam, WhatsAppNumber, AuthSession } from '../models/Business.js';
import { MessageTemplate } from '../models/Domain.js';
import User from '../models/User.js';
import { encryptSecret, decryptSecret } from '../services/businessSecrets.js';
import { managementAccount, metaRequest, metaCollection, webhookUrl } from '../services/businessIntegrations.js';
import { configuration, phoneNumber, SmartpingError } from '../services/smartping.js';
import { safeWebhookPost } from '../services/webhookTransport.js';
import { businessTransaction } from '../services/assignment.js';
import { assertActorPermission } from '../services/businessAccess.js';
const router=Router();router.use(requireAuth,requireWorkspace,adminOnly);
router.get('/settings', (req,res)=>res.json({name:req.workspace.name,settings:req.workspace.settings}));
router.patch('/settings',async(req,res,next)=>{
  try{
    const value=req.body.settings||{};const fields=['timezone','supportEmail','businessDescription','logo','businessHours','holidays','routing','contactFields','editableAgentFields','resolutionReasons','notificationPreferences','lowBalancePaise'];
    const settings=Object.fromEntries(Object.entries(value).filter(([key])=>fields.includes(key)));
    if(settings.routing&&(!['manual','round-robin','least-active','team'].includes(settings.routing.strategy)||typeof settings.routing.allowClaim!=='boolean'))throw new SmartpingError('Invalid routing defaults.');
    if(settings.businessHours&&(typeof settings.businessHours!=='object'||Array.isArray(settings.businessHours)||Object.entries(settings.businessHours).some(([day,hours])=>!['mon','tue','wed','thu','fri','sat','sun'].includes(day)||!hours||!/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.open)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.close))))throw new SmartpingError('Use valid 24-hour opening and closing times.');
    if(settings.timezone){try{Intl.DateTimeFormat('en',{timeZone:settings.timezone});}catch{throw new SmartpingError('Use a valid IANA timezone.');}}
    for(const key of ['contactFields','resolutionReasons','holidays','editableAgentFields'])if(settings[key]&&(!Array.isArray(settings[key])||settings[key].length>100||settings[key].some(entry=>typeof entry!=='string'||entry.length>120)))throw new SmartpingError('Invalid '+key+'.');
    if(settings.editableAgentFields?.some(field=>!['name','email','company','customFields'].includes(field)))throw new SmartpingError('Agent editable fields must be name, email, company or customFields.');
    if(settings.contactFields&&(new Set(settings.contactFields).size!==settings.contactFields.length||settings.contactFields.some(field=>! /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/.test(field))))throw new SmartpingError('Use unique custom field names with letters, numbers and underscores.');
    if(settings.holidays?.some(day=>!/^\d{4}-\d{2}-\d{2}$/.test(day)))throw new SmartpingError('Use YYYY-MM-DD holidays.');
    if(settings.logo&&!/^https:\/\//.test(settings.logo))throw new SmartpingError('Use an HTTPS logo URL.');
    if(settings.routing?.team&&!await BusinessTeam.exists({_id:objectId(settings.routing.team),workspace:req.workspace._id,archivedAt:null}))throw new SmartpingError('Choose a business team.');
    if(settings.lowBalancePaise!==undefined&&(!Number.isSafeInteger(settings.lowBalancePaise)||settings.lowBalancePaise<0))throw new SmartpingError('Alert threshold must be whole paise.');
    if(req.body.name!==undefined){if(typeof req.body.name!=='string'||!req.body.name.trim()||req.body.name.length>120)throw new SmartpingError('Business name is required, up to 120 characters.');req.workspace.name=req.body.name.trim();}
    req.workspace.settings={...req.workspace.settings.toObject(),...settings};await req.workspace.save();await audit(req,'business.settings-change','Workspace',req.workspace._id);res.json({workspace:req.workspace});
  }catch(error){next(error);}
});
router.get('/integrations',async(req,res,next)=>{try{const items=await BusinessIntegration.find({workspace:req.workspace._id}).select('+secret').lean();res.json({items:items.map(({secret,...item})=>({...item,credentialConfigured:Boolean(secret),credential:'••••••••'})),smartping:String(req.workspace._id)===process.env.SMARTPING_WORKSPACE_ID?configuration():{configured:false,missing:['Business-specific Smartping server configuration']}});}catch(error){next(error);}});
router.post('/integrations',async(req,res,next)=>{
  try{
    const {name,provider,secret,config={}}=req.body;if(!['meta','webhook'].includes(provider)||typeof name!=='string'||!name.trim()||name.length>100)throw new SmartpingError('Name and supported integration provider are required.');
    let clean;
    if(provider==='meta'){if(!/^\d+$/.test(config.businessAccountId||'')||!/^v\d+\.\d+$/.test(config.version||''))throw new SmartpingError('Business Account ID and Graph API version are required.');clean={businessAccountId:config.businessAccountId,version:config.version};}
    else clean={url:webhookUrl(config.url)};
    if(typeof req.body.enabled!=='boolean')throw new SmartpingError('Enabled must be a boolean.');
    const fieldMapping=req.body.fieldMapping||{};if(typeof fieldMapping!=='object'||Array.isArray(fieldMapping)||Object.entries(fieldMapping).some(([target,source])=>! /^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(target)||typeof source!=='string'||!['id','name','phone','email','company','tags','subscribed'].includes(source)&&!/^customFields\.[a-zA-Z0-9_]+$/.test(source)))throw new SmartpingError('Invalid field mapping.');
    const subscriptions=req.body.subscriptions||[];if(!Array.isArray(subscriptions)||subscriptions.some(value=>!['conversation.created','conversation.resolved','contact.updated','campaign.completed','automation.failed'].includes(value)))throw new SmartpingError('Select supported event subscriptions.');
    const encrypted=encryptSecret(secret,req.workspace._id);const item=await BusinessIntegration.findOneAndUpdate({workspace:req.workspace._id,name:name.trim()},{$set:{provider,config:clean,secret:encrypted,enabled:req.body.enabled,fieldMapping,subscriptions}},{new:true,upsert:true,runValidators:true});await audit(req,'integration.configure-or-rotate','BusinessIntegration',item._id);const safe = item.toObject(); delete safe.secret; res.json({item:safe});
  }catch(error){next(error);}
});
router.post('/integrations/:id/test',async(req,res,next)=>{
  try{const item=await BusinessIntegration.findOne({_id:objectId(req.params.id),workspace:req.workspace._id,enabled:true}).select('+secret');if(!item)throw new SmartpingError('Enabled integration not found.',404);if(item.provider==='meta'){await metaRequest(req.workspace._id,item.config.businessAccountId);}else{const url=webhookUrl(item.config.url);const body=JSON.stringify({event:'connection.test',workspace:String(req.workspace._id),id:randomUUID(),test:true});const status=await safeWebhookPost(url,body,{'Content-Type':'application/json','X-WABA-Signature':'sha256='+createHmac('sha256',decryptSecret(item.secret,req.workspace._id)).update(body).digest('hex')});if(status<200||status>=300)throw new SmartpingError('Webhook rejected the connection test (HTTP '+status+').',502);}item.testedAt=new Date();await item.save();await audit(req,'integration.test','BusinessIntegration',item._id);res.json({message:'Connection test succeeded. No customer message was sent.'});}catch(error){next(error);}
});
router.get('/integration-logs',async(req,res,next)=>{try{res.json({items:await BusinessJob.find({workspace:req.workspace._id,kind:'webhook'}).select('-payload').sort({createdAt:-1}).limit(100).lean()});}catch(error){next(error);}});
router.post('/integration-logs/:id/retry',async(req,res,next)=>{try{if(req.body.confirm!==true)throw new SmartpingError('Confirm retry.');const item=await BusinessJob.findOneAndUpdate({_id:objectId(req.params.id),workspace:req.workspace._id,kind:'webhook',status:'failed',attempts:{$lt:3}},{$set:{status:'pending',dueAt:new Date()}},{new:true});if(!item)throw new SmartpingError('Only failed webhook jobs with fewer than three attempts can be retried.',409);await audit(req,'integration.retry','BusinessJob',item._id);res.json({item});}catch(error){next(error);}});
router.get('/numbers',async(req,res,next)=>{try{res.json({items:await WhatsAppNumber.find({workspace:req.workspace._id}).lean(),onboarding:{smartping:'Use your Smartping account onboarding, then configure the assigned business ID, sender and credentials on this server.',meta:'Existing Meta WhatsApp Business Accounts can synchronize numbers with management credentials. Native embedded signup requires a configured Meta app.'}});}catch(error){next(error);}});
router.post('/numbers',async(req,res,next)=>{
  try{const phone=phoneNumber(req.body.phone);if(String(req.workspace._id)!==process.env.SMARTPING_WORKSPACE_ID||phone!==configuration().from)throw new SmartpingError('Add the sender verified in this business\'s server-side Smartping configuration. Other provider numbers must be synchronized.',409);const item=await WhatsAppNumber.findOneAndUpdate({workspace:req.workspace._id,phone},{$set:{provider:'smartping',displayName:req.body.displayName||'',providerState:{configuration:'Configured',registration:'Not exposed by Smartping',displayNameApproval:'Not exposed by Smartping'}}},{new:true,upsert:true,runValidators:true});await audit(req,'number.configure','WhatsAppNumber',item._id);res.json({item});}catch(error){next(error);}
});
router.post('/numbers/sync',async(req,res,next)=>{
  try{const account=await managementAccount(req.workspace._id);const data=await metaCollection(req.workspace._id,account+'/phone_numbers');let count=0;for(const number of data.data||[]){const item=await WhatsAppNumber.findOneAndUpdate({workspace:req.workspace._id,providerId:number.id},{$set:{phone:phoneNumber(number.display_phone_number),provider:'meta',businessAccountId:account,displayName:number.verified_name||'',providerState:number,syncedAt:new Date()}},{new:true,upsert:true,runValidators:true});count++;}await audit(req,'number.sync','WhatsAppNumber','sync');res.json({count,moreAvailable:Boolean(data.paging?.next),message:'Provider-returned states synchronized. Meta messaging transport is not configured by this management-only connection.'});}catch(error){next(error);}
});
router.post('/numbers/:id/profile/sync',async(req,res,next)=>{
  try{
    const number=await WhatsAppNumber.findOne({_id:objectId(req.params.id),workspace:req.workspace._id,provider:'meta'});
    if(!number)throw new SmartpingError('Profile synchronization requires a Meta number synchronized in this business.',409);
    const account=await managementAccount(req.workspace._id);if(number.businessAccountId!==account)throw new SmartpingError('The number does not match this business management account.',403);
    const result=await metaRequest(req.workspace._id,number.providerId+'/whatsapp_business_profile');
    if(!Array.isArray(result?.data)||!result.data[0])throw new SmartpingError('The provider did not return business-profile fields.',409);
    number.profile=result.data[0];number.syncedAt=new Date();await number.save();await audit(req,'number.profile-sync','WhatsAppNumber',number._id);res.json({item:number});
  }catch(error){next(error);}
});
router.patch('/numbers/:id',async(req,res,next)=>{
  try{
    const item=await businessTransaction(req,async(workspace,session,actor)=>{
    assertActorPermission(workspace, actor, req.user.role, 'integrations.manage');
    const item=await WhatsAppNumber.findOne({_id:objectId(req.params.id),workspace:workspace._id}).session(session);if(!item)throw new SmartpingError('Number not found.',404);
    if(req.body.teams){if(!Array.isArray(req.body.teams)||await BusinessTeam.countDocuments({workspace:req.workspace._id,_id:{$in:req.body.teams.map(objectId)},archivedAt:null})!==req.body.teams.length)throw new SmartpingError('Choose active business teams.');item.teams=req.body.teams;}
    if(req.body.isDefault===true){await WhatsAppNumber.updateMany({workspace:workspace._id},{$set:{isDefault:false}},{session});item.isDefault=true;}
    if(req.body.action){if(req.body.confirm!==true||!['disconnect','reconnect'].includes(req.body.action))throw new SmartpingError('Confirm disconnect/reconnect.');item.disconnectedAt=req.body.action==='disconnect'?new Date():undefined;}
    if(req.body.profile)throw new SmartpingError('Profile editing requires the provider business-profile endpoint contract. Provider states remain read-only.',409);
    await item.save({session});await audit(req,'number.mapping-or-local-connection-change','WhatsAppNumber',item._id,'success',session);return item;});res.json({item,message:'Business routing updated. Provider registration and verification were not changed.'});
  }catch(error){next(error);}
});
router.post('/templates/sync',async(req,res,next)=>{
  try{const account=await managementAccount(req.workspace._id);const data=await metaCollection(req.workspace._id,account+'/message_templates');let count=0;for(const value of data.data||[]){const status={APPROVED:'Approved',PENDING:'Pending',REJECTED:'Rejected'}[value.status]||'Rejected';const body=value.components?.find(component=>component.type==='BODY')?.text||'Provider template';const item=await MessageTemplate.findOneAndUpdate({workspace:req.workspace._id,name:value.name,language:value.language},{$set:{language:value.language,category:({MARKETING:'Marketing',UTILITY:'Utility',AUTHENTICATION:'Authentication'})[value.category]||'Utility',body,components:value.components||[],metaTemplateId:value.id,providerStatus:value.status,status,rejectionReason:value.rejected_reason||'',approvalSyncedAt:new Date()}},{new:true,upsert:true,runValidators:true});if(status==='Rejected')for(const member of req.workspace.members.filter(member=>!member.disabled&&['owner','admin'].includes(member.role)))await notify(req.workspace._id,member.user,'template-rejection','Template '+value.name+' is '+value.status,item._id);count++;}await audit(req,'template.provider-sync','MessageTemplate','sync');res.json({count,moreAvailable:Boolean(data.paging?.next)});}catch(error){next(error);}
});
router.post('/templates/:id/submit',async(req,res,next)=>{
  try{const item=await MessageTemplate.findOne({_id:objectId(req.params.id),workspace:req.workspace._id,status:{$in:['Draft','Rejected']}});if(!item)throw new SmartpingError('Only Draft or Rejected templates can be submitted.',409);if(!/^[a-z0-9_]{1,512}$/.test(item.name)||!/^\w{2,3}(?:_\w{2})?$/.test(item.language))throw new SmartpingError('Use a lowercase template name and provider language code, such as en_US.');const account=await managementAccount(req.workspace._id);const components=item.components?.length?item.components:[{type:'BODY',text:item.body}];const result=await metaRequest(req.workspace._id,account+'/message_templates',{method:'POST',body:{name:item.name,language:item.language,category:item.category.toUpperCase(),components}});if(!result?.id)throw new SmartpingError('Provider did not return a template ID. Review Meta records before retrying.',502,true);item.metaTemplateId=result.id;item.status='Pending';item.providerStatus=result.status||'PENDING';await item.save();await audit(req,'template.submit','MessageTemplate',item._id);res.json({item});}catch(error){next(error);}
});
router.get('/sessions',async(req,res,next)=>{try{res.json({items:await AuthSession.find({user:req.user._id,revokedAt:null,expiresAt:{$gt:new Date()}}).select('-key').sort({createdAt:-1}).lean(),legacySessions:'Revoke all sessions also invalidates older tokens without a session record.'});}catch(error){next(error);}});
router.post('/sessions/revoke-all',async(req,res,next)=>{try{if(req.body.confirm!==true)throw new SmartpingError('Confirm signing out all sessions, including this one.');await User.updateOne({_id:req.user._id},{$inc:{sessionVersion:1}});await AuthSession.updateMany({user:req.user._id,revokedAt:null},{$set:{revokedAt:new Date()}});await audit(req,'security.revoke-all-sessions','User',req.user._id);res.json({message:'All sessions revoked. Sign in again.'});}catch(error){next(error);}});
router.post('/sessions/:id/revoke',async(req,res,next)=>{try{const item=await AuthSession.findOneAndUpdate({_id:objectId(req.params.id),user:req.user._id,revokedAt:null},{$set:{revokedAt:new Date()}},{new:true});if(!item)throw new SmartpingError('Session not found.',404);await audit(req,'security.revoke-session','AuthSession',item._id);res.json({message:'Session revoked.'});}catch(error){next(error);}});
export default router;
