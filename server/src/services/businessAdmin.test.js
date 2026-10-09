import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignAudience,parseContactCsv} from './businessContacts.js';
import {assertLastAdmin,conversationScope,eligibleMembers,isAdmin,safeContactInput} from './businessPolicy.js';
import {permissionsFor,CAPABILITIES} from './accessControl.js';
import {periodFilter,responseTimes} from './businessMetrics.js';
import {encryptSecret,decryptSecret} from './businessSecrets.js';
import {businessOpen,testJourney,validateJourney} from './businessAutomations.js';
import {sendingWorkerEnabled,processNextJob} from './businessJobs.js';
import {publicAddress} from './webhookTransport.js';
const admin={user:{_id:'admin',role:'owner'},membership:{role:'admin'},workspace:{_id:'business',members:[{user:'admin',role:'admin'}],settings:{contactFields:['region']}}};
test('Agent custom grants have a mandatory ceiling; a retired role never receives grants',()=>{
  const workspace={permissionRules:[{role:'agent',permissions:CAPABILITIES},{role:'viewer',permissions:CAPABILITIES}],settings:{routing:{allowClaim:true}}};
  const grants=permissionsFor(workspace,{role:'agent'},'owner');
  for(const denied of ['wallet.read','team.manage','integrations.manage','contacts.delete','contacts.create','campaigns.send','automations.update','reports.read'])assert.ok(!grants.includes(denied),denied);
  assert.ok(grants.includes('conversations.send'));assert.deepEqual(permissionsFor(workspace,{role:'viewer'},'owner'),[]);
  assert.equal(isAdmin({...admin,membership:{role:'agent'}}),false);
});
test('conversation reads support selected teams, writes always require the primary Agent and permitted number',()=>{
  const req={...admin,user:{_id:'agent',role:'owner'},membership:{role:'agent',teams:['support'],visibility:'teams',allowedNumbers:['number-a']}};
  const read=conversationScope(req),write=conversationScope(req,{write:true});
  assert.equal(read.workspace,'business');assert.deepEqual(read.$and[0].$or,[{assignedTo:'agent'},{team:{$in:['support']}}]);
  assert.deepEqual(write.$and[0].$or,[{assignedTo:'agent'}]);assert.deepEqual(write.$and[1].$or,[{number:{$in:['number-a']}},{number:null}]);
});
test('last active Business Admin is protected; explicit reassignment of a retired role is possible',()=>{
  const members=[{user:'a',role:'owner'},{user:'b',role:'admin',disabled:true},{user:'c',role:'viewer',disabled:true}];
  assert.throws(()=>assertLastAdmin(members,'a',{role:'agent'}),/last active/);assert.throws(()=>assertLastAdmin(members,'a',{disabled:true}),/last active/);
  assert.equal(assertLastAdmin(members,'c',{role:'agent',disabled:false}).role,'viewer');
  assert.doesNotThrow(()=>assertLastAdmin([...members,{user:'d',role:'admin'}],'a',{disabled:true}));
});
test('routing eligibility respects active account, role, availability, team, number and capacity',()=>{
  const members=[{user:'a',role:'agent',availability:'available',teams:['t'],allowedNumbers:['n'],capacity:1},{user:'b',role:'agent',availability:'away',teams:['t'],allowedNumbers:['n']},{user:'c',role:'viewer',availability:'available'},{user:'d',role:'agent',availability:'available',teams:['t'],allowedNumbers:['n'],disabled:true}];
  const users=members.map(member=>({_id:member.user,isActive:true}));
  assert.deepEqual(eligibleMembers({members},users,[],{team:'t',number:'n'}).map(member=>member.user),['a']);
  assert.equal(eligibleMembers({members},users,[{assignedTo:'a',status:'awaiting_reply'}],{team:'t',number:'n'}).length,0);
  assert.equal(eligibleMembers({members},users.map(user=>({...user,isActive:false})),[],{}).length,0);
});
test('CSV preview validates quoting, phones, duplicates and consent without modifying records',()=>{
  const rows=parseContactCsv('name,phone,email,company,optInSource,optInAt\r\n"Sam, Lee",+919876543210,sam@example.com,"One\nTwo",Website,2026-01-01\r\nOther,91 98765 43210,,, ,\r\nNo consent,+919999999999,,,,\r\nBad,nope,,,,');
  assert.equal(rows[0].contact.name,'Sam, Lee');assert.equal(rows[0].contact.company,'One\nTwo');assert.equal(rows[0].contact.subscribed,true);assert.equal(rows[1].status,'duplicate-file');assert.equal(rows[2].contact.subscribed,false);assert.equal(rows[3].status,'invalid');
  assert.throws(()=>parseContactCsv('name,phone\n"bad,123'),/Unclosed/);assert.throws(()=>parseContactCsv('name,name,phone\na,b,c'),/unique/);
});
test('campaign audience excludes opt-outs, unknown consent, invalid phones, duplicates and archived contacts',()=>{
  const base={_id:'a',phone:'+919876543210',subscribed:true,optInSource:'Website',optInAt:new Date()};
  const result=campaignAudience([base,{...base,_id:'b',phone:'91 98765 43210'},{...base,_id:'c',phone:'+919876543211',optOutAt:new Date()},{...base,_id:'d',phone:'+919876543212',optInAt:null},{...base,_id:'e',phone:'invalid'},{...base,_id:'f',phone:'+919876543213',archivedAt:new Date()}]);
  assert.deepEqual(result.eligible.map(item=>item._id),['a']);assert.deepEqual(result.excluded.map(item=>item.reason),['duplicate','no-consent','no-consent','invalid-phone','archived']);
});
test('contact payloads normalize phones, require consent evidence and cannot change owners from Agent requests',()=>{
  assert.equal(safeContactInput({phone:'91 98765-43210',subscribed:false},admin).phone,'+919876543210');
  assert.throws(()=>safeContactInput({subscribed:true},admin),/opt-in/);
  const agent={...admin,membership:{role:'agent'},workspace:{...admin.workspace,settings:{editableAgentFields:['name']}}};
  assert.deepEqual(safeContactInput({name:'Sam',phone:'+919876543210',owner:'admin',subscribed:true,company:'No'},agent),{name:'Sam'});
});
test('a duplicate opt-out suppresses every copy regardless of audience order, and future consent is rejected',()=>{
  const optIn={_id:'a',phone:'+919876543210',subscribed:true,optInAt:new Date('2026-01-01'),optInSource:'Website'};
  const optOut={...optIn,_id:'b',phone:'91 98765 43210',subscribed:false,optOutAt:new Date()};
  assert.equal(campaignAudience([optIn,optOut]).eligible.length,0);
  assert.equal(campaignAudience([optOut,optIn]).eligible.length,0);
  assert.throws(()=>safeContactInput({subscribed:true,optInSource:'Website',optInAt:'2099-01-01'},admin),/future/);
  assert.equal(parseContactCsv('name,phone,optInSource,optInAt\nSam,+919876543210,Website,2099-01-01')[0].status,'invalid');
});
test('metrics use confirmed replies and preserve unanswered messages without manufacturing response values',()=>{
  const messages=[{conversation:'a',direction:'inbound',createdAt:new Date(1000)},{conversation:'a',direction:'outbound',status:'failed',createdAt:new Date(2000)},{conversation:'a',direction:'outbound',status:'sent',createdAt:new Date(5000)},{conversation:'a',direction:'inbound',createdAt:new Date(6000)},{conversation:'a',direction:'outbound',status:'delivered',createdAt:new Date(8000)},{conversation:'b',direction:'inbound',createdAt:new Date(1000)}];
  assert.deepEqual(responseTimes(messages),{firstResponseMs:4000,averageResponseMs:3000,responseSamples:2,firstResponseSamples:1});
  assert.equal(responseTimes([messages[0]]).averageResponseMs,null);assert.throws(()=>periodFilter({from:'bad'}),/valid date/);
});
test('AES-GCM credentials are bound to a business and cannot be opened in another business',()=>{
  const env={BUSINESS_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64')};const plain='private-provider-credential';const cipher=encryptSecret(plain,'one',env);
  assert.ok(!cipher.includes(plain));assert.equal(decryptSecret(cipher,'one',env),plain);assert.throws(()=>decryptSecret(cipher,'two',env),/could not be opened/);assert.throws(()=>encryptSecret(plain,'one',{}),/ENCRYPTION_KEY/);
});
test('journey dry runs stop at handoff and pause every bot action during human takeover',()=>{
  const steps=[{type:'condition',field:'company',operator:'equals',value:'Acme'},{type:'delay',seconds:60},{type:'handoff'},{type:'message',template:'approved'}];
  assert.equal(testJourney(steps,{company:'Acme'},{timezone:'UTC'}).length,3);assert.equal(testJourney(steps,{company:'Other'},{timezone:'UTC'}).length,1);assert.equal(testJourney(steps,{},{timezone:'UTC'},true)[0].status,'paused');assert.throws(()=>validateJourney([{type:'execute-code'}]),/Unsupported/);
  assert.equal(businessOpen({timezone:'UTC',businessHours:{mon:{open:'09:00',close:'17:00'}},holidays:[]},new Date('2026-10-05T10:00:00Z')),true);assert.equal(businessOpen({timezone:'UTC',holidays:['2026-10-05']},new Date('2026-10-05T10:00:00Z')),false);
});
test('development and API startup cannot process customer send jobs',async()=>{
  assert.equal(sendingWorkerEnabled({NODE_ENV:'development',ENABLE_OUTBOUND_JOBS:'true'},['--allow-live-sends']),false);assert.equal(sendingWorkerEnabled({NODE_ENV:'production',ENABLE_OUTBOUND_JOBS:'true'},[]),false);assert.equal(sendingWorkerEnabled({NODE_ENV:'production',ENABLE_OUTBOUND_JOBS:'false'},['--allow-live-sends']),false);assert.equal(await processNextJob(),false);
});
test('overnight business hours use the previous opening day and respect holidays',()=>{
  const settings={timezone:'UTC',businessHours:{mon:{open:'21:00',close:'02:00'}},holidays:[]};
  assert.equal(businessOpen(settings,new Date('2026-10-05T22:00:00Z')),true);
  assert.equal(businessOpen(settings,new Date('2026-10-06T01:00:00Z')),true);
  assert.equal(businessOpen(settings,new Date('2026-10-06T03:00:00Z')),false);
  assert.equal(businessOpen({...settings,holidays:['2026-10-05']},new Date('2026-10-06T01:00:00Z')),false);
});
test('webhook network transport rejects private and special DNS destinations',()=>{for(const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1'])assert.equal(publicAddress(address),false,address);assert.equal(publicAddress('8.8.8.8'),true);});
