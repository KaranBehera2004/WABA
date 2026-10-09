import Workspace from '../models/Workspace.js';
import { FEATURES, PlatformSettings } from '../models/Platform.js';
import { SmartpingError } from './smartping.js';
import { PLATFORM_DEFAULTS } from './platformConfig.js';
import { effectiveWorkspacePlan } from './workspacePlan.js';

export async function platformSettings() {
  return { ...PLATFORM_DEFAULTS, ...await PlatformSettings.findOne({ key: 'platform' }).lean() };
}
export async function workspaceFeatures(workspace, settings) {
  settings ||= await platformSettings();
  const plan = await effectiveWorkspacePlan(workspace);
  return [...new Set([...(plan?.features || FEATURES), ...(workspace.addonFeatures || []).filter(feature => FEATURES.includes(feature))])].filter(feature => !workspace.disabledFeatures?.includes(feature) && !settings.disabledFeatures?.includes(feature));
}
export function workspaceUnavailable(workspace, now = new Date()) {
  if (workspace.deletedAt) return 'This workspace has been deleted.';
  if (workspace.isActive === false) return 'This workspace has been suspended. Contact the platform administrator.';
  if (workspace.subscriptionEndsAt && new Date(workspace.subscriptionEndsAt) < now) return 'This workspace subscription has expired. Contact the platform administrator.';
  return '';
}
export async function checkSendingPolicy(workspaceId, { broadcast = false } = {}) {
  const [settings, workspace] = await Promise.all([platformSettings(), Workspace.findById(workspaceId)]);
  if (!workspace) throw new SmartpingError('Workspace not found.', 404);
  const unavailable = workspaceUnavailable(workspace);
  if (unavailable) throw new SmartpingError(unavailable, 403);
  if (settings.maintenanceEnabled || !settings.sendingEnabled || workspace.sendingEnabled === false) throw new SmartpingError('WhatsApp sending has been paused by the platform administrator.', 403);
  if (broadcast && !settings.broadcastsEnabled) throw new SmartpingError('Broadcast sending has been paused by the platform administrator.', 403);
  const features = await workspaceFeatures(workspace, settings);
  if (broadcast && !features.includes('campaigns')) throw new SmartpingError('Campaigns must be enabled for broadcast sending.', 403);
  if (!features.includes('conversations') || !features.includes('templates')) throw new SmartpingError('WhatsApp templates and conversations must be enabled for this workspace.', 403);
}
