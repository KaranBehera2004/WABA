import {BusinessAudit,BusinessIntegration,BusinessJob} from '../models/Business.js';
export function auditBusinessChanges(req,res,next){
  let responseRecord,responseStatus;
  const json=res.json.bind(res);
  res.json=body=>{responseRecord=body?.item?._id;responseStatus=body?.item?.status;return json(body);};
  res.on('finish',()=>{
    if(!req.workspace||!req.user||req.user.role==='superadmin')return;
    const pathname=req.originalUrl.split('?')[0];if(pathname.includes('/invitation/accept')||req.method==='GET'&&!/\/(export|download)$/.test(pathname))return;
    const action=req.method.toLowerCase()+'.'+pathname.replace(/^\/api\//,'').replace(/[a-f0-9]{24}/g,':id');
    const recordId=String(responseRecord||pathname.match(/[a-f0-9]{24}/)?.[0]||req.workspace._id);
    void BusinessAudit.create({workspace:req.workspace._id,actor:req.user._id,action,recordType:pathname.split('/')[2],recordId,result:res.statusCode<400?'success':res.statusCode<500?'rejected':'failed'}).catch(()=>console.error('Business audit write failed.'));
    if(res.statusCode<400){
      const event=req.method==='POST'&&pathname==='/api/conversations'&&res.statusCode===201?'conversation.created':req.method==='PATCH'&&/\/contacts\//.test(pathname)?'contact.updated':req.method==='PATCH'&&/\/conversations\//.test(pathname)&&responseStatus==='closed'?'conversation.resolved':null;
      if(event)void queueBusinessEvent(req.workspace._id,event,recordId).catch(()=>console.error('Business webhook enqueue failed.'));
    }
  });next();
}
export async function queueBusinessEvent(workspace,event,recordId){const integrations=await BusinessIntegration.find({workspace,provider:'webhook',enabled:true,subscriptions:event});for(const integration of integrations)await BusinessJob.create({workspace,kind:'webhook',key:'webhook:'+integration._id+':'+event+':'+recordId+':'+Date.now(),recordId,payload:{integration:String(integration._id),event},status:'pending'});}
