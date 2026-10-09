import mongoose from 'mongoose';
import { CAPABILITIES, ROLE_PERMISSION_LIMITS, capacityFields, seatFields, WORKSPACE_ROLES } from '../services/accessControl.js';
import { FEATURES } from './Platform.js';
import { ACTIVITY_PRICES } from '../services/walletConfig.js';

const customPlanSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  monthlyPrice: { type: Number, required: true, min: 0 },
  currency: { type: String, enum: ['INR', 'USD', 'EUR'], required: true },
  description: { type: String, maxlength: 1000 },
  features: { type: [String], enum: FEATURES },
  limits: capacityFields,
  activityPricesPaise: Object.fromEntries(Object.keys(ACTIVITY_PRICES).map(activity => [activity, { type: Number, min: 0, max: 1000000, validate: { validator: value => value === undefined || Number.isSafeInteger(value), message: 'Activity prices must be whole paise.' } }])),
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: Date,
}, { _id: false });

const workspaceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  email: { type: String, trim: true, lowercase: true, maxlength: 200 },
  phone: { type: String, trim: true, maxlength: 32 },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isActive: { type: Boolean, default: true },
  deletedAt: Date,
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPlan' },
  customPlan: { type: customPlanSchema, default: undefined },
  subscriptionEndsAt: Date,
  disabledFeatures: [String],
  addonFeatures: { type: [String], enum: FEATURES, default: [] },
  seatLimits: seatFields,
  sendingEnabled: { type: Boolean, default: true },
  adminNotes: { type: String, maxlength: 3000, select: false },
  permissionRules: [{ role: { type: String, enum: WORKSPACE_ROLES, required: true }, permissions: [{ type: String, enum: CAPABILITIES }] }],
  rolePolicy: {
    creatableRoles: { type: [String], enum: WORKSPACE_ROLES, default: ['admin', 'agent'] },
    permissionCeilings: [{ role: { type: String, enum: WORKSPACE_ROLES, required: true }, permissions: [{ type: String, enum: CAPABILITIES }] }],
  },
  rolePolicyVersion: { type: Number, default: 0 },
  limits: capacityFields,
  capacityVersion: { type: Number, default: 0, select: false },
  members: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', ...WORKSPACE_ROLES, 'retired'], default: 'agent' },
    joinedAt: { type: Date, default: Date.now },
    disabled: { type: Boolean, default: false },
    teams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BusinessTeam' }],
    allowedNumbers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppNumber' }],
    visibility: { type: String, enum: ['assigned', 'teams'], default: 'assigned' },
    availability: { type: String, enum: ['available', 'away', 'offline'], default: 'offline' },
    capacity: { type: Number, default: 10, min: 1, max: 500 },
    canClaim: { type: Boolean, default: false },
    customPermissions: { type: [{ type: String, enum: CAPABILITIES }], default: null },
    permissionVersion: { type: Number, default: 0, min: 0 },
    lastAssignedAt: Date,
  }],
  settings: {
    timezone: { type: String, default: 'Asia/Kolkata' },
    supportEmail: String,
    businessDescription: String,
    logo: String,
    businessHours: { type: mongoose.Schema.Types.Mixed, default: {} },
    holidays: [String],
    routing: { strategy: { type: String, enum: ['manual', 'round-robin', 'least-active', 'team'], default: 'manual' }, team: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessTeam' }, allowClaim: { type: Boolean, default: false } },
    contactFields: [String],
    editableAgentFields: { type: [String], default: ['name', 'email', 'company'] },
    resolutionReasons: { type: [String], default: ['Question answered', 'Issue resolved', 'No response', 'Other'] },
    notificationPreferences: { type: mongoose.Schema.Types.Mixed, default: {} },
    lowBalancePaise: { type: Number, default: 100000, min: 0 },
  },
  whatsapp: {
    phoneNumberId: String,
    businessAccountId: String,
    connected: { type: Boolean, default: false },
  },
}, { timestamps: true });

// Legacy Viewer records remain denied until explicitly reassigned. Saving a
// business retires their old role without granting any new permissions.
workspaceSchema.pre('validate', function retireViewer(next) {
  for (const member of this.members) if (member.role === 'viewer') { member.role = 'retired'; member.disabled = true; member.customPermissions = null; }
  this.permissionRules = this.permissionRules.filter(rule => WORKSPACE_ROLES.includes(rule.role));
  next();
});
workspaceSchema.index({ 'members.user': 1 });
export default mongoose.model('Workspace', workspaceSchema);
