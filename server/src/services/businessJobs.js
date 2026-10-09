import {createHmac} from 'node:crypto';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import {Automation,Campaign,Contact,Conversation,MessageTemplate} from '../models/Domain.js';
import {BusinessIntegration,BusinessJob,ExecutionLog,WhatsAppNumber} from '../models/Business.js';
import {conversationForContact,sendTemplate} from './whatsapp.js';
import {campaignAudience} from './businessContacts.js';
import {activity,notify,conversationScope,isAgent} from './businessPolicy.js';
import {assignConversation} from './assignment.js';
import {businessOpen,conditionMatches} from './businessAutomations.js';
import {decryptSecret} from './businessSecrets.js';
import {webhookUrl} from './businessIntegrations.js';
import {SmartpingError} from './smartping.js';
import {permissionsFor} from './accessControl.js';
import {platformSettings,workspaceFeatures} from './platform.js';
import {safeWebhookPost} from './webhookTransport.js';
import {queueBusinessEvent} from '../middleware/businessAudit.js';
export const sendingWorkerEnabled=(env=process.env,args=process.argv)=>env.NODE_ENV==='production'&&env.ENABLE_OUTBOUND_JOBS==='true'&&args.includes('--allow-live-sends');
export async function jobActorContext(job, capability, feature){
  const workspace=await Workspace.findOne({_id:job.workspace,deletedAt:null,isActive:true});const user=await User.findOne({_id:job.payload.sender,isActive:true,deletedAt:null});
  const membership=user?.role==='superadmin'?{user:user._id,role:'owner'}:workspace?.members.find(member=>String(member.user)===String(user?._id)&&!member.disabled&&['owner','admin','agent','supervisor'].includes(member.role));
  if(!workspace||!user||!membership)throw new SmartpingError('Job actor no longer has active business access.',403);
  const settings=await platformSettings();const permissions=permissionsFor(workspace,membership,user.role),enabledFeatures=await workspaceFeatures(workspace,settings);
  if (workspace.subscriptionEndsAt && workspace.subscriptionEndsAt <= new Date()) throw new SmartpingError('Job business subscription has expired.',403);
  if (!permissions.includes(capability) || !enabledFeatures.includes(feature)) throw new SmartpingError('Job permission or business module was revoked.',403);
  return{workspace,user,membership,permissions,enabledFeatures,permissionDecision:true};
}
async function runCampaign(job){
  const req=await jobActorContext(job,'campaigns.send','campaigns');const campaign=await Campaign.findOne({_id:job.recordId,workspace:job.workspace});
  if(!campaign||campaign.cancelledAt)return{status:'cancelled',result:{reason:'Campaign cancelled'}};
  if(campaign.status==='Paused')return{status:'pending',dueAt:new Date(Date.now()+60000)};
  const template=await MessageTemplate.findOne({_id:campaign.template,workspace:job.workspace,status:'Approved'});if(!template)throw new SmartpingError('Template approval unavailable.',409);
  const contact=await Contact.findOne({_id:job.payload.contact,workspace:job.workspace});if(!contact||!campaignAudience([contact]).eligible.length)return{status:'cancelled',result:{reason:'Recipient no longer eligible or opted out'}};
  if (isAgent(req) && (!campaign.number || !req.membership.allowedNumbers?.some(id => String(id) === String(campaign.number)))) throw new SmartpingError('Campaign number is not allowed for the job actor.',403);
  const conversation=await conversationForContact(job.workspace,contact._id,req.user._id,req);
  if(campaign.number){const number=await WhatsAppNumber.findOne({_id:campaign.number,workspace:job.workspace,disconnectedAt:null});if(!number)throw new SmartpingError('Campaign sending number is disconnected.',409);conversation.number=number._id;}
  const result=await sendTemplate({workspace:job.workspace,conversation,sender:req.user._id,template:job.payload.template,campaign:campaign._id,idempotencyKey:job.key+':'+job.attempts});
  return{status:'complete',result:{contactId:String(contact._id),messageId:String(result.item._id),accepted:Boolean(result.item.providerMessageId),deliveryStatus:result.item.status}};
}
async function deliverWebhook(job){
  const integration=await BusinessIntegration.findOne({_id:job.payload.integration,workspace:job.workspace,provider:'webhook',enabled:true}).select('+secret');
  if(!integration)throw new SmartpingError('Webhook integration is disabled.',409);
  const fields={};
  if(job.payload.event==='contact.updated'&&Object.keys(integration.fieldMapping||{}).length){
    const contact=await Contact.findOne({_id:job.recordId,workspace:job.workspace}).select('name phone email company tags subscribed customFields').lean();
    for(const [target,source]of Object.entries(integration.fieldMapping))if(contact){const value=source==='id'?String(contact._id):source.startsWith('customFields.')?contact.customFields?.[source.slice(13)]:contact[source];if(value!==undefined)fields[target]=value;}
  }
  const url=webhookUrl(integration.config.url);const body=JSON.stringify({id:String(job._id),event:job.payload.event,workspace:String(job.workspace),record:job.recordId,test:false,fields});
  const status=await safeWebhookPost(url,body,{'Content-Type':'application/json','X-WABA-Signature':'sha256='+createHmac('sha256',decryptSecret(integration.secret,job.workspace)).update(body).digest('hex'),'Idempotency-Key':String(job._id)});
  if(status<200||status>=300)throw new SmartpingError('Webhook returned HTTP '+status+'.',502);
  return{status:'complete',result:{httpStatus:status}};
}
async function runAutomation(job){
  const req=await jobActorContext(job,'automations.update','automations');const automation=await Automation.findOne({_id:job.recordId,workspace:job.workspace,publication:'Published',enabled:true,version:job.payload.version});
  if(!automation)return{status:'cancelled',result:{reason:'Journey version is unpublished or disabled'}};
  const chat=await Conversation.findOne({...conversationScope(req,{write:true}),_id:job.payload.conversation});if(!chat)throw new SmartpingError('Conversation unavailable.',404);
  if(chat.humanTakeover)return{status:'pending',dueAt:new Date(Date.now()+60000),result:{reason:'Paused for human takeover'}};
  const contact=await Contact.findOne({_id:chat.contact,workspace:job.workspace});if(!contact)throw new SmartpingError('Contact unavailable.',404);
  for(let index=job.payload.index||0;index<job.payload.steps.length;index++){
    const lease=await BusinessJob.updateOne({_id:job._id,workspace:job.workspace,status:'running'},{$set:{leaseUntil:new Date(Date.now()+5*60000)}});
    if(!lease.matchedCount)throw new SmartpingError('Journey execution lease is unavailable. Review execution logs.',409);
    const latest=await Conversation.findOne({...conversationScope(req,{write:true}),_id:chat._id});if(!latest)throw new SmartpingError('Journey conversation access changed.',403);if(latest.humanTakeover){job.payload.index=index;return{status:'pending',payload:job.payload,dueAt:new Date(Date.now()+60000),result:{reason:'Paused for human takeover'}};}
    const step=job.payload.steps[index];
    if(step.type==='condition'&&!conditionMatches(step,contact)||step.type==='hours'&&businessOpen(req.workspace.settings)!==Boolean(step.open))return{status:'complete',result:{reason:'Condition not met'}};
    if(step.type==='delay'){job.payload.index=index+1;return{status:'pending',payload:job.payload,dueAt:new Date(Date.now()+step.seconds*1000)};}
    if(step.type==='message'){
      const template=await MessageTemplate.findOne({_id:step.template,workspace:job.workspace,status:'Approved'});if(!template?.providerPayload)throw new SmartpingError('Approved provider template unavailable.',409);
      if(!campaignAudience([contact]).eligible.length)throw new SmartpingError('Contact consent unavailable.',409);
      await sendTemplate({workspace:job.workspace,conversation:chat,sender:null,template:template.providerPayload,idempotencyKey:job.key+':step:'+index});
    }
    if(step.type==='assign')await assignConversation(req,String(chat._id),{strategy:step.strategy,team:step.team});
    if(step.type==='handoff'){await Conversation.updateOne({_id:chat._id,workspace:job.workspace},{$set:{humanTakeover:true}});await activity(req,chat._id,'bot-handoff');return{status:'complete',result:{reason:'Handed to human'}};}
    if(step.type==='collect'){await activity(req,chat._id,'field-collection-required',step.prompt,{field:step.field});return{status:'failed',result:{reason:'Native inbound field collection requires the Smartping inbound contract. Contact fields can be entered by the assigned Agent.',retryEligible:false}};}
    if(step.type==='webhook'){if(!req.permissions.includes('integrations.manage'))throw new SmartpingError('Webhook integration permission was revoked.',403);await deliverWebhook({...job.toObject(),payload:{integration:step.integration,event:'automation.action'},recordId:String(chat._id)});}
    await ExecutionLog.create({workspace:job.workspace,automation:automation._id,conversation:chat._id,version:job.payload.version,mode:'live',status:'step-complete',steps:[{index,type:step.type}]});
    job.payload.index=index+1;await BusinessJob.updateOne({_id:job._id,workspace:job.workspace,status:'running'},{$set:{'payload.index':index+1}});
  }
  await Automation.updateOne({_id:automation._id,workspace:job.workspace},{$inc:{runs:1}});return{status:'complete',result:{reason:'Journey completed'}};
}
export async function processNextJob(){
  // The API never imports or starts this worker. All three conditions must be
  // explicit even when this service is accidentally called by development code.
  if(!sendingWorkerEnabled())return false;
  await BusinessJob.updateMany({status:'running',leaseUntil:{$lt:new Date()}},{$set:{status:'uncertain',result:{uncertain:true,reason:'Worker stopped before confirming completion. Review provider records.'}}});
  const job=await BusinessJob.findOneAndUpdate({kind:{$in:['campaign','automation','webhook']},status:'pending',dueAt:{$lte:new Date()}},{$set:{status:'running',leaseUntil:new Date(Date.now()+5*60000)},$inc:{attempts:1}},{new:true,sort:{dueAt:1}}).select('+payload');
  if(!job)return false;
  let outcome;try{outcome=job.kind==='campaign'?await runCampaign(job):job.kind==='automation'?await runAutomation(job):await deliverWebhook(job);}catch(error){outcome={status:error.uncertain?'uncertain':'failed',result:{reason:error instanceof SmartpingError?error.message:'Job could not complete. Review its configuration.',uncertain:Boolean(error.uncertain),retryEligible:job.kind==='campaign'&&error instanceof SmartpingError&&error.status===502&&!error.uncertain}};}
  await BusinessJob.updateOne({_id:job._id,workspace:job.workspace,status:'running'},{$set:{...outcome,leaseUntil:null},...(outcome.status==='pending'?{$inc:{attempts:-1}}:{})});
  if(['failed','uncertain'].includes(outcome.status)){
    const workspace=await Workspace.findById(job.workspace);for(const member of workspace?.members.filter(member=>!member.disabled&&['owner','admin'].includes(member.role))||[])await notify(job.workspace,member.user,job.kind+'-failure',job.kind+' job needs review',job.recordId);
    if(job.kind==='automation')await ExecutionLog.create({workspace:job.workspace,automation:job.recordId,conversation:job.payload.conversation,version:job.payload.version,mode:'live',status:outcome.status,steps:[outcome.result]});
    if(job.kind==='automation')await queueBusinessEvent(job.workspace,'automation.failed',job.recordId);
  }
  if(job.kind==='campaign'){
    const remaining=await BusinessJob.countDocuments({workspace:job.workspace,kind:'campaign',recordId:job.recordId,status:{$in:['pending','running']}});
    if(!remaining){const failures=await BusinessJob.countDocuments({workspace:job.workspace,kind:'campaign',recordId:job.recordId,status:{$in:['failed','uncertain']}});await Campaign.updateOne({_id:job.recordId,workspace:job.workspace,cancelledAt:null},{$set:{status:failures?'Paused':'Completed'}});if(!failures)await queueBusinessEvent(job.workspace,'campaign.completed',job.recordId);}
  }
  return true;
}
