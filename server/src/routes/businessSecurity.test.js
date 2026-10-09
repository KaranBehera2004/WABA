import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import {PlatformSettings} from '../models/Platform.js';
import {Contact,Conversation,Message,MessageTemplate,ReportRequest} from '../models/Domain.js';
import {AuthSession,BusinessNotification,ConversationActivity} from '../models/Business.js';
import businessRouter from './business.js';
import conversationRouter from './conversations.js';
import dataRouter from './data.js';
import workspaceRouter from './workspaces.js';
function matches(row,filter){return Object.entries(filter).every(([key,value])=>{
  if(key==='$and')return value.every(entry=>matches(row,entry));if(key==='$or')return value.some(entry=>matches(row,entry));
  const actual=row[key];if(value&&typeof value==='object'&&!(value instanceof mongoose.Types.ObjectId)&&!(value instanceof Date)){if('$in'in value)return value.$in.some(entry=>String(entry)===String(actual));if('$ne'in value)return String(actual)!==String(value.$ne);if('$gt'in value)return actual>value.$gt;}
  if(value===null)return actual==null;return String(actual)===String(value);
});}
const query=rows=>{const q={populate:()=>q,select:()=>q,sort:()=>q,skip:()=>q,limit:()=>q,session:()=>q,lean:async()=>rows,then:(resolve,reject)=>Promise.resolve(rows).then(resolve,reject)};return q;};
test('real HTTP routes reject cross-business, disabled and unauthorized Agent requests before exposing records',async t=>{
  const ids=Array.from({length:9},()=>new mongoose.Types.ObjectId());const[agentId,workspaceId,otherWorkspace,ownChat,otherChat,foreignChat,contactId,numberA,numberB]=ids;
  const user={_id:agentId,role:'owner',isActive:true,sessionVersion:0,defaultWorkspace:workspaceId};
  const member={user:agentId,role:'agent',availability:'available',teams:[],allowedNumbers:[numberA],visibility:'assigned'};
  const workspace={_id:workspaceId,members:[member],disabledFeatures:[],permissionRules:[],settings:{routing:{allowClaim:false},editableAgentFields:['name']}};
  const chats=[{_id:ownChat,workspace:workspaceId,assignedTo:agentId,contact:contactId,number:numberA,status:'open'},{_id:otherChat,workspace:workspaceId,assignedTo:ids[8],contact:contactId,number:numberA,status:'open'},{_id:foreignChat,workspace:otherWorkspace,assignedTo:agentId,number:numberA,status:'open'}];
  const contacts=[{_id:contactId,workspace:workspaceId,name:'Authorized customer'}];const mocks=[];const mock=(model,key,fn)=>{mocks.push([model,key,model[key]]);model[key]=fn;};let messageReads=0,contactWrites=0;
  const originalSecret=process.env.JWT_SECRET;process.env.JWT_SECRET='business-security-test-only';
  mock(User,'findById',async()=>user);mock(PlatformSettings,'findOne',()=>({lean:async()=>({})}));
  mock(Workspace,'findOne',async filter=>String(filter._id)===String(workspaceId)?workspace:null);
  mock(Workspace,'findById',()=>({populate:async()=>({...workspace})}));
  mock(Conversation,'findOne',filter=>query(chats.find(chat=>matches(chat,filter))||null));
  mock(Conversation,'find',filter=>query(chats.filter(chat=>matches(chat,filter))));mock(Conversation,'countDocuments',async filter=>chats.filter(chat=>matches(chat,filter)).length);
  mock(Conversation,'distinct',async(field,filter)=>[...new Set(chats.filter(chat=>matches(chat,filter)).map(chat=>chat[field]))]);
  mock(Contact,'exists',async filter=>contacts.find(contact=>matches(contact,filter))||null);
  mock(Contact,'find',filter=>query(contacts.filter(contact=>matches(contact,filter))));mock(Contact,'countDocuments',async filter=>contacts.filter(contact=>matches(contact,filter)).length);
  mock(Contact,'findOneAndUpdate',async(filter,update)=>{const contact=contacts.find(contact=>matches(contact,filter));if(contact){contactWrites++;Object.assign(contact,update.$set);}return contact||null;});
  mock(Message,'find',filter=>{messageReads++;assert.equal(String(filter.workspace),String(workspaceId));assert.ok([String(ownChat),String(otherChat)].includes(String(filter.conversation)));return query([{body:'Authorized message'}]);});
  mock(MessageTemplate,'find',filter=>{assert.equal(filter.status,'Approved');assert.equal(String(filter.workspace),String(workspaceId));return query([]);});
  mock(ReportRequest,'findOne',filter=>{assert.equal(String(filter.workspace),String(workspaceId));return query(null);});
  mock(ConversationActivity,'create',async items=>{assert.equal(items[0].action,'internal-note');assert.equal(String(items[0].workspace),String(workspaceId));return items;});
  mock(AuthSession,'exists',async()=>false);mock(BusinessNotification,'updateOne',async filter=>{assert.equal(String(filter.workspace),String(workspaceId));assert.equal(String(filter.user),String(agentId));return{modifiedCount:0};});
  const app=express();app.use(express.json());app.use('/api/business',businessRouter);app.use('/api/workspaces',workspaceRouter);app.use('/api/conversations',conversationRouter);app.use('/api',dataRouter);app.use((error,_req,res,_next)=>res.status(error.status||500).json({message:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const request=(path,method='GET',body,workspaceHeader,sid)=>fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{method,headers:{Authorization:'Bearer '+jwt.sign({sub:String(agentId),version:0,...(sid?{sid}:{})},process.env.JWT_SECRET,{issuer:'waba-api'}),'Content-Type':'application/json',...(workspaceHeader?{'X-Workspace-Id':String(workspaceHeader)}:{})},body:body?JSON.stringify(body):undefined});
  try{
    await t.test('Agent workspace metadata retains allowed modules but excludes negotiated billing terms',async()=>{
      workspace.customPlan={name:'Private commercial agreement',monthlyPrice:999,currency:'INR',features:['contacts','conversations','team'],limits:{}};
      const response=await request('/workspaces/current');assert.equal(response.status,200);const result=await response.json();assert.equal(result.workspace.customPlan,undefined);assert.ok(result.enabledFeatures.includes('contacts'));delete workspace.customPlan;
    });
    await t.test('individual permissions enforce live requests without changing role or scope',async()=>{
      member.customPermissions=['contacts.read'];
      assert.equal((await request('/contacts')).status,200);
      assert.equal((await request('/contacts/'+contactId,'PATCH',{name:'Denied'})).status,403);
      assert.equal((await request('/conversations')).status,403);
      const metadata=await(await request('/workspaces/current')).json();assert.equal(metadata.customPermissions,true);assert.deepEqual(metadata.permissions,['contacts.read']);
      member.customPermissions=['conversations.read','conversations.update'];
      assert.equal((await request('/conversations/'+foreignChat+'/notes','POST',{text:'Forbidden'})).status,404);
      assert.equal((await request('/conversations','GET',undefined,otherWorkspace)).status,403);
      member.disabled=true;assert.equal((await request('/conversations')).status,403);member.disabled=false;
      member.customPermissions=[];assert.equal((await request('/contacts')).status,403);
      member.customPermissions=null;assert.equal((await request('/contacts')).status,200);assert.equal(member.role,'agent');assert.equal(contactWrites,0);assert.equal(messageReads,0);
    });
    await t.test('business header cannot select a foreign business',async()=>{assert.equal((await request('/conversations','GET',undefined,otherWorkspace)).status,403);assert.equal(messageReads,0);});
    await t.test('Agent list and message queries expose only permitted assignments and numbers',async()=>{const result=await(await request('/conversations')).json();assert.deepEqual(result.items.map(chat=>chat._id),[String(ownChat)]);assert.equal((await request('/conversations/'+ownChat+'/messages')).status,200);assert.equal((await request('/conversations/'+otherChat+'/messages')).status,404);assert.equal((await request('/conversations/'+foreignChat+'/messages')).status,404);assert.equal(messageReads,1);chats[0].number=numberB;assert.equal((await request('/conversations/'+ownChat+'/messages')).status,404);chats[0].number=numberA;});
    await t.test('Agents cannot assign, export, delete, manage users, access credentials or billing even with old grants',async()=>{workspace.permissionRules=[{role:'agent',permissions:['conversations.read','conversations.update','contacts.read','contacts.update','wallet.read','integrations.manage','team.manage','campaigns.send','reports.read']}];for(const [path,method,body]of[['/wallet','GET'],['/campaigns','GET'],['/reports/'+ownChat+'/download','GET'],['/business/contacts/export','GET'],['/business/users','GET'],['/business/integrations','GET'],['/business/tags','POST',{name:'Forbidden'}],['/contacts/'+contactId,'DELETE'],['/conversations/'+ownChat+'/assign','POST',{assignedTo:String(agentId)}]])assert.equal((await request(path,method,body)).status,403,path);workspace.permissionRules=[];});
    await t.test('internal notes are local activity records and never call the provider or customer-message model',async()=>{const before=messageReads;assert.equal((await request('/conversations/'+ownChat+'/notes','POST',{text:'Private staff note'})).status,201);assert.equal(messageReads,before);assert.equal((await request('/conversations/'+otherChat+'/notes','POST',{text:'Forbidden'})).status,404);});
    await t.test('selected-team visibility permits reads while keeping mutation assigned-only',async()=>{member.visibility='teams';member.teams=[numberB];chats[1].team=numberB;assert.equal((await request('/conversations/'+otherChat+'/messages')).status,200);assert.equal((await request('/conversations/'+otherChat+'/notes','POST',{text:'No'})).status,404);member.visibility='assigned';member.teams=[];});
    await t.test('editable contact fields are enforced on the backend',async()=>{const result=await request('/contacts/'+contactId,'PATCH',{name:'Edited',phone:'+919876543210',subscribed:true,owner:String(agentId)});assert.equal(result.status,200);assert.equal(contacts[0].name,'Edited');assert.equal(contacts[0].phone,undefined);assert.equal(contacts[0].subscribed,undefined);assert.equal(contactWrites,1);});
    await t.test('disabled memberships, disabled accounts, revoked sessions and Viewer membership are rejected',async()=>{member.disabled=true;assert.equal((await request('/conversations')).status,403);member.disabled=false;user.isActive=false;assert.equal((await request('/conversations')).status,401);user.isActive=true;assert.equal((await request('/conversations','GET',undefined,undefined,'revoked')).status,401);member.role='viewer';workspace.permissionRules=[{role:'viewer',permissions:['conversations.read']}];assert.equal((await request('/conversations')).status,403);member.role='agent';workspace.permissionRules=[];});
    await t.test('retired role assignment cannot be submitted and foreign report files cannot be downloaded',async()=>{member.role='admin';assert.equal((await request('/business/invitations','POST',{email:'new@example.com',role:'viewer'})).status,400);assert.equal((await request('/reports/'+foreignChat+'/download')).status,404);});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const[model,key,fn]of mocks.reverse())model[key]=fn;if(originalSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=originalSecret;}
});
