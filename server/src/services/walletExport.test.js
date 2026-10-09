import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletEntry } from '../models/Wallet.js';
import { prepareWalletCsvExport, walletCsvMoney, walletCsvRow, walletCsvText, WALLET_EXPORT_BATCH_SIZE, WALLET_EXPORT_COLUMNS } from './walletExport.js';

test('wallet CSV quotes text, preserves Unicode/newlines and neutralizes spreadsheet formulas', () => {
  assert.equal(walletCsvText('Normal, "quoted"\n₹ value'), '"Normal, ""quoted""\n₹ value"');
  for (const value of ['=SUM(A1)', '+123', '-cmd', '@SUM(A1)', ' \t=1+1', '\r\n+123', '\uFEFF@formula']) {
    assert.equal(walletCsvText(value), '"\'' + value + '"');
  }
  assert.equal(walletCsvText(null), '""');
  assert.equal(walletCsvText('Customer name'), '"Customer name"');
  const row = walletCsvRow({ _id: '507f1f77bcf86cd799439011', createdAt: '2026-10-05T12:00:00+05:30', activity: 'messages', deltaPaise: -75, balanceAfterPaise: 729238, status: 'reserved', reason: '=malicious,"text"', actor: { name: ' \t+123' } });
  assert.match(row, /^"2026-10-05T06:30:00\.000Z","Messages",-0\.75,7292\.38,"Reserved",/);
  assert.ok(row.endsWith(',"INR","test"\r\n'));
  assert.ok(row.includes('"\'=malicious,""text"""'));
  assert.ok(row.includes('"\' \t+123"'));
});

test('wallet CSV converts integer paise exactly and keeps signed money cells numeric', () => {
  for (const [paise, result] of [[0, '0.00'], [1, '0.01'], [-1, '-0.01'], [75, '0.75'], [-200, '-2.00'], [729538, '7295.38'], [Number.MAX_SAFE_INTEGER, '90071992547409.91']]) assert.equal(walletCsvMoney(paise), result);
  for (const invalid of [undefined, null, '100', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => walletCsvMoney(invalid), error => error.status === 500);
  assert.throws(() => walletCsvRow({ _id: 'bad', createdAt: new Date(), deltaPaise: 1, balanceAfterPaise: 1 }), error => error.status === 500);
});

test('wallet CSV export is bounded, exports every seek batch once, and supports empty history', async () => {
  const workspace = '507f1f77bcf86cd799439011', other = '507f1f77bcf86cd799439012';
  const id = number => number.toString(16).padStart(24, '0');
  const records = Array.from({ length: WALLET_EXPORT_BATCH_SIZE * 2 + 7 }, (_, index) => ({ _id: id(index + 1), workspace, kind: 'activity', activity: 'messages', createdAt: '2026-10-05T06:30:00Z', deltaPaise: -75, balanceAfterPaise: 50000 - index * 75, status: 'complete', reason: 'Test message' }));
  records.push({ ...records[0], _id: id(1000), workspace: other });
  const original = WalletEntry.find;
  const filters = [];
  WalletEntry.find = filter => {
    filters.push(filter);
    const query = {
      populate: (field, projection) => { assert.equal(field, 'actor'); assert.equal(projection, 'name'); return query; },
      sort: order => { assert.deepEqual(order, { _id: -1 }); return query; },
      limit: size => { assert.equal(size, WALLET_EXPORT_BATCH_SIZE); return query; },
      lean: async () => records.filter(record => record.workspace === String(filter.workspace) && (!filter._id || record._id < String(filter._id.$lt))).sort((a, b) => b._id.localeCompare(a._id)).slice(0, WALLET_EXPORT_BATCH_SIZE),
    };
    return query;
  };
  try {
    const exportFile = await prepareWalletCsvExport(workspace, new Date('2026-10-05T18:40:00Z'));
    assert.equal(exportFile.filename, `waba-wallet-transactions-${workspace}-2026-10-05.csv`);
    assert.equal(filters.length, 1, 'The first bounded read happens before attachment headers can be set.');
    records.push({ ...records[0], _id: id(9999) }); // Newly inserted, newer transactions do not shift seek pages.
    const chunks = []; for await (const chunk of exportFile.chunks()) chunks.push(chunk);
    const csv = chunks.join('');
    assert.equal(csv[0], '\uFEFF');
    assert.equal(csv.split('\r\n').length, WALLET_EXPORT_BATCH_SIZE * 2 + 9);
    assert.equal(filters.length, 3); assert.ok(filters.every(filter => String(filter.workspace) === workspace));
    assert.ok(!csv.includes(id(9999))); assert.ok(!csv.includes(id(1000)));
    assert.equal((csv.match(/"Messages"/g) || []).length, WALLET_EXPORT_BATCH_SIZE * 2 + 7);
    assert.ok(csv.indexOf(id(507)) < csv.indexOf(id(1)), 'Newest transactions are first.');
    records.length = 0;
    const empty = await prepareWalletCsvExport(workspace);
    let text = ''; for await (const chunk of empty.chunks()) text += chunk;
    assert.equal(text, '\uFEFF' + WALLET_EXPORT_COLUMNS.map(walletCsvText).join(',') + '\r\n');
    await assert.rejects(prepareWalletCsvExport('bad-id'), error => error.status === 400);
  } finally { WalletEntry.find = original; }
});
