import mongoose from 'mongoose';
import { ACTIVITY_PRICES, MAX_WALLET_PAISE } from '../services/walletConfig.js';

const whole = { validator: Number.isSafeInteger, message: 'Amounts must be whole paise.' };
const walletSchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, unique: true },
  balancePaise: { type: Number, required: true, min: 0, max: MAX_WALLET_PAISE, validate: whole },
  mode: { type: String, enum: ['test'], default: 'test', immutable: true },
  currency: { type: String, enum: ['INR'], default: 'INR', immutable: true },
}, { timestamps: true });
const entrySchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  kind: { type: String, enum: ['opening', 'activity', 'adjustment', 'refund'], required: true },
  activity: { type: String, enum: Object.keys(ACTIVITY_PRICES) },
  recordId: mongoose.Schema.Types.ObjectId,
  deltaPaise: { type: Number, required: true, validate: whole },
  balanceAfterPaise: { type: Number, required: true, min: 0, validate: whole },
  unitPricePaise: { type: Number, min: 0, validate: whole },
  status: { type: String, enum: ['complete', 'reserved', 'refunded'], default: 'complete' },
  operationKey: { type: String, required: true },
  reason: { type: String, required: true, maxlength: 300 },
}, { timestamps: true });
entrySchema.index({ workspace: 1, operationKey: 1 }, { unique: true });
entrySchema.index({ workspace: 1, createdAt: -1, _id: -1 });
const configSchema = new mongoose.Schema({
  key: { type: String, default: 'test-wallet', unique: true },
  controlVersion: { type: Number, default: 0, select: false },
  deductionsEnabled: { type: Boolean, default: true },
  openingMinPaise: { type: Number, default: 500000, min: 0, max: 100000000, validate: whole },
  openingMaxPaise: { type: Number, default: 1000000, min: 0, max: 100000000, validate: whole },
  prices: Object.fromEntries(Object.entries(ACTIVITY_PRICES).map(([key, value]) => [key, { type: Number, default: value, min: 0, max: 1000000, validate: whole }])),
}, { timestamps: true });
export const TestWallet = mongoose.model('TestWallet', walletSchema);
export const WalletEntry = mongoose.model('WalletEntry', entrySchema);
export const WalletConfig = mongoose.model('WalletConfig', configSchema);
