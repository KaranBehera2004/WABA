import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import { AdRecord, AnalyticsDashboard, Automation, CallLog, Campaign, Contact, Conversation, MessageTemplate, ReportRequest, Segment } from '../models/Domain.js';
import { CAPACITY_KEYS, effectiveSeatLimits, seatUsage } from './accessControl.js';
import { SmartpingError } from './smartping.js';
import { chargeActivity } from './wallet.js';
import { appendWalletCharge } from './walletReceipts.js';
import { effectiveWorkspacePlan } from './workspacePlan.js';

export const capacityModels = { contacts: Contact, conversations: Conversation, calls: CallLog, campaigns: Campaign, templates: MessageTemplate, automations: Automation, dashboards: AnalyticsDashboard, reports: ReportRequest, segments: Segment, ads: AdRecord };
export async function effectiveLimits(workspace, session = null) {
  const plan = await effectiveWorkspacePlan(workspace, session);
  const own = workspace.limits?.toObject ? workspace.limits.toObject() : workspace.limits || {};
  return Object.fromEntries(CAPACITY_KEYS.map(key => [key, own[key] !== undefined ? own[key] : plan?.limits?.[key] ?? null]));
}
export async function usageFor(workspace) {
  const [limits, ...counts] = await Promise.all([effectiveLimits(workspace), ...Object.values(capacityModels).map(Model => Model.countDocuments({ workspace: workspace._id }))]);
  return { workspace: { _id: workspace._id, name: workspace.name }, limits, overrides: workspace.limits || {}, seatLimits: effectiveSeatLimits(workspace), seatUsage: seatUsage(workspace), usage: { ...Object.fromEntries(Object.keys(capacityModels).map((key, index) => [key, counts[index]])), members: workspace.members.length } };
}
export async function createWithCapacity(req, resource, Model, payload, walletCharger = chargeActivity) {
  const recordId = new mongoose.Types.ObjectId();
  const session = await mongoose.startSession();
  let item, entry;
  try {
    await session.withTransaction(async () => {
      // All capacity-checked creates serialize on the workspace, so parallel requests cannot overrun limits.
      const workspace = await Workspace.findOneAndUpdate({ _id: req.workspace._id, deletedAt: null }, { $inc: { capacityVersion: 1 } }, { new: true, session });
      if (!workspace) throw new SmartpingError('Workspace not found.', 404);
      const limits = await effectiveLimits(workspace, session);
      if (req.user.role !== 'superadmin' && limits[resource] !== null && await Model.countDocuments({ workspace: workspace._id }).session(session) >= limits[resource]) throw new SmartpingError(`This workspace has reached its ${resource} limit. Contact the platform administrator.`, 403);
      entry = await walletCharger({ workspace: workspace._id, activity: resource, recordId, actor: req.user._id, session });
      [item] = await Model.create([{ ...payload, _id: recordId }], { session });
    });
  } finally { await session.endSession(); }
  // Publish only after the record and its wallet entry have committed together.
  appendWalletCharge(req, entry);
  return item;
}
