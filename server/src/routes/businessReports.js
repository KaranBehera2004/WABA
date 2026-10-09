import { Router } from 'express';
import { effectiveWorkspacePlan } from '../services/workspacePlan.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { adminOnly, audit, objectId, conversationScope, isAgent } from '../services/businessPolicy.js';
import { Conversation, Contact, Message, Campaign, MessageTemplate, ReportRequest } from '../models/Domain.js';
import { ExecutionLog, WhatsAppNumber, BusinessTeam } from '../models/Business.js';
import User from '../models/User.js';
import { TestWallet, WalletEntry } from '../models/Wallet.js';
import { PlatformInvoice } from '../models/Platform.js';
import { periodFilter, responseTimes, metricDefinitions } from '../services/businessMetrics.js';
import { csv, messageMetrics } from '../services/metrics.js';
import { createWithCapacity } from '../services/capacity.js';
import { configuration, SmartpingError } from '../services/smartping.js';

const router=Router();router.use(requireAuth,requireWorkspace,adminOnly);
async function data(req, query = req.query){
  const range=periodFilter(query);const scope=conversationScope(req);
  for(const key of ['assignedTo','team','number'])if(query[key])scope[key]=objectId(query[key]);
  const permitted = req.user.role === 'superadmin' || req.enabledFeatures.includes('conversations') && req.permissions.includes('conversations.read');
  if (!permitted) scope._id = { $in: [] };
  const all=await Conversation.find(scope).populate({path:'contact',match:{workspace:req.workspace._id},select:'name phone'}).lean();
  const selected=all.filter(chat=>{const time=+new Date(chat.lastMessageAt||chat.createdAt);return time>=+range.$gte&&time<+range.$lt;});
  const messages=await Message.find({workspace:req.workspace._id,conversation:{$in:all.map(chat=>chat._id)}}).select('conversation sender direction status type createdAt campaign templatePayload error').lean();
  return{range,all,selected,messages,periodMessages:messages.filter(item=>item.createdAt>=range.$gte&&item.createdAt<range.$lt)};
}
router.get('/dashboard',async(req,res,next)=>{
  try{
    const {range,all,selected,messages,periodMessages}=await data(req);
    if (isAgent(req)) {
      const visible = !req.permissions.includes('team.read') || !req.enabledFeatures.includes('team') ? [] : req.membership.role === 'supervisor' ? req.workspace.members.filter(member => !member.disabled && member.role === 'agent' && member.teams?.some(team => req.membership.teams?.some(id => String(id) === String(team)))) : req.workspace.members.filter(member => String(member.user) === String(req.user._id));
      const users = await User.find({ _id: { $in: visible.map(member => member.user) }, isActive: true, deletedAt: null }).select('name').lean();
      const metrics = { total:selected.length, unassigned:selected.filter(chat=>!chat.assignedTo&&chat.status!=='closed').length, open:selected.filter(chat=>chat.status==='open').length, pending:selected.filter(chat=>chat.status==='awaiting_reply').length, resolved:selected.filter(chat=>chat.status==='closed').length, unread:selected.reduce((sum,chat)=>sum+(chat.unreadCount||0),0), ...responseTimes(messages.filter(message=>message.direction==='inbound'||message.sender),range) };
      const agents = visible.filter(member=>users.some(user=>String(user._id)===String(member.user))).map(member=>({id:member.user,name:users.find(user=>String(user._id)===String(member.user))?.name,availability:member.availability||'offline',capacity:member.capacity||10,workload:all.filter(chat=>String(chat.assignedTo)===String(member.user)&&chat.status!=='closed').length}));
      const numbers = await WhatsAppNumber.find({workspace:req.workspace._id,_id:{$in:req.membership.allowedNumbers||[]}}).select('phone displayName').lean();
      return res.json({ metrics, agents, numbers, definitions:metricDefinitions, range, scope:req.membership.role === 'supervisor' ? 'Assigned teams and allowed numbers' : 'Assigned conversations' });
    }
    const allowed = (capability, feature) => req.user.role === 'superadmin' || req.permissions.includes(capability) && (!feature || req.enabledFeatures.includes(feature));
    const [users,numbers,wallet,entries]=await Promise.all([
      allowed('team.read','team') ? User.find({_id:{$in:req.workspace.members.map(member=>member.user)},isActive:true,deletedAt:null}).select('name email').lean() : [],
      allowed('integrations.manage') ? WhatsAppNumber.find({workspace:req.workspace._id}).select('phone displayName').lean() : [],
      allowed('wallet.read') ? TestWallet.findOne({workspace:req.workspace._id}).lean() : null,
      allowed('wallet.read') ? WalletEntry.find({workspace:req.workspace._id,createdAt:range}).select('deltaPaise kind status').lean() : []
    ]);
    const metrics={total:selected.length,unassigned:selected.filter(chat=>!chat.assignedTo&&chat.status!=='closed').length,open:selected.filter(chat=>chat.status==='open').length,pending:selected.filter(chat=>chat.status==='awaiting_reply').length,resolved:selected.filter(chat=>chat.status==='closed').length,unread:selected.reduce((sum,chat)=>sum+(chat.unreadCount||0),0),...responseTimes(messages.filter(message=>message.direction==='inbound'||message.sender),range)};
    const agents=req.workspace.members.filter(member=>member.role==='agent'&&!member.disabled).map(member=>({id:member.user,name:users.find(user=>String(user._id)===String(member.user))?.name||'Unavailable account',available:users.some(user=>String(user._id)===String(member.user))&&member.availability==='available',availability:member.availability||'offline',capacity:member.capacity||10,workload:all.filter(chat=>String(chat.assignedTo)===String(member.user)&&chat.status!=='closed').length}));
    const campaigns=periodMessages.filter(message=>message.campaign);const smartping=String(req.workspace._id)===process.env.SMARTPING_WORKSPACE_ID?configuration():{configured:false};
    res.json({metrics,campaigns:allowed('campaigns.read','campaigns')?{...messageMetrics(campaigns),failed:campaigns.filter(message=>message.status==='failed').length}:null,agents:allowed('team.read','team')?agents:[],numbers,connection:allowed('integrations.manage')?{configured:smartping.configured,deliveryTracking:Boolean(smartping.deliveryTracking),state:smartping.configured?'Configured; provider connection not continuously verified':'Configuration required'}:null,usage:allowed('wallet.read')?{balancePaise:wallet?.balancePaise??null,mode:wallet?.mode||'unavailable',testChargesPaise:entries.filter(entry=>entry.kind==='activity'&&entry.status==='complete').reduce((sum,entry)=>sum-entry.deltaPaise,0),confirmedProviderCost:null}:null,definitions:metricDefinitions,range});
  }catch(error){next(error);}
});
router.get('/reports',async(req,res,next)=>{try{res.json({items:await ReportRequest.find({workspace:req.workspace._id,...(isAgent(req)?{requestedBy:req.user._id}:{})}).populate('requestedBy','name').sort({createdAt:-1}).limit(100).lean()});}catch(error){next(error);}});
router.post('/reports',async(req,res,next)=>{
  try{
    if (req.body.type === 'Usage' && req.user.role !== 'superadmin' && !req.permissions.includes('wallet.read')) throw new SmartpingError('Billing permission is required for usage exports.',403);
    const filters=Object.fromEntries(Object.entries(req.body.filters||{}).filter(([key])=>['days','from','to','assignedTo','team','number'].includes(key)));
    const {range,all,selected,periodMessages}=await data(req,filters);let rows;
    const type=req.body.type;
    const reportMembers = isAgent(req) ? req.workspace.members.filter(member => String(member.user) === String(req.user._id) || req.membership.role === 'supervisor' && member.teams?.some(team => req.membership.teams?.some(id => String(id) === String(team)))) : req.workspace.members;
    if(type==='Conversations')rows=[['Conversation','Customer','Phone','Agent','Team','Number','Status','Unread','Resolution reason'],...selected.map(chat=>[chat._id,chat.contact?.name,chat.contact?.phone,chat.assignedTo,chat.team,chat.number,chat.status,chat.unreadCount,chat.resolutionReason])];
    else if(type==='Agent activity'){const users=await User.find({_id:{$in:reportMembers.map(member=>member.user)}}).select('name').lean();rows=[['Agent','Role','Availability','Active chats','Resolved chats','Confirmed replies','First response ms','Average response ms'],...reportMembers.filter(member=>member.role==='agent').map(member=>{const chats=all.filter(chat=>String(chat.assignedTo)===String(member.user));const ids=new Set(chats.map(chat=>String(chat._id)));const replies=periodMessages.filter(message=>String(message.sender)===String(member.user)&&['sent','delivered','read'].includes(message.status));const response=responseTimes(periodMessages.filter(message=>ids.has(String(message.conversation))&&(message.direction==='inbound'||String(message.sender)===String(member.user))));return[users.find(user=>String(user._id)===String(member.user))?.name||member.user,member.role,member.availability,chats.filter(chat=>chat.status!=='closed').length,selected.filter(chat=>String(chat.assignedTo)===String(member.user)&&chat.status==='closed').length,replies.length,response.firstResponseMs,response.averageResponseMs];})];}
    else if(type==='Team performance'){const teams=await BusinessTeam.find({workspace:req.workspace._id,archivedAt:null,...(isAgent(req)?{_id:{$in:req.membership.teams||[]}}:{}),...(filters.team?{_id:filters.team}:{}),...(isAgent(req)&&filters.team?{$and:[{_id:{$in:req.membership.teams||[]}}]}:{})}).lean();rows=[['Team','Agents','Active chats','Resolved chats','Confirmed replies','First response ms','Average response ms'],...teams.map(team=>{const chats=all.filter(chat=>String(chat.team)===String(team._id));const ids=new Set(chats.map(chat=>String(chat._id)));const messages=periodMessages.filter(message=>ids.has(String(message.conversation)));const response=responseTimes(messages.filter(message=>message.direction==='inbound'||message.sender));return[team.name,reportMembers.filter(member=>!member.disabled&&member.role==='agent'&&member.teams?.some(id=>String(id)===String(team._id))).length,chats.filter(chat=>chat.status!=='closed').length,selected.filter(chat=>String(chat.team)===String(team._id)&&chat.status==='closed').length,messages.filter(message=>message.sender&&message.direction==='outbound'&&['sent','delivered','read'].includes(message.status)).length,response.firstResponseMs,response.averageResponseMs];})];}
    else if(type==='Campaign delivery')rows=[['Campaign','Conversation','Status','Failure reason','Date','Inbound replies in period'],...periodMessages.filter(message=>message.campaign).map(message=>[message.campaign,message.conversation,message.status,message.error?.message,message.createdAt.toISOString(),periodMessages.filter(reply=>reply.direction==='inbound'&&String(reply.conversation)===String(message.conversation)&&reply.createdAt>=message.createdAt).length])];
    else if(type==='Template usage')rows=[['Template','Status','Conversation','Date'],...periodMessages.filter(message=>message.type==='template').map(message=>[message.templatePayload?.templateId,message.status,message.conversation,message.createdAt.toISOString()])];
    else if(type==='Automation executions'){const items=await ExecutionLog.find({workspace:req.workspace._id,createdAt:range,...(isAgent(req)||filters.number||filters.team||filters.assignedTo?{conversation:{$in:all.map(chat=>chat._id)}}:{})}).lean();rows=[['Automation','Version','Mode','Status','Date'],...items.map(item=>[item.automation,item.version,item.mode,item.status,item.createdAt.toISOString()])];}
    else if(type==='Usage'){const entries=await WalletEntry.find({workspace:req.workspace._id,createdAt:range}).lean();rows=[['Date','Activity','Test credits (paise)','Status','Currency','Mode'],...entries.map(entry=>[entry.createdAt.toISOString(),entry.activity,entry.deltaPaise,entry.status,'INR','test'])];}
    else if(type==='Account summary')rows=[['Metric','Value'],['Conversations',selected.length],...Object.entries(messageMetrics(periodMessages)),...Object.entries(responseTimes(periodMessages))];
    else throw Object.assign(new Error('Choose a supported report type.'),{status:400});
    const item=await createWithCapacity(req,'reports',ReportRequest,{workspace:req.workspace._id,type,dateRange:range.$gte.toISOString()+' to '+range.$lt.toISOString(),requestedBy:req.user._id,status:'Complete',fileName:type.toLowerCase().replaceAll(' ','-')+'-'+Date.now()+'.csv',content:csv(rows)});
    await audit(req,'report.generate','ReportRequest',item._id);res.status(201).json({item:{_id:item._id,fileName:item.fileName,status:item.status}});
  }catch(error){next(error);}
});
router.get('/billing',async(req,res,next)=>{
  try{const workspace=req.workspace._id;const [wallet,entries,invoices,plan]=await Promise.all([TestWallet.findOne({workspace}).lean(),WalletEntry.find({workspace}).sort({createdAt:-1}).limit(50).lean(),PlatformInvoice.find({workspace}).sort({createdAt:-1}).limit(50).lean(),effectiveWorkspacePlan(req.workspace)]);res.json({plan,seatLimits:req.workspace.seatLimits,seats:req.workspace.members.filter(member=>!member.disabled&&member.role==='agent').length,wallet,entries,invoices,payment:{available:false,reason:'Payment gateway and production billing are not configured. Wallet entries are test credits; no real funds or confirmed provider charges.'}});}catch(error){next(error);}
});
router.get('/alerts',async(req,res,next)=>{
  try{
    const workspace=req.workspace._id;
    if (isAgent(req)) {
      const { all } = await data(req);
      const delayed=all.filter(chat=>chat.status==='awaiting_reply' && +new Date(chat.lastInboundAt)<Date.now()-15*60000).length;
      return res.json({items:delayed?[{type:'delayed-response',title:delayed+' permitted chats awaiting a reply for over 15 minutes',page:'Inbox'}]:[]});
    }
    const allowed=(capability,feature)=>req.user.role==='superadmin'||req.permissions.includes(capability)&&(!feature||req.enabledFeatures.includes(feature));
    const [unassigned,delayed,failed,rejected,wallet]=await Promise.all([allowed('conversations.read','conversations')?Conversation.countDocuments({workspace,assignedTo:null,status:{$ne:'closed'}}):0,allowed('conversations.read','conversations')?Conversation.countDocuments({workspace,status:'awaiting_reply',lastInboundAt:{$lt:new Date(Date.now()-15*60000)}}):0,allowed('campaigns.read','campaigns')?Message.countDocuments({workspace,status:'failed',createdAt:{$gte:new Date(Date.now()-86400000)}}):0,allowed('templates.read','templates')?MessageTemplate.countDocuments({workspace,status:'Rejected'}):0,allowed('wallet.read')?TestWallet.findOne({workspace}).lean():null]);
    const items=[];if(unassigned)items.push({type:'unassigned',title:unassigned+' unassigned chats',page:'Inbox'});if(delayed)items.push({type:'delayed-response',title:delayed+' chats awaiting a reply for over 15 minutes',page:'Inbox'});if(failed)items.push({type:'campaign-failure',title:failed+' failed sends in the last 24 hours',page:'Campaigns'});if(rejected)items.push({type:'template-rejection',title:rejected+' rejected templates',page:'Templates'});if(wallet&&wallet.balancePaise<(req.workspace.settings?.lowBalancePaise||0))items.push({type:'low-balance',title:'Test wallet below the configured threshold',page:'Wallet'});if(allowed('integrations.manage')&&(!configuration().configured||String(workspace)!==process.env.SMARTPING_WORKSPACE_ID))items.push({type:'connection',title:'WhatsApp configuration required',page:'WhatsApp Numbers'});res.json({items:items.filter(item=>req.workspace.settings?.notificationPreferences?.[item.type]!==false)});
  }catch(error){next(error);}
});
export default router;
