export type WorkspaceRole = 'owner' | 'admin' | 'agent' | 'supervisor';
export const roleLabels: Record<WorkspaceRole, string> = { owner: 'Business admin', admin: 'Business admin', agent: 'Agent', supervisor: 'Supervisor' };
export const pageFeatures: Record<string, string> = { Inbox: 'conversations', Calls: 'calls', Contacts: 'contacts', Campaigns: 'campaigns', 'Scheduled Broadcasts': 'campaigns', Templates: 'templates', 'Meta Ads': 'ads', Automations: 'automations', Analytics: 'analytics', 'Enterprise Analytics': 'dashboards', Reports: 'reports', Team: 'team' };
export const workspacePages = ['Overview', 'Inbox', 'Calls', 'Contacts', 'Campaigns', 'Scheduled Broadcasts', 'Templates', 'Meta Ads', 'Automations', 'Analytics', 'Enterprise Analytics', 'Reports', 'Team', 'Quick Replies', 'Tags', 'Business Settings', 'WhatsApp Numbers', 'Integrations', 'Security', 'Audit Logs', 'Wallet', 'Settings', 'Help & support'];
export type WorkspaceAccess = { role: WorkspaceRole; permissions: string[]; features: string[]; superadmin: boolean; customPermissions?: boolean };
export function can(access: WorkspaceAccess, capability: string): boolean {
  if (access.superadmin) return true;
  if (!['owner','admin','agent','supervisor'].includes(access.role)) return false;

  const resource = capability.split('.')[0];
  const feature = resource === 'integrations' ? null : Object.values(pageFeatures).includes(resource) || resource === 'segments' ? resource : null;
  return access.permissions.includes(capability) && (!feature || access.features.includes(feature));
}
export function canOpenPage(access: WorkspaceAccess, page: string): boolean {
  if (!workspacePages.includes(page) || !access.superadmin && !['owner','admin','agent','supervisor'].includes(access.role)) return false;

  if (page === 'Settings' || page === 'Help & support') return true;
  if (['Quick Replies','Tags'].includes(page)) return can(access,'content.read');
  if (page === 'Audit Logs') return can(access,'audit.read');
  if (['Business Settings','WhatsApp Numbers','Integrations','Security'].includes(page)) return can(access,page === 'Integrations' || page === 'WhatsApp Numbers' ? 'integrations.manage' : 'workspace.manage');
  const capability = page === 'Overview' ? 'overview.read' : page === 'Wallet' ? 'wallet.read' : pageFeatures[page] + '.read';
  return can(access, capability);
}
export function resolveWorkspaceRole(role?: string): WorkspaceRole | null {
  return role === 'owner' || role === 'admin' || role === 'agent' || role === 'supervisor' ? role : null;
}
type MemberIdentity = { user: string | { id?: string; _id?: string }; role: string };
export function resolveMembershipRole(role: string | undefined, members: MemberIdentity[], userId: string, superadmin = false): WorkspaceRole | null {
  if (superadmin) return 'owner';
  const explicit = resolveWorkspaceRole(role);
  if (role !== undefined) return explicit;
  const member = members.find(item => (typeof item.user === 'string' ? item.user : item.user?.id || item.user?._id) === userId);
  return resolveWorkspaceRole(member?.role);
}
