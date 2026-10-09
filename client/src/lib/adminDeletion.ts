export const DELETION_RESOURCES = ['workspaces', 'users'] as const;
export const DELETION_SCOPES = ['selected', 'all'] as const;
export type DeletionResource = typeof DELETION_RESOURCES[number];
export type DeletionScope = typeof DELETION_SCOPES[number];
export type DeletionTarget = { id: string; name: string; email?: string };
export type ProtectedDeletionTarget = DeletionTarget & { reason: string };
export type DeletionPreview = { resource: DeletionResource; scope: DeletionScope; token: string; confirmation: string; targets: DeletionTarget[]; protected: ProtectedDeletionTarget[]; matchedCount: number };
export type DeletionResult = { resource: DeletionResource; deletedCount: number; protectedCount: number; protected: ProtectedDeletionTarget[]; alreadyDeletedCount?: number };

export const deletionConfirmation = (resource: DeletionResource) => resource === 'workspaces' ? 'DELETE WORKSPACES' : 'DELETE USERS';
export const deletionLabel = (resource: DeletionResource) => resource === 'workspaces' ? 'businesses / workspaces' : 'user accounts';
const objectId = /^[a-f\d]{24}$/i;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1000;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function buildDeletionPreviewPayload(resource: DeletionResource, scope: DeletionScope, ids?: string[]): Record<string, unknown> {
  if (!DELETION_RESOURCES.includes(resource) || !DELETION_SCOPES.includes(scope)) throw new Error('Choose a supported deletion resource and scope.');
  if (scope === 'all') {
    if (ids?.length) throw new Error('Delete all must not include a selected-ID list.');
    return { resource, scope };
  }
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200 || ids.some(id => typeof id !== 'string' || !objectId.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) throw new Error('Select 1–200 distinct valid records before previewing deletion.');
  return { resource, scope, ids: ids.map(id => id.toLowerCase()) };
}

function targets(value: unknown, protectedRecords: boolean): (DeletionTarget | ProtectedDeletionTarget)[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('The server returned an invalid deletion target list.');
  const seen = new Set<string>();
  return value.map(item => {
    if (!object(item) || typeof item.id !== 'string' || !objectId.test(item.id) || typeof item.name !== 'string' || item.name.length > 500 || item.email !== undefined && typeof item.email !== 'string' || protectedRecords && (typeof item.reason !== 'string' || !item.reason.trim())) throw new Error('The server returned invalid deletion target details.');
    const id = item.id.toLowerCase();
    if (seen.has(id)) throw new Error('The deletion preview contains duplicate records.');
    seen.add(id);
    const result = { id, name: item.name, ...(typeof item.email === 'string' ? { email: item.email } : {}) };
    return protectedRecords ? { ...result, reason: item.reason as string } : result;
  });
}

export function readDeletionPreview(value: unknown, resource: DeletionResource, scope: DeletionScope): DeletionPreview {
  if (!object(value) || value.resource !== resource || value.scope !== scope || typeof value.token !== 'string' || !value.token.trim() || value.token.length > 65536 || value.confirmation !== deletionConfirmation(resource) || !count(value.matchedCount)) throw new Error('The deletion preview is invalid. Refresh the preview before continuing.');
  const eligible = targets(value.targets, false) as DeletionTarget[];
  const protectedRecords = targets(value.protected, true) as ProtectedDeletionTarget[];
  if (eligible.length + protectedRecords.length !== value.matchedCount || new Set([...eligible, ...protectedRecords].map(item => item.id)).size !== eligible.length + protectedRecords.length) throw new Error('The deletion preview counts or protected records do not match. Refresh before continuing.');
  return { resource, scope, token: value.token, confirmation: deletionConfirmation(resource), targets: eligible, protected: protectedRecords, matchedCount: value.matchedCount };
}

export function validateDeletionConfirmation(preview: DeletionPreview | null, confirmation: string): string {
  if (!preview) return 'Load a deletion preview before confirming.';
  if (!preview.targets.length) return 'There are no eligible records to delete.';
  if (confirmation !== preview.confirmation) return `Type ${preview.confirmation} exactly to confirm.`;
  return '';
}

export function createDeletionExecutePayload(preview: DeletionPreview | null, confirmation: string): Record<string, string> {
  const problem = validateDeletionConfirmation(preview, confirmation);
  if (problem) throw new Error(problem);
  return { token: preview!.token, confirmation };
}

export function readDeletionResult(value: unknown, resource: DeletionResource): DeletionResult {
  if (!object(value) || value.resource !== resource || !count(value.deletedCount) || !count(value.protectedCount) || value.alreadyDeletedCount !== undefined && !count(value.alreadyDeletedCount)) throw new Error('The deletion result could not be verified. Refresh the preview to check which records remain.');
  const protectedRecords = targets(value.protected, true) as ProtectedDeletionTarget[];
  if (value.protectedCount !== protectedRecords.length) throw new Error('The deletion result protection count could not be verified.');
  return { resource, deletedCount: value.deletedCount, protectedCount: value.protectedCount, protected: protectedRecords, ...(typeof value.alreadyDeletedCount === 'number' ? { alreadyDeletedCount: value.alreadyDeletedCount } : {}) };
}

export function deletionResultSummary(result: DeletionResult): string {
  return `${result.deletedCount} ${deletionLabel(result.resource)} deleted from active access${result.protectedCount ? `; ${result.protectedCount} protected` : ''}${result.alreadyDeletedCount ? `; ${result.alreadyDeletedCount} already deleted` : ''}. Business records and financial history are retained.`;
}
