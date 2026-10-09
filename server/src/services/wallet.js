import mongoose from 'mongoose';
import { randomInt } from 'node:crypto';
import Workspace from '../models/Workspace.js';
import { Message } from '../models/Domain.js';
import { TestWallet, WalletEntry, WalletConfig } from '../models/Wallet.js';
import { ACTIVITY_PRICES, MAX_WALLET_PAISE, WALLET_DEFAULTS, workspacePricing } from './walletConfig.js';
import { SmartpingError } from './smartping.js';
import { attachWalletCharge, markNewWalletCharge, walletChargeReceipt } from './walletReceipts.js';

export async function walletConfig(session) {
  let query = WalletConfig.findOne({ key: 'test-wallet' }); if (session) query = query.session(session);
  const saved = await query.lean();
  return { ...WALLET_DEFAULTS, ...saved, prices: { ...ACTIVITY_PRICES, ...saved?.prices } };
}
export async function walletTransaction(fn) {
  const session = await mongoose.startSession(); let result;
  try {
    for (let attempt = 0; ; attempt++) {
      try { await session.withTransaction(async () => { result = await fn(session); }); return result; }
      catch (error) {
        // Concurrent first-use wallet creation can collide on the workspace index.
        if (attempt >= 2 || error.code !== 11000 || !error.keyPattern?.workspace || Object.keys(error.keyPattern).length !== 1) throw error;
      }
    }
  } finally { await session.endSession(); }
}
export async function ensureTestWallet(workspace, session, settings) {
  if (!session) return walletTransaction(passed => ensureTestWallet(workspace, passed, settings));
  if (!await Workspace.exists({ _id: workspace, deletedAt: null }).session(session)) throw new SmartpingError('Workspace not found.', 404);
  const existing = await TestWallet.findOne({ workspace }).session(session);
  if (existing) return existing;
  settings ||= await walletConfig(session);
  const amount = randomInt(settings.openingMinPaise, settings.openingMaxPaise + 1);
  const [wallet] = await TestWallet.create([{ workspace, balancePaise: amount, mode: 'test', currency: 'INR' }], { session });
  await WalletEntry.create([{ workspace, kind: 'opening', deltaPaise: amount, balanceAfterPaise: amount, operationKey: 'opening:test-v1', reason: 'One-time random test credits. Not real money.' }], { session });
  return wallet;
}
export async function chargeActivity({ workspace, activity, recordId, actor, session, reserved = false, operationKey = `activity:${activity}:${recordId}`, reason = `Test price for ${activity}; one unit.` }) {
  if (!Object.hasOwn(ACTIVITY_PRICES, activity)) throw new SmartpingError('Unknown billable activity.');
  const settings = await walletConfig(session);
  const previous = await WalletEntry.findOne({ workspace, operationKey }).session(session);
  if (previous) return previous;
  if (!settings.deductionsEnabled) return null;
  // Serialize price changes with usage, including sends that do not create a
  // capacity-checked record. Old ledger entries keep their original unit price.
  const business = await Workspace.findOneAndUpdate({ _id: workspace, deletedAt: null }, { $inc: { capacityVersion: 1 } }, { new: true, session });
  if (!business) throw new SmartpingError('Workspace not found.', 404);
  const pricing = workspacePricing(settings, business);
  await ensureTestWallet(workspace, session, settings);
  const price = pricing.prices[activity];
  const wallet = await TestWallet.findOneAndUpdate({ workspace, balancePaise: { $gte: price } }, { $inc: { balancePaise: -price } }, { new: true, session, runValidators: true });
  if (!wallet) throw new SmartpingError('Insufficient test wallet balance. Ask the superadmin to add test credits.', 402);
  const [entry] = await WalletEntry.create([{ workspace, actor, kind: 'activity', activity, recordId, unitPricePaise: price, deltaPaise: -price, balanceAfterPaise: wallet.balancePaise, operationKey, status: reserved && price > 0 ? 'reserved' : 'complete', reason }], { session });
  return markNewWalletCharge(entry);
}

