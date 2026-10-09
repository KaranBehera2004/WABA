import { SmartpingError } from './smartping.js';
export function periodFilter(query, now = new Date()) {
  const days = [7,30,90].includes(Number(query.days)) ? Number(query.days) : 7;
  const from = query.from ? new Date(query.from) : new Date(+now-days*86400000);
  const to = query.to ? new Date(query.to) : now;
  if (!Number.isFinite(+from) || !Number.isFinite(+to) || from >= to || to-from>366*86400000) throw new SmartpingError('Choose a valid date range of up to one year.');
  return { $gte: from, $lt: to };
}
export function responseTimes(messages, period) {
  const pending = new Map(), answered = new Set(), samples = [], first = [];
  for (const message of [...messages].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt))) {
    const id = String(message.conversation), time = +new Date(message.createdAt);
    if (message.direction === 'inbound' && !pending.has(id)) pending.set(id,time);
    if (message.direction === 'outbound' && ['sent','delivered','read'].includes(message.status) && pending.has(id)) {
      const duration = time-pending.get(id);
      if (!period || time>=+period.$gte && time<+period.$lt) { samples.push(duration); if(!answered.has(id))first.push(duration); }
      answered.add(id); pending.delete(id);
    }
  }
  const average = values => values.length ? Math.round(values.reduce((a,b)=>a+b,0)/values.length) : null;
  return { firstResponseMs: average(first), averageResponseMs: average(samples), responseSamples: samples.length, firstResponseSamples: first.length };
}
export const metricDefinitions = {
  conversations:'Conversations with activity (last message, or creation if no messages) in the selected date range and number.',
  open:'Status Open, awaiting_reply maps to Pending, closed maps to Resolved.',
  unread:'Sum of unreadCount on selected conversations; internal notes are excluded.',
  firstResponseMs:'Mean duration from the first inbound message to the first confirmed sent human reply per conversation, for replies in the selected range.',
  averageResponseMs:'Mean duration from the earliest unanswered inbound message to the next confirmed sent human reply, for replies in the selected range. Unanswered messages and failed/queued sends are excluded.',
  campaign:'Cumulative delivery states for campaign messages created in the selected range: Read is also Delivered and Sent; Failed is separate. Acceptance is not delivery.',
  workload:'Current active assigned chats, independent of the dashboard date range.',
};
