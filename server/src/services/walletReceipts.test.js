import test from 'node:test';
import assert from 'node:assert/strict';
import { appendWalletCharge, attachWalletCharge, markNewWalletCharge, settledRecordCharges, visibleWalletCharges, walletChargeReceipt } from './walletReceipts.js';

const entry = (changes = {}) => ({ _id: '507f1f77bcf86cd799439011', workspace: '507f1f77bcf86cd799439012', activity: 'calls', kind: 'activity', status: 'complete', deltaPaise: -500, balanceAfterPaise: 999500, ...changes });
test('wallet receipts expose only a new positive committed debit', () => {
  assert.equal(walletChargeReceipt(entry()), null, 'persisted replay entries are not new charges');
  const fresh = markNewWalletCharge(entry());
  assert.deepEqual(walletChargeReceipt(fresh), { entryId: fresh._id, workspace: fresh.workspace, activity: 'calls', chargedPaise: 500, balanceAfterPaise: 999500, mode: 'test', currency: 'INR' });
  assert.ok(!JSON.stringify(fresh).includes('new-wallet-charge'));
  for (const changes of [{ deltaPaise: 0 }, { deltaPaise: 500 }, { deltaPaise: -0.5 }, { balanceAfterPaise: -1 }, { balanceAfterPaise: 0.5 }, { status: 'refunded' }, { kind: 'adjustment' }, { activity: 'unknown' }]) assert.equal(walletChargeReceipt(markNewWalletCharge(entry(changes))), null);
});
test('message reservations become receipts only after confirmed settlement', () => {
  const reserved = markNewWalletCharge(entry({ activity: 'messages', status: 'reserved', deltaPaise: -75 }));
  assert.equal(walletChargeReceipt(reserved), null);
  assert.equal(settledRecordCharges(attachWalletCharge({}, reserved))[0].chargedPaise, 75);
  assert.deepEqual(settledRecordCharges({}), []);
  assert.deepEqual(settledRecordCharges(attachWalletCharge({}, markNewWalletCharge(entry({ status: 'refunded' })))), []);
});
test('responses never reveal wallet balances to members without wallet.read', () => {
  const req = { user: { role: 'agent' }, permissions: ['calls.create'] };
  appendWalletCharge(req, markNewWalletCharge(entry()));
  assert.equal(req.walletCharges.length, 1);
  assert.deepEqual(visibleWalletCharges(req), []);
  req.permissions.push('wallet.read'); assert.equal(visibleWalletCharges(req)[0].chargedPaise, 500);
  assert.equal(visibleWalletCharges({ user: { role: 'superadmin' } }, req.walletCharges).length, 1);
  assert.deepEqual(visibleWalletCharges({}), []);
});
