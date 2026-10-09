import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import router from './businessCampaigns.js';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import {PlatformSettings} from '../models/Platform.js';
import {Campaign,Contact,MessageTemplate} from '../models/Domain.js';
import {BusinessAudit,BusinessJob} from '../models/Business.js';

test('confirmed campaign launch deduplicates concurrent requests and excludes opt-outs without dispatching',async t=>{
  const ids=Array.from({length:7},()=>new mongoose.Types.ObjectId());const [workspaceId,userId,campaignId,templateId,...contactIds]=ids;
  const workspace={_id:workspaceId,isActive:true,sendingEnabled:true,members:[{user:userId,role:'admin'}],settings:{},disabledFeatures:[],permissionRules:[]};
  const user={_id:userId,defaultWorkspace:workspaceId,isActive:true,role:'owner',sessionVersion:0};
  const campaign={_id:campaignId,workspace:workspaceId,status:'Draft',template:templateId,contactIds,variableMapping:{},save:async function(){return this;}};
  const contacts=contactIds.map((_id,index)=>({_id,name:'Test '+index,phone:index===2?'+919876543210':'+91987654321'+index,subscribed:index!==1,optInAt:new Date('2026-01-01'),optInSource:'test',...(index===1?{optOutAt:new Date()}:{} )}));
  const env={JWT_SECRET:'campaign-test-only',SMARTPING_WORKSPACE_ID:String(workspaceId),SMARTPING_JOURNEY_ID:'test-journey',SMARTPING_FROM:'+919999999999',SMARTPING_AUTH_TOKEN:'test-only-no-network'};
  const before=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  const mocks=[];const mock=(model,key,value)=>{mocks.push([model,key,model[key]]);model[key]=value;};const query=value=>{const q={session:()=>q,select:()=>q,limit:()=>q,lean:async()=>value,then:(resolve,reject)=>Promise.resolve(value).then(resolve,reject)};return q;};
  let lock=Promise.resolve(),queued=[],locks=0;
  mock(mongoose,'startSession',async()=>({withTransaction:async fn=>{let release;const previous=lock;lock=new Promise(resolve=>{release=resolve;});await previous;try{await fn();}finally{release();}},endSession:async()=>{}}));
  mock(User,'findById',async()=>user);mock(Workspace,'findOne',async()=>workspace);mock(Workspace,'findById',async()=>workspace);
  mock(Workspace,'findOneAndUpdate',async(filter,update,options)=>{assert.equal(String(filter._id),String(workspaceId));assert.equal(update.$inc.capacityVersion,1);assert.ok(options.session);locks++;return workspace;});
  mock(PlatformSettings,'findOne',()=>query({broadcastsEnabled:true,maxBroadcastRecipients:5000}));
  mock(Campaign,'findOne',filter=>{assert.equal(String(filter.workspace),String(workspaceId));return query(String(filter._id)===String(campaignId)?campaign:null);});
  mock(MessageTemplate,'findOne',async filter=>{assert.equal(String(filter.workspace),String(workspaceId));assert.equal(filter.status,'Approved');return{_id:templateId,status:'Approved',providerPayload:{templateId:'approved-test-template'}};});
  mock(Contact,'find',filter=>{assert.equal(String(filter.workspace),String(workspaceId));return query(filter.$or?contacts.filter(contact=>!contact.subscribed||contact.optOutAt):contacts);});
  mock(BusinessJob,'init',async()=>BusinessJob);
  mock(BusinessJob,'insertMany',async(items,options)=>{assert.ok(options.session);assert.equal(new Set(items.map(item=>item.key)).size,items.length);assert.ok(items.every(item=>String(item.workspace)===String(workspaceId)));queued.push(...items);return items;});
  mock(BusinessAudit,'create',async items=>items);
  const app=express();app.use(express.json());app.use('/api/business/campaigns',router);app.use((error,_req,res,_next)=>res.status(error.status||500).json({message:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const request=body=>fetch('http://127.0.0.1:'+server.address().port+'/api/business/campaigns/'+campaignId+'/launch',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({sub:String(userId),version:0},process.env.JWT_SECRET,{issuer:'waba-api'})},body:JSON.stringify(body)});
  try{
    await t.test('launch requires final confirmation',async()=>{assert.equal((await request({idempotencyKey:'same-launch-key'})).status,400);assert.equal(queued.length,0);});
    await t.test('parallel identical launches create one recipient job and preserve draft recipient exclusions',async()=>{const responses=await Promise.all([request({confirm:true,idempotencyKey:'same-launch-key'}),request({confirm:true,idempotencyKey:'same-launch-key'})]);assert.deepEqual(responses.map(response=>response.status),[202,202]);assert.equal(queued.length,1);assert.equal(queued[0].payload.contact,String(contactIds[0]));assert.equal(locks,2);assert.equal(campaign.audienceSize,1);assert.equal(queued[0].status,'pending');});
    await t.test('a second launch key cannot dispatch the same campaign again',async()=>{assert.equal((await request({confirm:true,idempotencyKey:'different-launch-key'})).status,409);assert.equal(queued.length,1);});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const[model,key,value]of mocks.reverse())model[key]=value;for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
