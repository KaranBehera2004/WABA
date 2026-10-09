export function messageMetrics(messages) {
  const outgoing = messages.filter(message => message.direction === 'outbound');
  return {
    sent: outgoing.filter(message => ['sent', 'delivered', 'read'].includes(message.status)).length,
    delivered: outgoing.filter(message => ['delivered', 'read'].includes(message.status)).length,
    read: outgoing.filter(message => message.status === 'read').length,
  };
}

export function averageResponseTime(messages) {
  const pending = new Map();
  const samples = [];
  for (const message of [...messages].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
    const id = String(message.conversation);
    if (message.direction === 'inbound' && !pending.has(id)) pending.set(id, new Date(message.createdAt).getTime());
    if (message.direction === 'outbound' && ['sent', 'delivered', 'read'].includes(message.status) && pending.has(id)) {
      samples.push(new Date(message.createdAt).getTime() - pending.get(id));
      pending.delete(id);
    }
  }
  return samples.length ? Math.round(samples.reduce((total, duration) => total + duration, 0) / samples.length) : null;
}

export function csv(rows) {
  return rows.map(row => row.map(value => {
    let cell = String(value ?? '');
    if (/^\s*[=+@-]/.test(cell) || /^[\t\r\n]/.test(cell)) cell = "'" + cell;
    return '"' + cell.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n');
}
