import { SmartpingError } from './smartping.js';
export const automationTriggers=['Welcome','Away','Keyword','Menu','Follow-up','Manual'];
export function validateTrigger(trigger,config={}){
  if(!automationTriggers.includes(trigger)||!config||typeof config!=='object'||Array.isArray(config))throw new SmartpingError('Select a supported trigger configuration.');
  const keywords=config.keywords||[],menu=config.menu||[];
  if(!Array.isArray(keywords)||keywords.length>50||keywords.some(value=>typeof value!=='string'||!value.trim()||value.length>100))throw new SmartpingError('Configure up to 50 valid keywords.');
  if(!Array.isArray(menu)||menu.length>10||menu.some(item=>!item||typeof item.id!=='string'||typeof item.label!=='string'||!item.id.trim()||!item.label.trim()||item.id.length>80||item.label.length>80)||new Set(menu.map(item=>item.id)).size!==menu.length)throw new SmartpingError('Configure up to 10 unique menu choices.');
  if(trigger==='Keyword'&&!keywords.length||trigger==='Menu'&&!menu.length)throw new SmartpingError('Add keywords or menu choices for this trigger.');
  return{keywords:keywords.map(value=>value.trim()),menu:menu.map(item=>({id:item.id.trim(),label:item.label.trim()}))};
}
export function triggerMatches(trigger,config={},event={}){
  if(trigger==='Keyword')return(config.keywords||[]).some(keyword=>String(event.text||'').toLowerCase().includes(keyword.toLowerCase()));
  if(trigger==='Menu')return(config.menu||[]).some(item=>item.id===event.choice);
  return true;
}
export function validateJourney(steps){
  if(!Array.isArray(steps)||!steps.length||steps.length>50)throw new SmartpingError('Configure 1 to 50 journey steps.');
  const supported=['message','condition','delay','assign','handoff','collect','webhook','hours'];
  for(const step of steps){
    if(!step||!supported.includes(step.type))throw new SmartpingError('Unsupported journey step.');
    if(step.type==='delay'&&(!Number.isInteger(step.seconds)||step.seconds<1||step.seconds>30*86400))throw new SmartpingError('Delay must be 1 second to 30 days.');
    if(step.type==='condition'&&(!['name','email','company','tags','subscribed'].includes(step.field)||!['equals','contains','exists'].includes(step.operator)))throw new SmartpingError('Invalid journey condition.');
    if(step.type==='message'&&typeof step.template!=='string')throw new SmartpingError('Automated messages require an approved template.');
    if(step.type==='collect'&&(!['name','email','company'].includes(step.field)&&!/^customFields\.[a-zA-Z0-9_]+$/.test(step.field)||!step.prompt))throw new SmartpingError('Configure a contact field and collection prompt.');
    if(step.type==='assign'&&!['round-robin','least-active','team'].includes(step.strategy))throw new SmartpingError('Choose a supported assignment strategy.');
    if(step.type==='webhook'&&typeof step.integration!=='string')throw new SmartpingError('Choose a configured webhook integration.');
  }
  return steps;
}
export function conditionMatches(step,contact){const value=contact[step.field];return step.operator==='exists'?Boolean(value):step.operator==='contains'?(Array.isArray(value)?value.includes(step.value):String(value||'').includes(String(step.value))):String(value)===String(step.value);}
export function businessOpen(settings,now=new Date()){
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone||'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'});
  const parts=Object.fromEntries(formatter.formatToParts(now).map(part=>[part.type,part.value]));const date=parts.year+'-'+parts.month+'-'+parts.day;
  if(settings.holidays?.includes(date))return false;
  const day=parts.weekday.toLowerCase(),days=['sun','mon','tue','wed','thu','fri','sat'];const schedule=settings.businessHours?.[day];
  const previous=settings.businessHours?.[days[(days.indexOf(day)+6)%7]];const current=parts.hour+':'+parts.minute;
  const previousDate=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)-1)).toISOString().slice(0,10);
  if(previous?.open&&previous?.close&&previous.open>previous.close&&current<previous.close&&!settings.holidays?.includes(previousDate))return true;
  if(!schedule?.open||!schedule?.close)return false;
  return schedule.open<schedule.close?current>=schedule.open&&current<schedule.close:schedule.open>schedule.close&&current>=schedule.open;
}
export function testJourney(steps,contact,settings,takeover=false){
  validateJourney(steps);if(takeover)return[{type:'takeover',status:'paused',message:'Bot actions pause during human takeover.'}];
  const results=[];for(const [index,step]of steps.entries()){
    let status='would-run';if(step.type==='condition'&&!conditionMatches(step,contact))status='condition-not-met';if(step.type==='hours'&&businessOpen(settings)!==Boolean(step.open))status='hours-not-met';
    results.push({index,type:step.type,status,...(step.type==='delay'?{seconds:step.seconds}:{})});if(['condition-not-met','hours-not-met'].includes(status)||step.type==='handoff')break;
  }return results;
}
