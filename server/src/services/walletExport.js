import mongoose from 'mongoose';
import { WalletEntry } from '../models/Wallet.js';
import { SmartpingError } from './smartping.js';

export const WALLET_EXPORT_BATCH_SIZE = 250;
export const WALLET_EXPORT_COLUMNS = ['Date (UTC)', 'Activity', 'Change (INR)', 'Balance after (INR)', 'Status', 'Details', 'Actor', 'Record ID', 'Transaction ID', 'Currency', 'Mode'];

// Quote every text cell and neutralize formulas without changing numeric money cells.
export function walletCsvText(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function walletCsvMoney(paise) {
  if (!Number.isSafeInteger(paise)) throw new SmartpingError('A saved wallet transaction contains an invalid amount.', 500);
  const amount = Math.abs(paise);
  return (paise < 0 ? '-' : '') + Math.floor(amount / 100) + '.' + String(amount % 100).padStart(2, '0');
}

const title = value => String(value || '').replace(/_/g, ' ').replace(/(^|\s)\S/g, character => character.toUpperCase());
export function walletCsvRow(entry) {
  const date = new Date(entry.createdAt);
  if (Number.isNaN(date.getTime()) || !/^[a-f0-9]{24}$/i.test(String(entry._id))) throw new SmartpingError('A saved wallet transaction contains invalid export data.', 500);
  return [
    walletCsvText(date.toISOString()), walletCsvText(title(entry.activity || entry.kind)),
    walletCsvMoney(entry.deltaPaise), walletCsvMoney(entry.balanceAfterPaise),
    walletCsvText(title(entry.status)), walletCsvText(entry.reason), walletCsvText(entry.actor?.name),
    walletCsvText(entry.recordId), walletCsvText(entry._id), walletCsvText('INR'), walletCsvText('test'),
  ].join(',') + '\r\n';
}

// Read-only, bounded seek pagination: neither initializes a wallet nor changes its balance.
// Preparing the first batch before setting attachment headers keeps initial failures as JSON.
export async function prepareWalletCsvExport(workspace, now = new Date()) {
  const workspaceId = String(workspace).toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(workspaceId)) throw new SmartpingError('A valid workspace ID is required.');
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new SmartpingError('Invalid export date.', 500);
  const batch = before => WalletEntry.find({ workspace, ...(before ? { _id: { $lt: new mongoose.Types.ObjectId(before) } } : {}) })
    .populate('actor', 'name').sort({ _id: -1 }).limit(WALLET_EXPORT_BATCH_SIZE).lean();
  const first = await batch();
  const firstCsv = first.map(walletCsvRow).join('');
  return {
    filename: `waba-wallet-transactions-${workspaceId}-${date.toISOString().slice(0, 10)}.csv`,
    async *chunks() {
      yield '\uFEFF' + WALLET_EXPORT_COLUMNS.map(walletCsvText).join(',') + '\r\n' + firstCsv;
      let entries = first;
      while (entries.length === WALLET_EXPORT_BATCH_SIZE) {
        entries = await batch(String(entries.at(-1)._id));
        if (entries.length) yield entries.map(walletCsvRow).join('');
      }
    },
  };
}
