import { phoneNumber, SmartpingError } from './smartping.js';
// Small strict RFC4180 parser. Quoted commas/newlines are accepted; malformed
// quoting, duplicate headers and oversized files are rejected before writes.
export function parseContactCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 800000) throw new SmartpingError('CSV must be smaller than 800 KB.');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += char; }
    else if (char === '"') { if (cell || closed) throw new SmartpingError('Malformed CSV quoting.'); quoted = true; }
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (char !== ',') { if (row.some(value => value.trim())) rows.push(row); row = []; if (char === '\r' && text[i + 1] === '\n') i++; }
    } else { if (closed && char.trim()) throw new SmartpingError('Malformed CSV quoting.'); if (!closed) cell += char; }
  }
  if (quoted) throw new SmartpingError('Unclosed CSV quote.');
  row.push(cell); if (row.some(value => value.trim())) rows.push(row);
  const headers = (rows.shift() || []).map(value => value.replace(/^\uFEFF/, '').trim());
  if (!headers.includes('name') || !headers.includes('phone') || new Set(headers).size !== headers.length) throw new SmartpingError('CSV requires unique name and phone headers.');
  if (rows.length > 5000) throw new SmartpingError('Import up to 5,000 rows per file.');
  const seen = new Set();
  return rows.map((values, index) => {
    const contact = Object.fromEntries(headers.map((key, offset) => [key, values[offset]?.trim() || '']));
    try {
      if (values.length !== headers.length || !contact.name) throw new SmartpingError('Missing name or inconsistent column count.');
      contact.phone = phoneNumber(contact.phone); contact.normalizedPhone = contact.phone;
      if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new SmartpingError('Invalid email.');
      if (seen.has(contact.phone)) return { row: index + 2, contact, status: 'duplicate-file' };
      seen.add(contact.phone);
      contact.subscribed = false; // Import never manufactures consent.
      if (contact.optInAt && contact.optInSource) {
        if (!Number.isFinite(Date.parse(contact.optInAt)) || Date.parse(contact.optInAt) > Date.now()) throw new SmartpingError('Opt-in date must be valid and cannot be in the future.');
        contact.subscribed = true;
      }
      return { row: index + 2, contact, status: 'valid' };
    } catch (error) { return { row: index + 2, contact, status: 'invalid', error: error.message }; }
  });
}
export function campaignAudience(contacts) {
  const seen = new Set(); const eligible = []; const excluded = [];
  // An opt-out on any duplicate suppresses that phone, regardless of row order.
  const blocked = new Set();
  for (const contact of contacts) if (contact.optOutAt || contact.subscribed === false) {
    try { blocked.add(phoneNumber(contact.phone)); } catch { /* Invalid rows are reported below. */ }
  }
  for (const contact of contacts) {
    let reason;
    try {
      const phone = phoneNumber(contact.phone);
      if (blocked.has(phone)) reason = 'no-consent';
      else if (seen.has(phone)) reason = 'duplicate';
      else if (contact.archivedAt) reason = 'archived';
      else if (!contact.subscribed || !contact.optInAt || !contact.optInSource || !Number.isFinite(+new Date(contact.optInAt)) || +new Date(contact.optInAt) > Date.now()) reason = 'no-consent';
      else { eligible.push(contact); seen.add(phone); }
    } catch { reason = 'invalid-phone'; }
    if (reason) excluded.push({ contact: contact._id, reason });
  }
  return { eligible, excluded };
}
