import Workspace from '../models/Workspace.js';
import { platformSettings, workspaceFeatures, workspaceUnavailable } from '../services/platform.js';
import { permissionsFor, requestCapability, WORKSPACE_ROLES } from '../services/accessControl.js';


export async function requireWorkspace(req, res, next) {
  try {
    const workspaceId = req.headers['x-workspace-id'] || req.user.defaultWorkspace;
    if (!workspaceId) return res.status(403).json({ message: 'A workspace is required.' });
    const workspace = await Workspace.findOne({ _id: workspaceId, deletedAt: null, ...(req.user.role === 'superadmin' ? {} : { 'members.user': req.user._id }) });
    if (!workspace || workspace.deletedAt) return res.status(403).json({ message: 'You do not have access to this workspace.' });
    req.workspace = workspace;
    req.membership = req.user.role === 'superadmin' ? { role: 'owner', user: req.user._id } : workspace.members.find(member => member.user.equals(req.user._id));
    if (req.user.role !== 'superadmin' && req.membership?.disabled) return res.status(403).json({ code: 'MEMBERSHIP_DISABLED', message: 'Your access to this business has been disabled.' });
    if (req.user.role !== 'superadmin' && req.membership?.role !== 'owner' && !WORKSPACE_ROLES.includes(req.membership?.role)) return res.status(403).json({ code: 'BUSINESS_ROLE_UNAVAILABLE', message: 'Your retired role has no business access. A Business Admin must explicitly reassign your role.' });
    const settings = await platformSettings();
    req.enabledFeatures = await workspaceFeatures(workspace, settings);
    req.permissions = permissionsFor(workspace, req.membership, req.user.role);
    if (req.user.role !== 'superadmin') {
      if (settings.memberAccessEnabled === false) return res.status(503).json({ message: 'Workspace access has been paused by the platform administrator.' });
      if (settings.maintenanceEnabled) return res.status(503).json({ message: settings.maintenanceMessage });
      const unavailable = workspaceUnavailable(workspace);
      if (unavailable) return res.status(403).json({ message: unavailable });
      const path = req.originalUrl.split('?')[0].toLowerCase().replace(/\/+$/, '');
      // Delegated roles require a known capability, except authenticated self data.
      const selfPath = /^\/api\/business\/(me|notifications)(\/|$)/.test(path) || /^\/api\/workspaces\/current(?:\/announcements)?$/.test(path) || req.method === 'GET' && path.endsWith('/integrations/smartping/status');
      if (['agent','supervisor'].includes(req.membership.role) && !selfPath && !requestCapability(req.method, path)) return res.status(403).json({ message: 'No business permission is defined for this action.' });
      const feature = path.includes('/current/invite') || /\/business\/(users|teams|invitations)(\/|$)/.test(path) ? 'team' : path.match(/\/(contacts|conversations|calls|campaigns|templates|automations|analytics|dashboards|reports|segments|ads)(?:\/|$)/)?.[1];
      if (feature && !req.enabledFeatures.includes(feature)) return res.status(403).json({ message: 'This feature is disabled for your workspace. Contact the platform administrator.' });
      const capability = requestCapability(req.method, path);
      if (capability && !req.permissions.includes(capability)) return res.status(403).json({ message: 'Your workspace role does not permit this action. Contact the platform administrator.' });
      if (capability) req.permissionDecision = true;
    }
    next();
  } catch (error) { next(error); }
}

export function requireRole(...roles) {
  return (req, res, next) => req.user?.role === 'superadmin' || req.permissionDecision === true || roles.includes(req.membership?.role) ? next() : res.status(403).json({ message: 'You do not have permission to perform this action.' });
}
