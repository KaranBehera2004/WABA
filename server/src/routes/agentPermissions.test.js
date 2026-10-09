import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import router from './superadmin.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { permissionsFor, ROLE_PERMISSION_LIMITS } from '../services/accessControl.js';
import { mergeManagedMembers } from '../services/superadminManagement.js';

const actorId='507f1f77bcf86cd799439011', workspaceId='507f1f77bcf86cd799439012', agentId='507f1f77bcf86cd799439013', ownerId='507f1f77bcf86cd799439014';
test('individual Agent overrides replace inheritance while retaining business policy', () => {
  const business={ permissionRules:[{role:'agent',permissions:['overview.read']}],settings:{routing:{allowClaim:true}} };
  assert.deepEqual(permissionsFor(business,{role:'agent',customPermissions:null},'agent'),['overview.read']);
  assert.deepEqual(permissionsFor(business,{role:'agent',customPermissions:[]},'agent'),[]);
  assert.deepEqual(permissionsFor(business,{role:'agent',customPermissions:['conversations.send','wallet.read','team.manage']},'agent'),['conversations.send']);
  assert.deepEqual(permissionsFor(business,{role:'viewer',customPermissions:['contacts.read']},'agent'),[]);
  assert.deepEqual(permissionsFor(business,{role:'agent'},'agent'),['overview.read']);
  const previous=new Workspace({members:[{user:agentId,role:'agent',customPermissions:['contacts.read'],permissionVersion:4}]}).members;
  const retained=mergeManagedMembers(previous,[{user:agentId,role:'agent',disabled:true,customPermissions:['conversations.send']}])[0];
  assert.deepEqual(Array.from(retained.customPermissions),['contacts.read']); assert.equal(retained.permissionVersion,4);
  const changed=mergeManagedMembers(previous,[{user:agentId,role:'admin'}])[0];
  assert.equal(changed.customPermissions,null); assert.equal(changed.permissionVersion,5);
  assert.equal(new Workspace({name:'Test',slug:'test-business',owner:ownerId,members:[{user:agentId,role:'agent',customPermissions:['integrations.manage']}]}).validateSync(), undefined);
});

