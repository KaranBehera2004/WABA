import mongoose from 'mongoose';
import { capacityFields } from '../services/accessControl.js';

export const FEATURES = ['contacts', 'conversations', 'calls', 'campaigns', 'templates', 'automations', 'analytics', 'dashboards', 'reports', 'segments', 'ads', 'team'];
const settingsSchema = new mongoose.Schema({
  key: { type: String, default: 'platform', unique: true },
  platformName: { type: String, default: 'WABADesk', maxlength: 100 },
  supportEmail: { type: String, default: '', maxlength: 200 },
  supportPhone: { type: String, default: '', maxlength: 40 },
  supportUrl: { type: String, default: '', maxlength: 500 },
  termsUrl: { type: String, default: '', maxlength: 500 },
  privacyUrl: { type: String, default: '', maxlength: 500 },
  loginTitle: { type: String, default: 'Welcome back', maxlength: 100 },
  loginDescription: { type: String, default: 'Enter your credentials to access your workspace.', maxlength: 500 },
  footerText: { type: String, default: '', maxlength: 300 },
  registrationEnabled: { type: Boolean, default: true },
  workspaceCreationEnabled: { type: Boolean, default: true },
  memberAccessEnabled: { type: Boolean, default: true },
  maintenanceEnabled: { type: Boolean, default: false },
  maintenanceMessage: { type: String, default: 'WABA is temporarily under maintenance. Please try again later.', maxlength: 500 },
  sendingEnabled: { type: Boolean, default: true },
  broadcastsEnabled: { type: Boolean, default: true },
  maxBroadcastRecipients: { type: Number, default: 100, min: 1, max: 100 },
  disabledFeatures: [{ type: String, enum: FEATURES }],
  defaultTimezone: { type: String, default: 'Asia/Kolkata' },
  defaultPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPlan', default: null },
  trialDays: { type: Number, default: 0, min: 0, max: 365 },
  workspaceLimitPerOwner: { type: Number, default: null, min: 0, max: 1000 },
  allowedSignupDomains: { type: [String], default: [] },
  passwordMinLength: { type: Number, default: 8, min: 8, max: 64 },
  passwordRequireUppercase: { type: Boolean, default: false },
  passwordRequireNumber: { type: Boolean, default: false },
  sessionLifetimeHours: { type: Number, default: null, min: 1, max: 720 },
  controlVersion: { type: Number, default: 0 },
}, { timestamps: true });
const planSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  monthlyPrice: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'INR', enum: ['INR', 'USD', 'EUR'] },
  features: { type: [String], enum: FEATURES, default: () => [...FEATURES] },
  isActive: { type: Boolean, default: true },
  description: { type: String, maxlength: 1000 },
  limits: capacityFields,
}, { timestamps: true });
const auditSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace' },
  target: String, details: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
auditSchema.index({ createdAt: -1 });
const invoiceSchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  invoiceNumber: { type: String, required: true, unique: true },
  description: { type: String, required: true, maxlength: 1000 },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, enum: ['INR', 'USD', 'EUR'], default: 'INR' },
  status: { type: String, enum: ['Draft', 'Issued', 'Paid', 'Void'], default: 'Draft' },
  dueAt: Date, paidAt: Date, paymentReference: { type: String, maxlength: 200 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
export const PlatformSettings = mongoose.model('PlatformSettings', settingsSchema);
export const PlatformPlan = mongoose.model('PlatformPlan', planSchema);
export const AdminAudit = mongoose.model('AdminAudit', auditSchema);
export const PlatformInvoice = mongoose.model('PlatformInvoice', invoiceSchema);
const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  level: { type: String, enum: ['Info', 'Warning', 'Critical'], default: 'Info' },
  audience: { type: String, enum: ['All workspaces', 'Selected workspaces'], default: 'All workspaces' },
  workspaces: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Workspace' }],
  isActive: { type: Boolean, default: false }, startsAt: Date, endsAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
export const PlatformAnnouncement = mongoose.model('PlatformAnnouncement', announcementSchema);
