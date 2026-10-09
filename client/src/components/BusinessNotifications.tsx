import {useEffect} from 'react';
import {businessApi} from '../lib/api';
import {useBusinessData} from './BusinessModule';
export default function BusinessNotifications({admin,onNavigate}:{admin:boolean;onNavigate:(page:string)=>void}){
  const notices=useBusinessData<{items:{_id:string;title:string;type:string;readAt?:string;recordId?:string}[]}>('/notifications'),alerts=useBusinessData<{items:{title:string;type:string;page:string}[]}>(admin?'/alerts':'/notifications');
  useEffect(()=>{const timer=setInterval(()=>{notices.reload();if(admin)alerts.reload();},30000);return()=>clearInterval(timer);},[admin]);
  return <section className="business-notifications"><b>Business alerts</b>{notices.error&&<p role="alert">{notices.error}</p>}{notices.data?.items.map(item=><button key={item._id} onClick={async()=>{try{await businessApi.patch('/notifications/'+item._id,{});notices.reload();if(item.recordId&&['assignment','takeover','transfer-request'].includes(item.type)){const url=new URL(location.href);url.searchParams.set('conversation',item.recordId);history.replaceState(history.state,'',url);onNavigate('Inbox');}}catch{notices.reload();}}}><span>{item.title}</span>{!item.readAt&&<small>New</small>}</button>)}{admin&&alerts.data?.items.map((item,index)=><button key={item.type+index} onClick={()=>onNavigate(item.page)}>{item.title}</button>)}{!notices.data?.items.length&&(!admin||!alerts.data?.items.length)&&<p>No business alerts.</p>}</section>;
}