test('individual permission API authorizes and scopes all reads and writes',async t=>{
  const secret=process.env.JWT_SECRET; process.env.JWT_SECRET='individual-permission-test-only';
  const originals=[]; const mock=(object,key,value)=>{originals.push([object,key,object[key]]);object[key]=value;};
  const query=value=>({select(){return this;},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
  const actor={_id:actorId,role:'superadmin',isActive:true,sessionVersion:0};
  const workspace=new Workspace({_id:workspaceId,owner:ownerId,name:'Test business',members:[{user:ownerId,role:'owner'},{user:agentId,role:'agent'},{user:actorId,role:'agent'}]});
  let writes=0,ended=0;
  workspace.save=async()=>{writes++;};
  mock(User,'findById',()=>query(actor));
  mock(Workspace,'findById',id=>query(String(id)===workspaceId?workspace:null));
  mock(Workspace,'findOneAndUpdate',async(filter,update,options)=>{
    assert.equal(filter.deletedAt,null);assert.equal(update.$inc.capacityVersion,1);assert.ok(options.session);
    return filter._id===workspaceId&&workspace.members.some(member=>String(member.user)===filter.members.$elemMatch.user&&member.role===filter.members.$elemMatch.role)?workspace:null;
  });
  let lock=Promise.resolve();
  mock(mongoose,'startSession',async()=>({withTransaction:async callback=>{const prior=lock;let release;lock=new Promise(resolve=>{release=resolve;});await prior;try{return await callback();}finally{release();}},endSession:async()=>{ended++;}}));
  const app=express();app.use(express.json());app.use('/api/superadmin',router);app.use((error,_req,res,_next)=>res.status(error.status||500).json({message:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const request=(business=workspaceId,user=agentId,method='GET',body,authenticated=true)=>fetch('http://127.0.0.1:'+server.address().port+'/api/superadmin/workspaces/'+business+'/members/'+user+'/permissions',{method,headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer '+jwt.sign({sub:actorId,version:0},process.env.JWT_SECRET,{issuer:'waba-api'})}:{})},...(body?{body:JSON.stringify(body)}:{})});
  try {
    await t.test('only active platform Super Admin can configure an Agent',async()=>{
      assert.equal((await request(workspaceId,agentId,'GET',undefined,false)).status,401);
      for(const role of ['agent','admin','owner']){actor.role=role;assert.equal((await request()).status,403);assert.equal((await request(workspaceId,agentId,'PUT',{permissions:[],expectedVersion:0})).status,403);}
      actor.role='superadmin';actor.isActive=false;assert.equal((await request()).status,401);actor.isActive=true;assert.equal(writes,0);
    });
    await t.test('GET exposes only selected Agent configuration and permitted actions',async()=>{
      const response=await request();assert.equal(response.status,200);const data=await response.json();
      assert.equal(data.customPermissions,null);assert.equal(data.version,0);assert.deepEqual(data.capabilities,ROLE_PERMISSION_LIMITS.agent);assert.equal(data.member.user,agentId);assert.equal(data.member.role,'agent');
      assert.equal((await request(ownerId)).status,404);assert.equal((await request(workspaceId,ownerId)).status,404);assert.equal((await request(workspaceId,workspaceId)).status,404);assert.equal((await request('invalid')).status,400);
    });
    await t.test('unsupported actions, duplicate grants and missing versions reject before saving',async()=>{
      for(const permissions of [['wallet.read'],['team.manage'],['integrations.manage'],['contacts.delete'],['campaigns.send'],['contacts.read','contacts.read'],'contacts.read'])assert.equal((await request(workspaceId,agentId,'PUT',{permissions,expectedVersion:0})).status,400);
      assert.equal((await request(workspaceId,agentId,'PUT',{permissions:[]})).status,400);assert.equal(writes,0);
    });
    await t.test('wrong business and non-Agent targets cannot be written',async()=>{
      assert.equal((await request(ownerId,agentId,'PUT',{permissions:[],expectedVersion:0})).status,404);
      assert.equal((await request(workspaceId,ownerId,'PUT',{permissions:[],expectedVersion:0})).status,404);assert.equal(writes,0);
    });
    await t.test('saving affects only one Agent and empty selection removes feature access',async()=>{
      assert.equal((await request(workspaceId,agentId,'PUT',{permissions:['contacts.read'],expectedVersion:0})).status,200);
      assert.deepEqual(permissionsFor(workspace,workspace.members[1],'agent'),['contacts.read']);assert.equal(workspace.members[2].customPermissions,null);assert.equal(workspace.members[1].role,'agent');
      assert.equal((await request(workspaceId,agentId,'PUT',{permissions:[],expectedVersion:1})).status,200);assert.deepEqual(permissionsFor(workspace,workspace.members[1],'agent'),[]);
    });
    await t.test('concurrent stale saves do not overwrite the winner',async()=>{
      const responses=await Promise.all([request(workspaceId,agentId,'PUT',{permissions:['contacts.read'],expectedVersion:2}),request(workspaceId,agentId,'PUT',{permissions:['conversations.read'],expectedVersion:2})]);
      assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);assert.equal(workspace.members[1].permissionVersion,3);assert.equal(writes,3);
    });
    await t.test('restoring inheritance and disabled membership do not enable business access',async()=>{
      workspace.members[1].disabled=true;
      assert.equal((await request(workspaceId,agentId,'PUT',{permissions:null,expectedVersion:3})).status,200);
      assert.equal(workspace.members[1].customPermissions,null);assert.equal(workspace.members[1].disabled,true);assert.equal(workspace.members[1].permissionVersion,4);
      const data=await(await request()).json();assert.equal(data.member.disabled,true);assert.equal(data.customPermissions,null);assert.equal(data.version,4);assert.ok(ended>=4);
    });
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const[object,key,original]of originals.reverse())object[key]=original;if(secret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=secret;}
});
