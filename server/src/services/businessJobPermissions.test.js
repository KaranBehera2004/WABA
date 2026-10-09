import test from 'node:test';
import assert from 'node:assert/strict';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import {PlatformSettings} from '../models/Platform.js';
import {jobActorContext,sendingWorkerEnabled} from './businessJobs.js';
import {workspaceRolePolicy} from './accessControl.js';

test('queued delegated work rechecks role grants, module access, membership and expiry without sending',async()=>{
 const original=[Workspace.findOne,User.findOne,PlatformSettings.findOne];
 const policy=workspaceRolePolicy({}); policy.permissionCeilings.find(rule=>rule.role==='agent').permissions.push('campaigns.send');
 const workspace={_id:'business',members:[{user:'agent',role:'agent',disabled:false}],rolePolicy:policy,permissionRules:[{role:'agent',permissions:['campaigns.send']}],disabledFeatures:[]};
 let user={_id:'agent',role:'agent'};
 Workspace.findOne=async()=>workspace; User.findOne=async()=>user; PlatformSettings.findOne=()=>({lean:async()=>({disabledFeatures:[]})});
 const job={workspace:'business',payload:{sender:'agent'}};
 try{
  assert.equal(sendingWorkerEnabled({NODE_ENV:'test',ENABLE_OUTBOUND_JOBS:'true'},['--allow-live-sends']),false);
  assert.equal((await jobActorContext(job,'campaigns.send','campaigns')).membership.role,'agent');
  workspace.rolePolicy.permissionCeilings.find(rule=>rule.role==='agent').permissions=[];
  await assert.rejects(jobActorContext(job,'campaigns.send','campaigns'),/permission.*revoked/);
  workspace.rolePolicy.permissionCeilings.find(rule=>rule.role==='agent').permissions=['campaigns.send'];
  workspace.disabledFeatures=['campaigns'];await assert.rejects(jobActorContext(job,'campaigns.send','campaigns'),/module.*revoked/);workspace.disabledFeatures=[];
  workspace.members[0].disabled=true;await assert.rejects(jobActorContext(job,'campaigns.send','campaigns'),/active business access/);workspace.members[0].disabled=false;
  workspace.subscriptionEndsAt=new Date(Date.now()-1000);await assert.rejects(jobActorContext(job,'campaigns.send','campaigns'),/expired/);delete workspace.subscriptionEndsAt;
  user=null;await assert.rejects(jobActorContext(job,'campaigns.send','campaigns'),/active business access/);
  user={_id:'root',role:'superadmin'};assert.equal((await jobActorContext(job,'campaigns.send','campaigns')).user.role,'superadmin');
 }finally{[Workspace.findOne,User.findOne,PlatformSettings.findOne]=original;}
});
