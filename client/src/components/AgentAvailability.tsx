import {useState} from 'react';
import {businessApi} from '../lib/api';
import {useBusinessData} from './BusinessModule';
export default function AgentAvailability({onNotice}:{onNotice:(text:string)=>void}){
  const result=useBusinessData<{membership:{availability:string;capacity:number};performance:{active:number;resolved:number;replies:number}}>('/me');const[busy,setBusy]=useState(false);
  return <section className="panel business-section"><h2>My availability & performance</h2>{result.error?<p role="alert">{result.error}</p>:<><label>Availability<select aria-label="My availability" disabled={busy||result.loading} value={result.data?.membership.availability||'offline'} onChange={async event=>{setBusy(true);try{await businessApi.patch('/me',{availability:event.target.value});result.reload();onNotice('Availability updated.');}catch(error){onNotice((error as Error).message);}finally{setBusy(false);}}}><option value="available">Available</option><option value="away">Away</option><option value="offline">Offline</option></select></label><p>{result.data?.performance.active??'—'} active / {result.data?.membership.capacity??'—'} capacity · {result.data?.performance.replies??'—'} confirmed replies</p><small>Counts use your recorded assignments and confirmed message statuses.</small></>}</section>;
}
