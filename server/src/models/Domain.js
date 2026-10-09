import mongoose from 'mongoose';

const tenant = { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true };
const contactSchema = new mongoose.Schema({
  workspace: tenant, name: { type: String, required: true, trim: true }, phone: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true }, tags: [String], subscribed: { type: Boolean, default: false },
  source: { type: String, default: 'Organic' }, lastActiveAt: Date,
  company: String, customFields: { type: Map, of: String }, owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  optInSource: String, optInAt: Date, optOutAt: Date, archivedAt: Date,
  normalizedPhone: String,
}, { timestamps: true });
contactSchema.index({ workspace: 1, phone: 1 }, { unique: true });
contactSchema.index({ workspace: 1, normalizedPhone: 1 }, { unique: true, partialFilterExpression: { normalizedPhone: { $type: 'string' } } });

const conversationSchema = new mongoose.Schema({
  workspace: tenant, contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, channel: { type: String, default: 'whatsapp' },
  status: { type: String, enum: ['open', 'closed', 'awaiting_reply'], default: 'open' },
  stage: { type: String, default: 'New Lead' }, unreadCount: { type: Number, default: 0 }, lastMessage: String, lastMessageAt: Date,
  team: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessTeam' }, number: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppNumber' },
  tags: [String], resolutionReason: String, resolvedAt: Date, lastInboundAt: Date,
  humanTakeover: { type: Boolean, default: false }, version: { type: Number, default: 0 },
}, { timestamps: true });
conversationSchema.index({ workspace: 1, lastMessageAt: -1 });

const messageSchema = new mongoose.Schema({
  workspace: tenant, conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, direction: { type: String, enum: ['inbound', 'outbound'], required: true },
  type: { type: String, enum: ['text', 'image', 'document', 'audio', 'template'], default: 'text' }, body: String,
  status: { type: String, enum: ['queued', 'sent', 'delivered', 'read', 'failed', 'unknown'], default: 'queued' }, providerMessageId: String,
  provider: String, templatePayload: mongoose.Schema.Types.Mixed, metaData: mongoose.Schema.Types.Mixed,
  idempotencyKey: String, providerEventAt: Date, error: { code: String, message: String },
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },
  number: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppNumber' }, attachment: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });
messageSchema.index({ workspace: 1, conversation: 1, createdAt: 1 });
messageSchema.index({ workspace: 1, providerMessageId: 1 }, { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } });
messageSchema.index({ workspace: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

const callLogSchema = new mongoose.Schema({
  workspace: tenant, contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }, assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true }, ownerName: String, type: { type: String, enum: ['Missed', 'Declined', 'Outgoing', 'Incoming', 'Not Connected'], required: true },
  callbackPending: { type: Boolean, default: false }, tag: String, occurredAt: { type: Date, default: Date.now }, durationSeconds: { type: Number, default: 0 },
}, { timestamps: true });
callLogSchema.index({ workspace: 1, occurredAt: -1 });

const campaignSchema = new mongoose.Schema({
  workspace: tenant, name: { type: String, required: true, trim: true }, category: { type: String, enum: ['Marketing', 'Utility'], default: 'Marketing' },
  status: { type: String, enum: ['Draft', 'Scheduled', 'Running', 'Paused', 'Completed'], default: 'Draft' },
  templateName: String, audienceSize: { type: Number, default: 0 }, sent: { type: Number, default: 0 }, delivered: { type: Number, default: 0 }, read: { type: Number, default: 0 }, scheduledAt: Date,
  contactIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }], templatePayload: mongoose.Schema.Types.Mixed, dispatchKey: String,
  number: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppNumber' }, template: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageTemplate' },
  language: String, segment: { type: mongoose.Schema.Types.ObjectId, ref: 'Segment' }, variableMapping: { type: Map, of: String },
  cancelledAt: Date, confirmedAt: Date, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
campaignSchema.index({ workspace: 1, createdAt: -1 });

const templateSchema = new mongoose.Schema({
  workspace: tenant, name: { type: String, required: true, trim: true },
  category: { type: String, enum: ['Marketing', 'Utility', 'Authentication'], default: 'Marketing' },
  language: { type: String, default: 'English' }, body: { type: String, required: true, trim: true },
  status: { type: String, enum: ['Draft', 'Pending', 'Approved', 'Rejected'], default: 'Draft' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, lastUsedAt: Date,
  providerTemplateId: String, providerPayload: mongoose.Schema.Types.Mixed,
  components: { type: [mongoose.Schema.Types.Mixed], default: [] }, samples: { type: Map, of: String },
  rejectionReason: String, approvalSyncedAt: Date,
  metaTemplateId: String, providerStatus: String,
}, { timestamps: true });
templateSchema.index({ workspace: 1, name: 1, language: 1 }, { unique: true });

const automationSchema = new mongoose.Schema({
  workspace: tenant, name: { type: String, required: true, trim: true }, trigger: { type: String, required: true },
  message: { type: String, required: true }, status: { type: String, enum: ['Active', 'Inactive'], default: 'Inactive' },
  runs: { type: Number, default: 0 }, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  publication: { type: String, enum: ['Draft', 'Published'], default: 'Draft' }, enabled: { type: Boolean, default: false },
  version: { type: Number, default: 1 }, steps: [mongoose.Schema.Types.Mixed], versions: [mongoose.Schema.Types.Mixed],
  triggerConfig: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

const dashboardSchema = new mongoose.Schema({
  workspace: tenant, name: { type: String, required: true, trim: true }, widgets: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const reportSchema = new mongoose.Schema({
  workspace: tenant, type: { type: String, enum: ['Agent activity', 'Account summary', 'Conversations', 'Team performance', 'Campaign delivery', 'Template usage', 'Automation executions', 'Usage'], required: true },
  dateRange: { type: String, required: true }, status: { type: String, enum: ['Queued', 'Complete', 'Failed'], default: 'Complete' },
  fileName: String, content: { type: String, select: false }, requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const segmentSchema = new mongoose.Schema({
  workspace: tenant, name: { type: String, required: true, trim: true }, dynamic: { type: Boolean, default: false },
  criteria: { type: mongoose.Schema.Types.Mixed, default: {} }, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
segmentSchema.index({ workspace: 1, name: 1 }, { unique: true });

const adSchema = new mongoose.Schema({
  workspace: tenant, name: { type: String, required: true, trim: true }, source: { type: String, default: 'Meta' },
  status: { type: String, enum: ['Active', 'Paused', 'Completed'], default: 'Active' }, impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 }, chats: { type: Number, default: 0 }, costPerChat: { type: Number, default: 0 },
  conversionApi: { type: String, default: 'Not connected' }, spend: { type: Number, default: 0 },
}, { timestamps: true });

export const Contact = mongoose.model('Contact', contactSchema);
export const Conversation = mongoose.model('Conversation', conversationSchema);
export const Message = mongoose.model('Message', messageSchema);
export const CallLog = mongoose.model('CallLog', callLogSchema);
export const Campaign = mongoose.model('Campaign', campaignSchema);
export const MessageTemplate = mongoose.model('MessageTemplate', templateSchema);
export const Automation = mongoose.model('Automation', automationSchema);
export const AnalyticsDashboard = mongoose.model('AnalyticsDashboard', dashboardSchema);
export const ReportRequest = mongoose.model('ReportRequest', reportSchema);
export const Segment = mongoose.model('Segment', segmentSchema);
export const AdRecord = mongoose.model('AdRecord', adSchema);
