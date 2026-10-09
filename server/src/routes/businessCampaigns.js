import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { adminOnly, audit, objectId, isAgent } from '../services/businessPolicy.js';
import { businessTransaction } from '../services/assignment.js';
import { Campaign, Contact, Message, MessageTemplate, Segment } from '../models/Domain.js';
import { BusinessJob, WhatsAppNumber } from '../models/Business.js';
import { campaignAudience } from '../services/businessContacts.js';
import { assertConfigured, configuration, SmartpingError, validateTemplate } from '../services/smartping.js';
import { checkSendingPolicy, platformSettings } from '../services/platform.js';
import { conversationForContact, sendTemplate } from '../services/whatsapp.js';
import { createWithCapacity } from '../services/capacity.js';
import { assertActorPermission } from '../services/businessAccess.js';
const router=Router();router.use(requireAuth,requireWorkspace,adminOnly);
async function draftFields(req){
  const fields=['name','category','number','template','language','segment','contactIds','variableMapping'];const payload=Object.fromEntries(Object.entries(req.body).filter(([key])=>fields.includes(key)));
  for(const [field,Model]of[['number',WhatsAppNumber],['template',MessageTemplate],['segment',Segment]])if(payload[field]){if(!await Model.exists({_id:objectId(payload[field]),workspace:req.workspace._id}))throw new SmartpingError('Select '+field+' from this business.');}else if(payload[field]==='')payload[field]=null;
  if(payload.contactIds){if(!Array.isArray(payload.contactIds)||payload.contactIds.length>5000)throw new SmartpingError('Select up to 5,000 contacts.');payload.contactIds=[...new Set(payload.contactIds)];if(await Contact.countDocuments({workspace:req.workspace._id,_id:{$in:payload.contactIds.map(objectId)}})!==payload.contactIds.length)throw new SmartpingError('Select contacts from this business.');}
  if (payload.number && isAgent(req) && !req.membership.allowedNumbers?.some(id => String(id) === String(payload.number))) throw new SmartpingError('Select a sending number allowed for your business membership.',403);
  if(payload.segment&&payload.contactIds?.length)throw new SmartpingError('Choose a segment or individual contacts.');
  return payload;
}
async function audience(req,campaign){
  let filter={workspace:req.workspace._id,archivedAt:null};
  if(campaign.contactIds?.length)filter._id={$in:campaign.contactIds};
  else if(campaign.segment){const segment=await Segment.findOne({_id:campaign.segment,workspace:req.workspace._id});if(!segment)throw new SmartpingError('Segment not found.',404);if(segment.criteria?.tags?.length)filter.tags={$in:segment.criteria.tags};if(segment.criteria?.contactIds?.length)filter._id={$in:segment.criteria.contactIds};if(!segment.criteria?.tags?.length&&!segment.criteria?.contactIds?.length)throw new SmartpingError('Segment requires contacts or tag criteria.');}
  else throw new SmartpingError('Select contacts or a segment.');
  const selected=await Contact.find(filter).limit(5000).lean();
  const optOuts=await Contact.find({workspace:req.workspace._id,$or:[{subscribed:false},{optOutAt:{$ne:null}}]}).select('phone subscribed optOutAt').lean();
  const result=campaignAudience([...selected,...optOuts]);const selectedIds=new Set(selected.map(contact=>String(contact._id)));
  return{eligible:result.eligible.filter(contact=>selectedIds.has(String(contact._id))),excluded:[...new Map(result.excluded.filter(contact=>selectedIds.has(String(contact.contact))).map(item=>[String(item.contact),item])).values()]};
}
async function configuredTemplate(req,campaign,membership=req.membership){
  if (req.user.role !== 'superadmin' && ['agent','supervisor'].includes(membership.role) && (!campaign.number || !membership.allowedNumbers?.some(id => String(id) === String(campaign.number)))) throw new SmartpingError('Select a sending number allowed for your business membership.',403);
  const template=await MessageTemplate.findOne({_id:campaign.template,workspace:req.workspace._id,status:'Approved'});
  if(!template?.providerPayload)throw new SmartpingError('Select a provider-approved, configured Smartping template.',409);
  if(campaign.number){const number=await WhatsAppNumber.findOne({_id:campaign.number,workspace:req.workspace._id,disconnectedAt:null});if(!number||number.provider!=='smartping'||number.phone!==configuration().from)throw new SmartpingError('Select the configured Smartping sending number.',409);}
  const payload=validateTemplate(template.providerPayload);
  return{template,payload};
}
router.get('/',async(req,res,next)=>{try{res.json({items:await Campaign.find({workspace:req.workspace._id}).sort({createdAt:-1}).limit(100).lean(),workerEnabled:process.env.ENABLE_OUTBOUND_JOBS==='true'});}catch(error){next(error);}});
router.post('/',async(req,res,next)=>{
  try{
    const payload=await draftFields(req);
    const item=await createWithCapacity(req,'campaigns',Campaign,{...payload,status:'Draft',workspace:req.workspace._id,createdBy:req.user._id});await audit(req,'campaign.draft','Campaign',item._id);res.status(201).json({item});
  }catch(error){next(error);}
});
router.patch('/:id',async(req,res,next)=>{
  try{const payload=await draftFields(req);const item=await Campaign.findOneAndUpdate({_id:objectId(req.params.id),workspace:req.workspace._id,status:'Draft',dispatchKey:{$exists:false}},{$set:payload},{new:true,runValidators:true});if(!item)throw new SmartpingError('Only an unlaunched draft can be edited.',409);await audit(req,'campaign.edit','Campaign',item._id);res.json({item});}catch(error){next(error);}
});
router.post('/:id/preview',async(req,res,next)=>{
  try{const campaign=await Campaign.findOne({_id:objectId(req.params.id),workspace:req.workspace._id});if(!campaign)throw new SmartpingError('Campaign not found.',404);const recipients=await audience(req,campaign);const template=await MessageTemplate.findOne({_id:campaign.template,workspace:req.workspace._id});res.json({count:recipients.eligible.length,excluded:recipients.excluded,preview:template?.body||'',templateStatus:template?.status||'Unavailable',estimatedProviderCost:null,costMessage:'Provider pricing unavailable; no confirmed billed amount is calculated.',workerEnabled:process.env.ENABLE_OUTBOUND_JOBS==='true'});}catch(error){next(error);}
});
router.post('/:id/test',async(req,res,next)=>{
  try{
    if(req.body.confirm!==true)throw new SmartpingError('Confirm sending one real test message.');
    const campaign=await Campaign.findOne({_id:objectId(req.params.id),workspace:req.workspace._id});if(!campaign)throw new SmartpingError('Campaign not found.',404);
    const contact=await Contact.findOne({_id:objectId(req.body.contact),workspace:req.workspace._id});if(!contact||!campaignAudience([contact]).eligible.length)throw new SmartpingError('Select an opted-in test contact.');
    const {payload}=await configuredTemplate(req,campaign);const conversation=await conversationForContact(req.workspace._id,contact._id,req.user._id,req);const result=await sendTemplate({workspace:req.workspace._id,conversation,sender:req.user._id,template:mapVariables(payload,campaign.variableMapping,contact),idempotencyKey:req.body.idempotencyKey});await audit(req,'campaign.test-send','Campaign',campaign._id);res.status(202).json({item:result.item});
  }catch(error){next(error);}
});
router.post('/:id/launch',async(req,res,next)=>{
  try{
    if(req.body.confirm!==true)throw new SmartpingError('Final launch confirmation is required.');
    if(!/^[a-zA-Z0-9._-]{8,100}$/.test(req.body.idempotencyKey||''))throw new SmartpingError('A unique launch key is required.');
    assertConfigured(req.workspace._id);await checkSendingPolicy(req.workspace._id,{broadcast:true});const settings=await platformSettings();if(!settings.broadcastsEnabled)throw new SmartpingError('Campaign sending is paused.',403);
    const date=req.body.scheduledAt?new Date(req.body.scheduledAt):new Date();if(!Number.isFinite(+date)||req.body.scheduledAt&&date<=new Date())throw new SmartpingError('Choose a future schedule time.');
    const item=await businessTransaction(req,async(workspace,session,actor)=>{
      assertActorPermission(workspace, actor, req.user.role, 'campaigns.send');
      const campaign=await Campaign.findOne({_id:objectId(req.params.id),workspace:workspace._id}).session(session);if(!campaign)throw new SmartpingError('Campaign not found.',404);
      if(campaign.dispatchKey){if(campaign.dispatchKey===req.body.idempotencyKey)return campaign;throw new SmartpingError('Campaign already launched.',409);}
      const {payload}=await configuredTemplate(req,campaign,actor);const recipients=await audience(req,campaign);if(!recipients.eligible.length||recipients.eligible.length>settings.maxBroadcastRecipients)throw new SmartpingError('Select 1 to '+settings.maxBroadcastRecipients+' eligible recipients.');
      for(const contact of recipients.eligible)mapVariables(payload,campaign.variableMapping,contact);
      await BusinessJob.init();await BusinessJob.insertMany(recipients.eligible.map(contact=>({workspace:workspace._id,kind:'campaign',key:'campaign:'+campaign._id+':'+contact._id,recordId:String(campaign._id),dueAt:date,payload:{contact:String(contact._id),sender:String(req.user._id),template:mapVariables(payload,campaign.variableMapping,contact)},status:'pending'})),{session});
      campaign.dispatchKey=req.body.idempotencyKey;campaign.status=req.body.scheduledAt?'Scheduled':'Running';campaign.scheduledAt=date;campaign.confirmedAt=new Date();campaign.audienceSize=recipients.eligible.length;await campaign.save({session});await audit(req,'campaign.launch','Campaign',campaign._id,'success',session);return campaign;
    });res.status(202).json({item,workerEnabled:process.env.ENABLE_OUTBOUND_JOBS==='true',message:process.env.ENABLE_OUTBOUND_JOBS==='true'?'Campaign queued.':'Campaign queued; outbound worker is disabled. No messages will be sent until the server operator explicitly enables it.'});
  }catch(error){next(error);}
});
export function mapVariables(payload,mapping,contact){
  const result=structuredClone(payload);const entries=mapping instanceof Map?[...mapping]:Object.entries(mapping||{});
  for(const[key,field]of entries){if(!/^\d+$/.test(key)||!['name','phone','email','company'].includes(field)&&!field.startsWith('customFields.'))throw new SmartpingError('Invalid template variable mapping.');const value=field.startsWith('customFields.')?contact.customFields?.[field.slice(13)]:contact[field];if(value===undefined||value===null||value==='')throw new SmartpingError('Missing required template value for '+field+'.');(result.parameterValues||={})[key]=String(value);}
  return validateTemplate(result);
}
router.post('/:id/control',async(req,res,next)=>{
  try{if(req.body.confirm!==true||!['pause','resume','cancel'].includes(req.body.action))throw new SmartpingError('Confirm pause, resume or cancel.');const item=await Campaign.findOneAndUpdate({_id:objectId(req.params.id),workspace:req.workspace._id,cancelledAt:null,dispatchKey:{$exists:true},status:{$in:['Scheduled','Running','Paused']}},{$set:{status:req.body.action==='resume'?'Running':'Paused',...(req.body.action==='cancel'?{cancelledAt:new Date()}: {})}},{new:true});if(!item)throw new SmartpingError('Campaign is unavailable or cancelled.',409);if(req.body.action==='cancel')await BusinessJob.updateMany({workspace:req.workspace._id,kind:'campaign',recordId:String(item._id),status:'pending'},{$set:{status:'cancelled'}});await audit(req,'campaign.'+req.body.action,'Campaign',item._id);res.json({item,message:'Pending sends updated. Already accepted messages cannot be recalled.'});}catch(error){next(error);}
});
router.get('/:id/recipients',async(req,res,next)=>{try{if(!await Campaign.exists({_id:objectId(req.params.id),workspace:req.workspace._id}))throw new SmartpingError('Campaign not found.',404);res.json({items:await BusinessJob.find({workspace:req.workspace._id,kind:'campaign',recordId:req.params.id}).select('-payload').sort({createdAt:1}).limit(5000).lean(),messages:await Message.find({workspace:req.workspace._id,campaign:req.params.id}).select('conversation status error providerMessageId createdAt').lean()});}catch(error){next(error);}});
router.post('/:id/retry',async(req,res,next)=>{
  try{if(req.body.confirm!==true)throw new SmartpingError('Confirm retry of definitively rejected messages.');const job=await BusinessJob.findOne({_id:objectId(req.body.job),workspace:req.workspace._id,recordId:req.params.id,status:'failed',attempts:{$lt:3}}).select('+payload');if(!job||job.result?.uncertain||!job.result?.retryEligible)throw new SmartpingError('Only confirmed, retryable provider rejections can be retried. Uncertain sends must be reviewed at the provider.',409);const campaign=await Campaign.findOne({_id:objectId(req.params.id),workspace:req.workspace._id,cancelledAt:null});if(!campaign)throw new SmartpingError('Campaign unavailable.',404);const item=await BusinessJob.findOneAndUpdate({_id:job._id,workspace:req.workspace._id,status:'failed',attempts:job.attempts},{$set:{status:'pending',dueAt:new Date(),result:null}},{new:true});if(!item)throw new SmartpingError('Retry changed. Refresh.',409);await Campaign.updateOne({_id:campaign._id,workspace:req.workspace._id,cancelledAt:null},{$set:{status:'Running'}});await audit(req,'campaign.retry','BusinessJob',item._id);res.json({item});}catch(error){next(error);}
});
export default router;
