import 'dotenv/config';
import {connectDatabase} from '../config/db.js';
import {processNextJob,sendingWorkerEnabled} from '../services/businessJobs.js';
if(!sendingWorkerEnabled()){
  console.error('Worker refused to start. Production NODE_ENV, ENABLE_OUTBOUND_JOBS=true and --allow-live-sends are all required. API/dev startup never starts this worker.');
  process.exitCode=1;
}else{
  await connectDatabase();
  let busy=false;
  setInterval(async()=>{if(busy)return;busy=true;try{await processNextJob();}catch{console.error('Business worker could not process a job.');}finally{busy=false;}},1000);
}
