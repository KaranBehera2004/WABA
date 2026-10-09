import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import router from './superadmin.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { permissionsFor, workspaceRolePolicy } from '../services/accessControl.js';
const rootId='507f1f77bcf86cd799439011',businessId='507f1f77bcf86cd799439012',agentId='507f1f77bcf86cd799439013';
test('root role policy API enforces platform authority, selected business and concurrent edit versions',async t=>{
 const originalSecret=process.env.JWT_SECRET;process.env.JWT_SECRET='role-policy-test-only';const originals=[];const mock=(model,key,fn)=>{originals.push([model,key,model[key]]);model[key]=fn;};
 const actor={_id:rootId,role:'superadmin',isActive:true,sessionVersion:0};const workspace=new Workspace({_id:businessId,name:'Business',slug:'business',owner:rootId,members:[{user:rootId,role:'owner'},{user:agentId,role:'agent'}]});let writes=0;workspace.save=async()=>{writes++;};
 mock(User,'findById',async()=>actor);mock(Workspace,'findById',async id=>String(id)===businessId?workspace:null);mock(Workspace,'findOneAndUpdate',async filter=>String(filter._id)===businessId?workspace:null);
 let lock=Promise.resolve();mock(mongoose,'startSession',async()=>({withTransaction:async fn=>{const prior=lock;let release;lock=new Promise(resolve=>release=resolve);await prior;try{await fn();}finally{release();}},endSession:async()=>{}}));
 const app=express();app.use(express.json());app.use('/api/superadmin',router);app.use((error,_req,res,_next)=>res.status(error.status||500).json({message:error.message}));const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const request=(method='GET',body,id=businessId)=>fetch('http://127.0.0.1:'+server.address().port+'/api/superadmin/workspaces/'+id+'/role-policy',{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({sub:rootId,version:0},process.env.JWT_SECRET,{issuer:'waba-api'})},body:body?JSON.stringify(body):undefined});
 try{
  await t.test('non-root accounts cannot read or mutate root role policy',async()=>{for(const role of ['admin','agent','supervisor']){actor.role=role;assert.equal((await request()).status,403);assert.equal((await request('PUT',{})).status,403);}actor.role='superadmin';assert.equal(writes,0);});
  const policy=workspaceRolePolicy(workspace);policy.creatableRoles.push('supervisor');policy.permissionCeilings.find(rule=>rule.role==='agent').permissions.push('wallet.read');
  await t.test('policy affects only the selected business and grants are explicit',async()=>{assert.equal((await request('PUT',{policy,expectedVersion:0},rootId)).status,404);assert.equal((await request('PUT',{policy:{...policy,creatableRoles:['superadmin']},expectedVersion:0})).status,400);assert.equal(writes,0);assert.equal((await request('PUT',{policy,expectedVersion:0})).status,200);assert.ok(permissionsFor(workspace,workspace.members[1],'agent').includes('wallet.read'));assert.equal(workspace.members[1].role,'agent');});
  await t.test('stale and concurrent updates cannot overwrite current access',async()=>{assert.equal((await request('PUT',{policy,expectedVersion:0})).status,409);const outcomes=await Promise.all([request('PUT',{policy,expectedVersion:1}),request('PUT',{policy,expectedVersion:1})]);assert.deepEqual(outcomes.map(result=>result.status).sort(),[200,409]);assert.equal(writes,2);});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const[model,key,value]of originals.reverse())model[key]=value;if(originalSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=originalSecret;}
});