export async function demoWalletActivity(workspace, payload, actor) {
  if (!payload || typeof payload.activity !== 'string' || !Object.hasOwn(ACTIVITY_PRICES, payload.activity)) throw new SmartpingError('Choose a valid demo activity.');
  if (typeof payload.idempotencyKey !== 'string' || !/^[a-zA-Z0-9._-]{8,100}$/.test(payload.idempotencyKey)) throw new SmartpingError('A unique demo request key is required.');
  const { activity, idempotencyKey } = payload;
  const operationKey = `demo-activity:${idempotencyKey}`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await walletTransaction(async session => {
        const previous = await WalletEntry.findOne({ workspace, operationKey }).session(session);
        if (previous && previous.activity !== activity) throw new SmartpingError('This demo request key belongs to a different activity.', 409);
        const settings = await walletConfig(session);
        const wallet = await ensureTestWallet(workspace, session, settings);
        if (wallet.mode !== 'test' || wallet.currency !== 'INR') throw new SmartpingError('Demo activities can only use an INR test wallet.', 409);
        const result = { activity, currency: 'INR', mode: 'test', duplicate: Boolean(previous), chargedPaise: 0, balanceAfterPaise: wallet.balancePaise, walletCharges: [] };
        if (previous) return { ...result, reason: 'This demo activity was already processed. No additional credits were deducted.' };
        if (!settings.deductionsEnabled) return { ...result, reason: 'Test wallet deductions are paused by the superadmin.' };
        const entry = await chargeActivity({ workspace, activity, actor, session, operationKey, reason: `Demo activity: ${activity}; one unit. No provider action or business record was created.` });
        const receipt = walletChargeReceipt(entry);
        return { ...result, chargedPaise: -entry.deltaPaise || 0, balanceAfterPaise: entry.balanceAfterPaise, walletCharges: receipt ? [receipt] : [], reason: entry.deltaPaise < 0 ? 'Demo activity completed using test credits only. No real action was performed.' : 'This demo activity has a free test price. No credits were deducted.' };
      });
    } catch (error) {
      // A concurrent replay can reach the unique ledger key first. Retry the
      // transaction to read that entry instead of charging the request again.
      if (attempt >= 2 || error.code !== 11000 || !error.keyPattern?.workspace || !error.keyPattern?.operationKey) throw error;
    }
  }
}
export async function adjustTestWallet(workspace, payload, actor) {
  return walletTransaction(async session => {
    const operationKey = 'adjustment:' + payload.idempotencyKey;
    const previous = await WalletEntry.findOne({ workspace, operationKey }).session(session);
    const delta = payload.direction === 'credit' ? payload.amountPaise : -payload.amountPaise;
    if (previous) {
      if (previous.deltaPaise !== delta || previous.reason !== payload.reason) throw new SmartpingError('This request key belongs to a different adjustment.', 409);
      return { entry: previous, duplicate: true };
    }
    await ensureTestWallet(workspace, session);
    const wallet = await TestWallet.findOneAndUpdate({ workspace, balancePaise: { $gte: Math.max(0, -delta), $lte: MAX_WALLET_PAISE - Math.max(0, delta) } }, { $inc: { balancePaise: delta } }, { new: true, session, runValidators: true });
    if (!wallet) throw new SmartpingError('Adjustment would overdraw the test wallet or exceed its maximum balance.', 409);
    const [entry] = await WalletEntry.create([{ workspace, actor, kind: 'adjustment', deltaPaise: delta, balanceAfterPaise: wallet.balancePaise, operationKey, reason: payload.reason }], { session });
    return { entry, duplicate: false };
  });
}
export async function persistMeteredMessage(item) {
  const result = await walletTransaction(async session => {
    const entry = await chargeActivity({ workspace: item.workspace, activity: 'messages', recordId: item._id, actor: item.sender, session, reserved: true });
    const [saved] = await Message.create([item.toObject()], { session }); return { saved, entry };
  });
  return attachWalletCharge(result.saved, result.entry);
}
export async function settleMessageCharge(workspace, recordId) {
  await WalletEntry.updateOne({ workspace, operationKey: `activity:messages:${recordId}`, status: 'reserved' }, { $set: { status: 'complete' } });
}
export async function refundRejectedMessage(workspace, recordId) {
  return walletTransaction(async session => {
    // Any recorded provider callback/acceptance means the provider processed the request.
    const message = await Message.findOne({ _id: recordId, workspace }).session(session);
    if (!message || message.providerMessageId || message.providerEventAt) return false;
    const charge = await WalletEntry.findOneAndUpdate({ workspace, operationKey: `activity:messages:${recordId}`, status: 'reserved' }, { $set: { status: 'refunded' } }, { new: true, session });
    if (!charge) return false;
    const amount = -charge.deltaPaise;
    const wallet = await TestWallet.findOneAndUpdate({ workspace, balancePaise: { $lte: MAX_WALLET_PAISE - amount } }, { $inc: { balancePaise: amount } }, { new: true, session });
    if (!wallet) throw new SmartpingError('Unable to refund the test reservation. Ask the superadmin to check this wallet.', 409);
    await WalletEntry.create([{ workspace, actor: charge.actor, kind: 'refund', activity: 'messages', recordId, deltaPaise: amount, balanceAfterPaise: wallet.balancePaise, operationKey: `refund:messages:${recordId}`, reason: 'Provider explicitly rejected the outgoing request.' }], { session });
    return true;
  });
}
export async function initializeTestWallets() {
  await Promise.all([TestWallet.init(), WalletEntry.init(), WalletConfig.init()]);
  let processed = 0;
  for await (const workspace of Workspace.find({ deletedAt: null }).select('_id').lean().cursor()) { await ensureTestWallet(workspace._id); processed++; }
  return processed;
}
