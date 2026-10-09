import 'dotenv/config';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
// Read-only smoke verification against an explicitly running local API.
// Never log credentials, customer records, invitation links or token contents.
mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);
try{
  await mongoose.connect(process.env.MONGODB_URI,{dbName:process.env.MONGODB_DB||'waba',serverSelectionTimeoutMS:10000});
  const workspace=await Workspace.findOne({isActive:true,deletedAt:null});
  if(!workspace)throw new Error('No active business is available for verification.');
  const member=workspace.members.find(member=>!member.disabled&&['owner','admin'].includes(member.role));
  const user=member?await User.findOne({_id:member.user,isActive:true,deletedAt:null}):null;
  if(!user)throw new Error('No active Business Admin is available for verification.');
  const token=jwt.sign({sub:String(user._id),version:user.sessionVersion||0},process.env.JWT_SECRET,{issuer:'waba-api',expiresIn:'5m'});
  const routes=['/workspaces/current','/business/dashboard','/conversations','/business/contacts','/business/users','/business/teams','/templates','/business/campaigns','/business/automations','/business/reports','/business/settings','/business/numbers','/business/integrations','/business/billing','/business/audit','/business/sessions','/business/me/inbox-options'];
  let failed=0;
  for(const route of routes){
    const response=await fetch('http://127.0.0.1:5000/api'+route,{headers:{Authorization:'Bearer '+token,'X-Workspace-Id':String(workspace._id)},signal:AbortSignal.timeout(10000)});
    const data=await response.json().catch(()=>({}));
    console.log(JSON.stringify({route,status:response.status,...(Array.isArray(data.items)?{records:data.items.length}:{}),...(response.ok?{}:{message:data.message||'Request failed'})}));
    if(!response.ok)failed++;
  }
  if(failed)process.exitCode=1;
}catch(error){console.error(error instanceof Error?error.message:'Verification failed');process.exitCode=1;}
finally{await mongoose.disconnect();}
