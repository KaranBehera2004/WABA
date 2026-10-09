import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import {Conversation} from '../models/Domain.js';
import {BusinessAudit,BusinessNotification,ConversationActivity} from '../models/Business.js';
import {assignConversation} from './assignment.js';
const query=value=>{const q={session:()=>q,lean:async()=>value,then:(resolve,reject)=>Promise.resolve(value).then(resolve,reject)};return q;};
test('parallel claims and assignment capacity use one business transaction and compare-and-set',async t=>{
  const[workspaceId,adminId,agentA,agentB,chatA,chatB]=Array.from({length:6},()=>new mongoose.Types.ObjectId());
  const workspace={_id:workspaceId,deletedAt:null,members:[{user:adminId,role:'admin'},{user:agentA,role:'agent',availability:'available',capacity:1,canClaim:true},{user:agentB,role:'agent',availability:'available',capacity:1,canClaim:true}],settings:{routing:{allowClaim:true}}};
  const chats=[{_id:chatA,workspace:workspaceId,status:'open',assignedTo:null,version:0},{_id:chatB,workspace:workspaceId,status:'open',assignedTo:null,version:0}];
  const mocks=[];const mock=(model,key,fn)=>{mocks.push([model,key,model[key]]);model[key]=fn;};let lock=Promise.resolve(),transactions=0,locks=0,cas=0;const events=[];
  mock(mongoose,'startSession',async()=>({withTransaction:async fn=>{let release;const previous=lock;lock=new Promise(resolve=>{release=resolve;});await previous;try{transactions++;await fn();}finally{release();}},endSession:async()=>{}}));
  mock(Workspace,'findOneAndUpdate',async(filter,update,options)=>{locks++;assert.equal(String(filter._id),String(workspaceId));assert.equal(update.$inc.capacityVersion,1);assert.ok(options.session);return workspace;});
  mock(Workspace,'updateOne',async()=>({modifiedCount:1}));
  mock(User,'find',()=>query([adminId,agentA,agentB].map(_id=>({_id,isActive:true}))));
  mock(Conversation,'findOne',filter=>query(chats.find(chat=>String(chat._id)===String(filter._id)&&String(chat.workspace)===String(filter.workspace))||null));
  mock(Conversation,'find',filter=>query(chats.filter(chat=>String(chat._id)!==String(filter._id?.$ne)&&chat.status!=='closed')));
  mock(Conversation,'findOneAndUpdate',async(filter,update,options)=>{
    cas++;assert.ok(options.session);assert.equal(String(filter.workspace),String(workspaceId));const chat=chats.find(chat=>String(chat._id)===String(filter._id)&&chat.version===filter.version&&(!('assignedTo'in filter)||chat.assignedTo==null));if(!chat)return null;Object.assign(chat,update.$set);chat.version++;return{...chat};
  });
  mock(ConversationActivity,'create',async(items,options)=>{assert.ok(options.session);events.push(...items);return items;});mock(BusinessAudit,'create',async items=>items);mock(BusinessNotification,'create',async items=>items);
  const req=id=>({workspace,user:{_id:id,role:'agent'},membership:workspace.members.find(member=>String(member.user)===String(id)),permissions:['conversations.claim']});
  try{
    await t.test('two Agents claiming one chat produce exactly one success',async()=>{const results=await Promise.allSettled([assignConversation(req(agentA),String(chatA),{claim:true}),assignConversation(req(agentB),String(chatA),{claim:true})]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.status===409).length,1);assert.equal(cas,1);assert.equal(events.filter(event=>event.action==='claimed').length,1);});
    await t.test('two chats cannot consume the same final agent capacity',async()=>{chats.forEach(chat=>{chat.assignedTo=null;chat.version=0;});cas=0;const admin={workspace,user:{_id:adminId,role:'owner'},membership:{role:'admin'},permissions:['conversations.assign']};const results=await Promise.allSettled([assignConversation(admin,String(chatA),{assignedTo:String(agentA)}),assignConversation(admin,String(chatB),{assignedTo:String(agentA)})]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(chats.filter(chat=>String(chat.assignedTo)===String(agentA)).length,1);assert.equal(cas,1);});
    await t.test('an empty eligible pool leaves round-robin routing unassigned',async()=>{workspace.members.filter(member=>member.role==='agent').forEach(member=>{member.availability='offline';});const admin={workspace,user:{_id:adminId,role:'owner'},membership:{role:'admin'},permissions:['conversations.assign']};const item=await assignConversation(admin,String(chatB),{strategy:'round-robin'});assert.equal(item.assignedTo,null);});
    assert.ok(transactions>=5);
    assert.equal(locks,transactions,'Every assignment must acquire the database business lock');
  }finally{for(const[model,key,fn]of mocks.reverse())model[key]=fn;}
});
