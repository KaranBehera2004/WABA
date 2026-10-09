import 'dotenv/config';
import mongoose from 'mongoose';
import {connectDatabase} from '../config/db.js';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import {Contact,Conversation,MessageTemplate} from '../models/Domain.js';
import {BusinessTag,BusinessTeam} from '../models/Business.js';
import {phoneNumber} from '../services/smartping.js';
const apply=process.argv.includes('--apply');
mongoose.set('autoIndex',false);
mongoose.set('autoCreate',false);
await connectDatabase();
const report={mode:apply?'apply':'dry-run',workspaces:0,retiredMemberships:0,contacts:0,invalidPhones:0,duplicateGroups:0,normalized:0};
try{
  for await(const workspace of Workspace.find({deletedAt:null}).cursor()){
    report.workspaces++;
    const retired=workspace.members.filter(member=>member.role==='viewer'&&!member.disabled);report.retiredMemberships+=retired.length;
    const contacts=await Contact.find({workspace:workspace._id}).lean();const byPhone=new Map();const tags=new Set();
    for(const contact of contacts){report.contacts++;for(const tag of contact.tags||[])if(tag&&tag.length<=60)tags.add(tag);try{const phone=phoneNumber(contact.phone);const group=byPhone.get(phone)||[];group.push(contact);byPhone.set(phone,group);}catch{report.invalidPhones++;}}
    for(const [phone,group]of byPhone){if(group.length>1){report.duplicateGroups++;continue;}report.normalized++;if(apply)await Contact.updateOne({_id:group[0]._id,workspace:workspace._id},{$set:{normalizedPhone:phone}});}
    // Keep original phone values and duplicate records. No deletion, merging,
    // consent creation or role promotion is performed by this migration.
    if(apply){
      for(const member of retired)await Workspace.updateOne({_id:workspace._id,members:{$elemMatch:{user:member.user,role:'viewer'}}},{$set:{'members.$.disabled':true}});
      await User.updateMany({_id:{$in:retired.map(member=>member.user)}},{$inc:{sessionVersion:1}});
      for(const name of ['Sales','Support'])await BusinessTeam.updateOne({workspace:workspace._id,name},{$setOnInsert:{name}},{upsert:true});
      for(const name of tags)await BusinessTag.updateOne({workspace:workspace._id,name},{$setOnInsert:{name,color:'#159b80'}},{upsert:true});
      // New fields use schema defaults. Old status strings are preserved and
      // translated at the API boundary, so existing inbox data stays readable.
      await Conversation.updateMany({workspace:workspace._id,version:{$exists:false}},{$set:{version:0}});
    }
  }
  console.log(JSON.stringify(report,null,2));
  if(apply){
    await Contact.collection.createIndex({workspace:1,normalizedPhone:1},{unique:true,partialFilterExpression:{normalizedPhone:{$type:'string'}}});
    // Create the replacement constraint before removing the old name-only
    // constraint. Existing templates remain uniquely identified by language.
    await MessageTemplate.collection.createIndex({workspace:1,name:1,language:1},{unique:true});
    const indexes=await MessageTemplate.collection.indexes();
    const old=indexes.find(index=>index.unique&&index.key.workspace===1&&index.key.name===1&&!index.key.language);
    if(old)await MessageTemplate.collection.dropIndex(old.name);
  }
  if(report.duplicateGroups)console.log('Duplicate groups were preserved and left unnormalized. Review them explicitly in Contacts before merging.');
}finally{await mongoose.disconnect();}
