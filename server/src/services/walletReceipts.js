import { ACTIVITY_PRICES } from './walletConfig.js';

// These markers only live in the current request. They are never persisted or
// serialized, so replaying a ledger entry cannot advertise a second deduction.
const freshCharge = Symbol('new-wallet-charge');
const recordCharge = Symbol('record-wallet-charge');

export function markNewWalletCharge(entry) {
  if (entry) Object.defineProperty(entry, freshCharge, { value: true });
  return entry;
}

export function attachWalletCharge(record, entry) {
  if (record && entry) Object.defineProperty(record, recordCharge, { value: entry });
  return record;
}

export function walletChargeReceipt(entry, { settled = false } = {}) {
  if (!entry?.[freshCharge] || entry.kind !== 'activity' || !Object.hasOwn(ACTIVITY_PRICES, entry.activity)) return null;
  if (entry.status !== 'complete' && !(settled && entry.status === 'reserved')) return null;
  if (!Number.isSafeInteger(entry.deltaPaise) || entry.deltaPaise >= 0 || !Number.isSafeInteger(entry.balanceAfterPaise) || entry.balanceAfterPaise < 0) return null;
  return { entryId: String(entry._id), workspace: String(entry.workspace), activity: entry.activity, chargedPaise: -entry.deltaPaise, balanceAfterPaise: entry.balanceAfterPaise, currency: 'INR', mode: 'test' };
}

export function settledRecordCharges(record) {
  const receipt = walletChargeReceipt(record?.[recordCharge], { settled: true });
  return receipt ? [receipt] : [];
}

export function appendWalletCharge(req, entry) {
  const receipt = walletChargeReceipt(entry);
  if (receipt) (req.walletCharges ||= []).push(receipt);
}

export function visibleWalletCharges(req, charges = req.walletCharges || []) {
  return req.user?.role === 'superadmin' || req.permissions?.includes('wallet.read') ? charges : [];
}
