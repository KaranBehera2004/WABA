import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/db.js';
import Workspace from '../models/Workspace.js';
import { TestWallet, WalletEntry } from '../models/Wallet.js';

// Read-only reconciliation. No wallet, ledger, invoice or provider mutation.
try {
  await connectDatabase();
  const session = await mongoose.startSession(); let result;
  try {
    await session.withTransaction(async () => {
      const wallets = await TestWallet.find().session(session).lean();
      const rows = await WalletEntry.aggregate([{ $group: { _id: '$workspace', total: { $sum: '$deltaPaise' }, openings: { $sum: { $cond: [{ $eq: ['$kind', 'opening'] }, 1, 0] } } } }]).session(session);
      const totals = new Map(rows.map(row => [String(row._id), row]));
      const mismatches = wallets.filter(wallet => wallet.mode !== 'test' || wallet.currency !== 'INR' || !Number.isSafeInteger(wallet.balancePaise) || wallet.balancePaise < 0 || totals.get(String(wallet.workspace))?.total !== wallet.balancePaise || totals.get(String(wallet.workspace))?.openings !== 1);
      const businesses = await Workspace.countDocuments().session(session);
      result = { businesses, testWallets: wallets.length, ledgerMismatches: mismatches.length, allBusinessesInitialized: wallets.length === businesses };
    });
  } finally { await session.endSession(); }
  console.log(JSON.stringify(result));
  if (result.ledgerMismatches || !result.allBusinessesInitialized) process.exitCode = 1;
} catch (error) { console.error('Test wallet check failed:', error.message); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
