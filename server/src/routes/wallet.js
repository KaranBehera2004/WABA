import { Router } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import { WalletConfig, WalletEntry } from '../models/Wallet.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { adjustTestWallet, demoWalletActivity, ensureTestWallet, initializeTestWallets, walletConfig, walletTransaction } from '../services/wallet.js';
import { ACTIVITY_PRICES, ACTIVITY_UNITS, validateWalletAdjustment, validateWalletConfig, workspacePricing } from '../services/walletConfig.js';
import { SmartpingError } from '../services/smartping.js';
import { prepareWalletCsvExport } from '../services/walletExport.js';

const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
const validId = value => { if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) throw new SmartpingError('A valid workspace or transaction ID is required.'); return value; };
export async function walletView(workspace, before, summaryOnly = false) {
  const wallet = await ensureTestWallet(workspace);
  const [defaults, business] = await Promise.all([walletConfig(), Workspace.findOne({ _id: workspace, deletedAt: null })]);
  if (!business) throw new SmartpingError('Workspace not found.', 404);
  const settings = workspacePricing(defaults, business);
  const result = { wallet, settings: { deductionsEnabled: settings.deductionsEnabled, prices: settings.prices, pricingSource: settings.pricingSource }, units: ACTIVITY_UNITS };
  if (summaryOnly) return result;
  const entries = await WalletEntry.find({ workspace, ...(before ? { _id: { $lt: new mongoose.Types.ObjectId(validId(before)) } } : {}) }).populate('actor', 'name').sort({ _id: -1 }).limit(51).lean();
  return { ...result, entries: entries.slice(0, 50), nextCursor: entries.length > 50 ? String(entries[49]._id) : null };
}
export const businessWallet = Router();
businessWallet.use(requireAuth, requireWorkspace);
businessWallet.get('/summary', wrap(async (req, res) => res.json(await walletView(req.workspace._id, null, true))));
businessWallet.get('/export', wrap(async (req, res) => {
  const download = await prepareWalletCsvExport(req.workspace._id);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${download.filename}"`, 'Cache-Control': 'private, no-store' });
  try { await pipeline(Readable.from(download.chunks()), res); }
  catch (error) {
    // A later database/connection error must terminate the partial attachment,
    // not append a JSON error to a CSV or falsely complete the download.
    if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(error); return; }
    res.removeHeader('Content-Type'); res.removeHeader('Content-Disposition'); res.removeHeader('Cache-Control');
    throw error;
  }
}));
businessWallet.get('/', wrap(async (req, res) => res.json(await walletView(req.workspace._id, req.query.before))));
businessWallet.post('/demo-activity', wrap(async (req, res) => {
  // wallet.read is deliberately not a spending permission. Do not use
  // requireRole here, whose permissionDecision shortcut also admits viewers.
  if (req.user.role !== 'superadmin' && !['owner', 'admin', 'agent'].includes(req.membership?.role)) throw new SmartpingError('Your workspace role cannot run wallet demo activities.', 403);
  const { activity, idempotencyKey } = req.body || {};
  if (typeof activity !== 'string' || !Object.hasOwn(ACTIVITY_PRICES, activity)) throw new SmartpingError('Choose a valid demo activity.');
  const feature = activity === 'messages' ? 'conversations' : activity;
  const capability = activity === 'messages' ? 'conversations.send' : `${activity}.create`;
  if (req.user.role !== 'superadmin' && (!req.enabledFeatures.includes(feature) || !req.permissions.includes(capability))) throw new SmartpingError('This activity is disabled or not permitted for your workspace role.', 403);
  const result = await demoWalletActivity(req.workspace._id, { activity, idempotencyKey }, req.user._id);
  res.status(result.duplicate || result.chargedPaise === 0 ? 200 : 201).json(result);
}));

// Mounted inside the superadmin router, beneath its database-backed root guard.
export const adminWallet = Router();
adminWallet.use((req, _res, next) => { req.body ||= {}; next(); });
adminWallet.get('/wallets/config', wrap(async (_req, res) => res.json({ settings: await walletConfig(), units: ACTIVITY_UNITS, mode: 'test', currency: 'INR' })));
adminWallet.patch('/wallets/config', wrap(async (req, res) => {
  const updates = validateWalletConfig(req.body);
  await walletTransaction(async session => {
    // Serialize partial settings updates, especially the opening credit min/max pair.
    await WalletConfig.findOneAndUpdate({ key: 'test-wallet' }, { $inc: { controlVersion: 1 } }, { upsert: true, new: true, session });
    const settings = { ...await walletConfig(session), ...updates };
    if (settings.openingMinPaise > settings.openingMaxPaise) throw new SmartpingError('Minimum opening credits cannot exceed the maximum.');
    const fields = { ...updates }; delete fields.prices;
    for (const [key, value] of Object.entries(updates.prices || {})) fields['prices.' + key] = value;
    await WalletConfig.findOneAndUpdate({ key: 'test-wallet' }, { $set: fields }, { new: true, session, runValidators: true });
  });
  req.body = updates;
  res.json({ settings: await walletConfig(), message: 'Test wallet prices saved. Existing balances and past charges were not changed.' });
}));
adminWallet.post('/wallets/initialize', wrap(async (req, res) => {
  if (req.body.confirmation !== 'INITIALIZE TEST WALLETS') throw new SmartpingError('Confirm initialization of missing test wallets. Existing wallets are not refilled.');
  res.json({ processed: await initializeTestWallets(), message: 'All current businesses have test wallets. Existing balances were preserved.' });
}));
adminWallet.get('/wallets/:id', wrap(async (req, res) => {
  const id = validId(req.params.id); if (!await Workspace.exists({ _id: id })) throw new SmartpingError('Workspace not found.', 404);
  req.workspace = { _id: id }; res.json(await walletView(id, req.query.before));
}));
adminWallet.post('/wallets/:id/adjust', wrap(async (req, res) => {
  const id = validId(req.params.id); const payload = validateWalletAdjustment(req.body);
  if (!await Workspace.exists({ _id: id, deletedAt: null })) throw new SmartpingError('Workspace not found.', 404);
  req.workspace = { _id: id }; req.body = payload;
  const result = await adjustTestWallet(id, payload, req.user._id);
  res.status(result.duplicate ? 200 : 201).json(result);
}));
