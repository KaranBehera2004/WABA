import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { Contact, Conversation, Message, MessageTemplate } from '../models/Domain.js';
import { BusinessTag, ConversationActivity, WhatsAppNumber } from '../models/Business.js';
import { activity, adminOnly, audit, conversationScope, isAdmin, isAgent, hasCapability, membershipCanClaim, notify, objectId, recordScope } from '../services/businessPolicy.js';
import { assignConversation } from '../services/assignment.js';
import { createWithCapacity } from '../services/capacity.js';
import { sendTemplate } from '../services/whatsapp.js';
import { SmartpingError, configuration } from '../services/smartping.js';
import { visibleWalletCharges } from '../services/walletReceipts.js';

const router = Router();
router.use(requireAuth, requireWorkspace);
const statusMap = { Open: 'open', Pending: 'awaiting_reply', Resolved: 'closed', Closed: 'closed', 'Awaiting reply': 'awaiting_reply', pending: 'awaiting_reply', resolved: 'closed' };
async function authorizedChat(req, write = false) {
  const item = await Conversation.findOne({ ...conversationScope(req, { write, unassigned: !write && req.query.queue === 'unassigned' }), _id: objectId(req.params.id) });
  if (!item) throw new SmartpingError('Conversation not found or access is not permitted.', 404);
  return item;
}
router.get('/', async (req, res, next) => {
  try {
    const scope = conversationScope(req, { unassigned: req.query.queue === 'unassigned' }); const conditions = [scope];
    if (req.query.queue === 'unassigned') conditions.push({ assignedTo: null });
    if (req.query.queue === 'mine') conditions.push({ assignedTo: req.user._id });
    if (req.query.queue === 'team') conditions.push(isAdmin(req) ? { team: { $ne: null } } : { team: { $in: req.membership.teams || [] } });
    if (req.query.status) conditions.push({ status: statusMap[req.query.status] || req.query.status });
    if (req.query.unread === 'true') conditions.push({ unreadCount: { $gt: 0 } });
    if (req.query.stage) conditions.push({stage:String(req.query.stage).slice(0,80)});
    for (const key of ['assignedTo','team','number']) if (req.query[key]) conditions.push({ [key]: objectId(req.query[key]) });
    if (req.query.tag) { const contacts = await Contact.find({ ...(await recordScope(req,'contacts')), tags: String(req.query.tag) }).select('_id').lean(); conditions.push({ $or: [{ tags: String(req.query.tag) }, { contact: { $in: contacts.map(item=>item._id) } }] }); }
    if (req.query.from || req.query.to) {
      const dates = {};
      for (const [key, op] of [['from','$gte'],['to','$lt']]) if (req.query[key]) { const value = new Date(req.query[key]); if (!Number.isFinite(+value)) throw new SmartpingError('Invalid date filter.'); dates[op] = value; }
      conditions.push({ lastMessageAt: dates });
    }
    if (req.query.q) {
      const query = String(req.query.q).slice(0,100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const contacts = await Contact.find({ ...(await recordScope(req,'contacts')), $or: ['name','phone','email'].map(field => ({ [field]: { $regex: query, $options: 'i' } })) }).select('_id').lean();
      conditions.push({ contact: { $in: contacts.map(item => item._id) } });
    }
    const filter = { $and: conditions }; const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 200)); const offset = Math.max(0, Number(req.query.offset) || 0);
    // Populate with a tenant match as defense against pre-existing invalid refs.
    const items = await Conversation.find(filter).populate({ path: 'contact', match: { workspace: req.workspace._id }, select: 'name phone email company tags customFields subscribed optInAt optOutAt' }).populate({path:'assignedTo',match:{_id:{$in:req.workspace.members.map(member=>member.user)}},select:'name email'}).sort({ lastMessageAt: -1 }).skip(offset).limit(limit).lean();
    res.json({ items, total: await Conversation.countDocuments(filter), canClaim: membershipCanClaim(req) });
  } catch (error) { next(error); }
});
router.post('/', adminOnly, async (req, res, next) => {
  try {
    const contact = await Contact.findOne({ ...(await recordScope(req,'contacts')), _id: objectId(req.body.contact), archivedAt: null });
    if (!contact) throw new SmartpingError('Contact not found.',404);
    const existing = await Conversation.findOne({ contact: contact._id, workspace: req.workspace._id, status: { $ne:'closed' } });
    if (existing) return res.json({ item: existing });
    const number=await WhatsAppNumber.findOne({workspace:req.workspace._id,disconnectedAt:null,...(req.body.number?{_id:objectId(req.body.number)}:{isDefault:true})});
    if(req.body.number&&!number)throw new SmartpingError('Choose a connected number from this business.');
    if (isAgent(req) && number && !req.membership.allowedNumbers?.some(id=>String(id)===String(number._id))) throw new SmartpingError('Choose a WhatsApp number allowed for your account.',403);
    const item = await createWithCapacity(req,'conversations',Conversation,{ workspace:req.workspace._id,contact:contact._id,number:number?._id,status:'open',...(isAgent(req)?{assignedTo:req.user._id}:{}) });
    await activity(req,item._id,'created');
    const routing=req.workspace.settings?.routing;
    const routed=routing&&routing.strategy!=='manual'&&!isAgent(req)?await assignConversation(req,String(item._id),{strategy:routing.strategy,team:routing.team||null}):item;
    res.status(201).json({ item:routed, walletCharges: visibleWalletCharges(req) });
  } catch (error) { next(error); }
});
router.patch('/:id', async (req,res,next) => {
  try {
    if (req.body.assignedTo !== undefined || req.body.team !== undefined) return res.json({ item: await assignConversation(req,req.params.id,{ assignedTo:req.body.assignedTo,team:req.body.team,expectedVersion:req.body.version }) });
    const chat = await authorizedChat(req,true); const updates = {};
    if (req.body.status !== undefined) {
      updates.status = statusMap[req.body.status] || req.body.status;
      if (!['open','awaiting_reply','closed'].includes(updates.status)) throw new SmartpingError('Choose Open, Pending or Resolved.');
      if (updates.status === 'closed') {
        if (!req.workspace.settings?.resolutionReasons?.includes(req.body.resolutionReason)) throw new SmartpingError('Choose a configured resolution reason.');
        updates.resolutionReason = req.body.resolutionReason; updates.resolvedAt = new Date();
      } else { updates.resolutionReason = null; updates.resolvedAt = null; }
    }
    if (req.body.stage !== undefined) { if (typeof req.body.stage !== 'string' || req.body.stage.length > 80) throw new SmartpingError('Invalid conversation stage.'); updates.stage = req.body.stage; }
    if (req.body.humanTakeover !== undefined) {
      if (typeof req.body.humanTakeover !== 'boolean') throw new SmartpingError('Invalid takeover status.');
      updates.humanTakeover = req.body.humanTakeover;
    }
    if (req.body.tags !== undefined) {
      if (!Array.isArray(req.body.tags) || req.body.tags.length > 30 || await BusinessTag.countDocuments({ workspace:req.workspace._id,name:{$in:req.body.tags},archivedAt:null }) !== new Set(req.body.tags).size) throw new SmartpingError('Choose existing active business tags.');
      updates.tags = [...new Set(req.body.tags)];
    }
    const item = await Conversation.findOneAndUpdate({ ...conversationScope(req,{write:true}),_id:chat._id,version:chat.version },{$set:updates,$inc:{version:1}},{new:true,runValidators:true});
    if (!item) throw new SmartpingError('The conversation changed. Refresh and try again.',409);
    await activity(req,item._id,updates.status ? 'status-'+updates.status : updates.humanTakeover !== undefined ? 'human-takeover-'+updates.humanTakeover : 'updated',undefined,updates);
    await audit(req,'conversation.update','Conversation',item._id); res.json({item});
  } catch(error){next(error);}
});
router.post('/:id/assign',adminOnly,async(req,res,next)=>{try{res.json({item:await assignConversation(req,req.params.id,req.body)});}catch(error){next(error);}});
router.post('/:id/claim',async(req,res,next)=>{try{res.json({item:await assignConversation(req,req.params.id,{claim:true})});}catch(error){next(error);}});
router.post('/:id/takeover',adminOnly,async(req,res,next)=>{try{res.json({item:await assignConversation(req,req.params.id,{takeover:true})});}catch(error){next(error);}});
router.post('/:id/transfer-request',async(req,res,next)=>{
  try{const chat=await authorizedChat(req,true);const text=String(req.body.reason||'').trim();if(!text||text.length>500)throw new SmartpingError('Enter a transfer reason.');await activity(req,chat._id,'transfer-request',text);for(const member of req.workspace.members.filter(member=>!member.disabled&&['owner','admin'].includes(member.role)))await notify(req.workspace._id,member.user,'transfer-request','An Agent requested a conversation transfer',chat._id);res.json({message:'Transfer request sent to your Business Admin.'});}catch(error){next(error);}
});
router.get('/:id/activity',async(req,res,next)=>{try{await authorizedChat(req);res.json({items:await ConversationActivity.find({workspace:req.workspace._id,conversation:req.params.id}).populate('actor','name').sort({createdAt:-1}).limit(100).lean()});}catch(error){next(error);}});
router.post('/:id/notes',async(req,res,next)=>{try{const chat=await authorizedChat(req,true);if(typeof req.body.text!=='string'||!req.body.text.trim()||req.body.text.length>5000)throw new SmartpingError('Enter a note of up to 5,000 characters.');const [item]=await activity(req,chat._id,'internal-note',req.body.text.trim());res.status(201).json({item});}catch(error){next(error);}});
router.post('/:id/read',async(req,res,next)=>{try{const chat=await authorizedChat(req,true);await Conversation.updateOne({...conversationScope(req,{write:true}),_id:chat._id},{$set:{unreadCount:0}});res.json({message:'Marked as read.'});}catch(error){next(error);}});
router.get('/:id/messages',async(req,res,next)=>{try{await authorizedChat(req);res.json({items:await Message.find({workspace:req.workspace._id,conversation:req.params.id}).sort({createdAt:1}).limit(500).lean()});}catch(error){next(error);}});
router.post('/:id/messages',async(req,res,next)=>{
  try{
    const chat=await authorizedChat(req,true);
    if(!req.permissions.includes('conversations.send')&&!isAdmin(req))throw new SmartpingError('Reply permission is unavailable.',403);
    if(!isAdmin(req)&&!chat.number){const number=await WhatsAppNumber.findOne({workspace:req.workspace._id,provider:'smartping',phone:configuration().from,disconnectedAt:null});if(!number||!req.membership.allowedNumbers?.some(id=>String(id)===String(number._id)))throw new SmartpingError('Ask a Business Admin to map an allowed sending number to this conversation.',403);chat.number=number._id;}
    if(req.body.type!=='template'){
      if(!chat.lastInboundAt||Date.now()-new Date(chat.lastInboundAt).getTime()>=86400000)throw new SmartpingError('The 24-hour customer service window is closed. Use an approved template.',409);
      throw new SmartpingError('Smartping free-text/media APIs and inbound webhook contract are not configured. Template messages with supported media remain available.',409);
    }
    const template=await MessageTemplate.findOne({workspace:req.workspace._id,status:'Approved',providerTemplateId:req.body.template?.templateId});
    if(!template)throw new SmartpingError('Select a provider-approved template in this business.',409);
    const result=await sendTemplate({workspace:req.workspace._id,conversation:chat,sender:req.user._id,template:req.body.template,idempotencyKey:req.body.idempotencyKey});
    await MessageTemplate.updateOne({_id:template._id,workspace:req.workspace._id},{$set:{lastUsedAt:new Date()}});
    res.status(result.duplicate?200:202).json({...result,walletCharges:visibleWalletCharges(req,result.walletCharges)});
  }catch(error){next(error);}
});
export default router;
