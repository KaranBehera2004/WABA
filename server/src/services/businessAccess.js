import { canCreateRole, permissionsFor, rolePermissionLimit, validatePermissionRules } from './accessControl.js';
import { SmartpingError } from './smartping.js';
export function assertActorPermission(workspace, actor, accountRole, capability) {
  if (accountRole !== 'superadmin' && (!actor || actor.disabled || !permissionsFor(workspace, actor, accountRole).includes(capability))) throw new SmartpingError('This business permission is unavailable or was revoked.', 403);
}
export function assertCreationRole(workspace, role, accountRole) {
  if (!canCreateRole(workspace, role, accountRole)) throw new SmartpingError('Super Admin has not allowed this business to create the selected role.', 403);
}
export function validateBusinessRules(workspace, rules) {
  return validatePermissionRules(rules) && rules.every(rule => rule.permissions.every(permission => rolePermissionLimit(workspace, rule.role).includes(permission)));
}
export function visibleMembers(req) {
  if (req.user.role === 'superadmin' || ['owner','admin'].includes(req.membership.role) || req.permissions.includes('team.manage')) return req.workspace.members;
  return req.workspace.members.filter(member => String(member.user) === String(req.user._id) || !member.disabled && member.teams?.some(team => req.membership.teams?.some(id => String(id) === String(team))));
}
