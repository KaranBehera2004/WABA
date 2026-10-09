export const WORKSPACE_ROLES = ['admin', 'agent', 'supervisor'];
// Keep the retired seat field readable on existing documents; new requests only accept active roles.
export const seatFields = Object.fromEntries([...WORKSPACE_ROLES, 'viewer'].map(role => [role, { type: Number, default: null, min: 0, max: 100000, validate: { validator: value => value === null || Number.isSafeInteger(value), message: 'Seats must be a whole non-negative number, or null for unlimited.' } }]));
export function validateSeatLimits(limits) {
  return limits !== null && typeof limits === 'object' && !Array.isArray(limits) && Object.entries(limits).every(([role, value]) => WORKSPACE_ROLES.includes(role) && (value === null || Number.isSafeInteger(value) && value >= 0 && value <= 100000));
}
export function effectiveSeatLimits(workspace) {
  return Object.fromEntries(WORKSPACE_ROLES.map(role => [role, workspace.seatLimits?.[role] ?? null]));
}
export function seatUsage(workspace) {
  return Object.fromEntries(WORKSPACE_ROLES.map(role => [role, (workspace.members || []).filter(member => member.role === role).length]));
}
// The role count and configured ceiling are both read by Mongo during the
// atomic membership update. Parallel invitations cannot consume the last seat
// twice, and an administrator changing the limit is not a stale client check.
export function membershipCapacityFilter(workspaceId, userId, role, limits, bypass = false, enforceCreationPolicy = false) {
  if (!WORKSPACE_ROLES.includes(role)) throw new Error('Choose Business Admin, Agent or Supervisor for this business.');
  const filter = { _id: workspaceId, deletedAt: null, 'members.user': { $ne: userId } };
  if (bypass) return filter;
  const conditions = [{ $or: [
    { $eq: [{ $ifNull: [`$seatLimits.${role}`, null] }, null] },
    { $lt: [{ $size: { $filter: { input: { $ifNull: ['$members', []] }, as: 'member', cond: { $eq: ['$$member.role', role] } } } }, `$seatLimits.${role}`] },
  ] }];
  if (enforceCreationPolicy) conditions.push({ $in: [role, { $ifNull: ['$rolePolicy.creatableRoles', ['admin', 'agent']] }] });
  if (limits.members !== null) conditions.push({ $lt: [{ $size: '$members' }, limits.members] });
  filter.$expr = { $and: conditions };
  return filter;
}
const records = ['contacts', 'conversations', 'calls', 'campaigns', 'templates', 'automations', 'dashboards', 'reports', 'segments', 'ads'];
export const CAPABILITIES = ['overview.read', 'analytics.read', 'wallet.read', 'team.read', 'team.manage', 'workspace.manage', 'integrations.manage', 'content.read', 'content.manage', 'audit.read', 'conversations.claim', 'conversations.assign', 'contacts.export', ...records.flatMap(resource => ['read', 'create', 'update', 'delete'].map(action => `${resource}.${action}`)), 'conversations.send', 'campaigns.send'];
export const DEFAULT_PERMISSIONS = {
  owner: CAPABILITIES,
  admin: CAPABILITIES,
  supervisor: ['overview.read', 'team.read', 'contacts.read', 'conversations.read', 'calls.read', 'templates.read', 'content.read'],
  agent: ['overview.read', 'contacts.read', 'contacts.update', 'conversations.read', 'conversations.update', 'conversations.send', 'calls.read', 'calls.update', 'templates.read', 'content.read'],
};
export const ROLE_PERMISSION_LIMITS = {
  admin: CAPABILITIES,
  supervisor: DEFAULT_PERMISSIONS.supervisor,
  agent: [...DEFAULT_PERMISSIONS.agent, 'conversations.claim'],
};
// Root-defined ceilings preserve restrictive defaults on existing businesses.
export function rolePermissionLimit(workspace, role) {
  const configured = workspace.rolePolicy?.permissionCeilings?.find(rule => rule.role === role);
  return [...new Set(configured?.permissions || ROLE_PERMISSION_LIMITS[role] || [])].filter(value => CAPABILITIES.includes(value));
}
export function workspaceRolePolicy(workspace) {
  return { creatableRoles: workspace.rolePolicy?.creatableRoles ?? ['admin', 'agent'], permissionCeilings: WORKSPACE_ROLES.map(role => ({ role, permissions: rolePermissionLimit(workspace, role) })) };
}
export function canCreateRole(workspace, role, accountRole) {
  return WORKSPACE_ROLES.includes(role) && (accountRole === 'superadmin' || workspaceRolePolicy(workspace).creatableRoles.includes(role));
}
export function validateRolePolicy(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['creatableRoles','permissionCeilings'].includes(key)) && Array.isArray(value.creatableRoles) && new Set(value.creatableRoles).size === value.creatableRoles.length && value.creatableRoles.every(role => WORKSPACE_ROLES.includes(role)) && validatePermissionRules(value.permissionCeilings);
}
export function permissionsFor(workspace, membership, accountRole) {
  if (accountRole === 'superadmin' || membership?.role === 'owner') return [...CAPABILITIES];
  if (!WORKSPACE_ROLES.includes(membership?.role) || membership.disabled) return [];
  const custom = workspace.permissionRules?.find(rule => rule.role === membership.role);
  const individual = Array.isArray(membership.customPermissions) ? membership.customPermissions : null;
  const permissions = [...(individual ?? custom?.permissions ?? DEFAULT_PERMISSIONS[membership.role] ?? [])];
  if (!individual && !custom && membership.role === 'agent' && membership.canClaim && workspace.settings?.routing?.allowClaim) permissions.push('conversations.claim');
  const ceiling = rolePermissionLimit(workspace, membership.role);
  return [...new Set(permissions)].filter(value => ceiling.includes(value));
}
export function requestCapability(method, path) {
  path = path.toLowerCase().replace(/\/+$/, '');
  if (path.endsWith('/business/role-access')) return method === 'GET' ? 'team.read' : 'team.manage';
  if (/\/contacts\/export$/.test(path)) return 'contacts.export';
  if (/\/conversations\/[^/]+\/(assign|takeover)$/.test(path)) return 'conversations.assign';
  if(path.startsWith('/api/business/')){
    if(/\/business\/(users|teams|invitations)(\/|$)/.test(path))return method==='GET'?'team.read':'team.manage';
    if(/\/business\/(quick-replies|tags)(\/|$)/.test(path))return method==='GET'?'content.read':'content.manage';
    if (/\/business\/numbers(?:\/|$)/.test(path)) return 'integrations.manage';
    if(/\/business\/(settings|sessions)(\/|$)/.test(path))return 'workspace.manage';
    if(/\/business\/(integrations|integration-logs)(\/|$)/.test(path))return 'integrations.manage';
    if(path.endsWith('/dashboard'))return 'overview.read';
    if(path.endsWith('/billing'))return 'wallet.read';
    if(path.endsWith('/audit'))return 'audit.read';
    if(path.endsWith('/alerts'))return 'overview.read';
    if(/\/campaigns\/[^/]+\/(launch|test|retry|control)$/.test(path))return 'campaigns.send';
    if(/\/campaigns\/[^/]+\/preview$/.test(path))return 'campaigns.read';
    if(/\/templates\/(sync|[^/]+\/submit)$/.test(path))return 'templates.update';
    if(/\/automations\/[^/]+\/(publish|toggle|enroll|test)$/.test(path))return 'automations.update';
    if(/\/contacts\/[^/]+\/archive$/.test(path))return 'contacts.delete';
  }
  if (/\/conversations\/[^/]+\/claim$/.test(path)) return 'conversations.claim';
  if (/\/conversations\/[^/]+\/(notes|read|transfer-request|takeover|assign)$/.test(path)) return 'conversations.update';
  if (/\/contacts\/[^/]+\/notes$/.test(path)) return 'contacts.update';
  if (path.endsWith('/current/invite')) return 'team.manage';
  if (path.endsWith('/workspaces/current')) return method === 'GET' ? null : 'workspace.manage';
  if (/\/integrations\/smartping\/(check|status)$/.test(path)) return method === 'GET' ? null : 'integrations.manage';
  if (/\/integrations\/smartping\/templates\/[^/]+\/configure$/.test(path)) return 'integrations.manage';
  if (/\/campaigns\/[^/]+\/send$/.test(path)) return 'campaigns.send';
  if (/\/conversations\/[^/]+\/messages$/.test(path) && method === 'POST') return 'conversations.send';
  if (/\/wallet(?:\/|$)/.test(path)) return 'wallet.read';
  const resource = path.match(/\/(overview|analytics|contacts|conversations|calls|campaigns|templates|automations|dashboards|reports|segments|ads)(?:\/|$)/)?.[1];
  return resource ? `${resource}.${({ GET: 'read', HEAD: 'read', POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' })[method] || 'read'}` : null;
}
export function validatePermissionRules(rules) {
  return Array.isArray(rules) && rules.length <= WORKSPACE_ROLES.length && new Set(rules.map(rule => rule?.role)).size === rules.length && rules.every(rule => WORKSPACE_ROLES.includes(rule?.role) && Array.isArray(rule.permissions) && rule.permissions.every(permission => CAPABILITIES.includes(permission)) && new Set(rule.permissions).size === rule.permissions.length);
}

export const CAPACITY_KEYS = ['contacts', 'conversations', 'calls', 'campaigns', 'templates', 'automations', 'dashboards', 'reports', 'segments', 'ads', 'members'];
export const capacityFields = Object.fromEntries(CAPACITY_KEYS.map(key => [key, { type: Number, min: 0, validate: { validator: value => value == null || Number.isSafeInteger(value), message: 'Capacity must be a whole non-negative number.' } }]));
export function validateCapacities(limits) {
  return limits && typeof limits === 'object' && !Array.isArray(limits) && Object.entries(limits).every(([key, value]) => CAPACITY_KEYS.includes(key) && (value === null || Number.isSafeInteger(value) && value >= 0));
}
