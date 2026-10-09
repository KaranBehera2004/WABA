export type WalletCharge = { entryId: string; workspace: string; activity: string; chargedPaise: number; balanceAfterPaise: number; currency: 'INR'; mode: 'test' };
export type WalletDemoResult = { activity: string; chargedPaise: number; balanceAfterPaise: number; duplicate: boolean; currency: 'INR'; mode: 'test'; message?: string; reason?: string; walletCharges?: WalletCharge[] };
const activities = ['contacts', 'conversations', 'messages', 'calls', 'campaigns', 'templates', 'automations', 'dashboards', 'reports', 'segments', 'ads'];

// Notifications use committed server ledger receipts, not browser-estimated prices.
export function readWalletCharges(value: unknown, workspace?: string): WalletCharge[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((entry): entry is WalletCharge => {
    if (!entry || typeof entry !== 'object' || entry.mode !== 'test' || entry.currency !== 'INR' || typeof entry.entryId !== 'string' || typeof entry.workspace !== 'string' || typeof entry.activity !== 'string' || !/^[a-f0-9]{24}$/i.test(entry.entryId) || !/^[a-f0-9]{24}$/i.test(entry.workspace) || !activities.includes(entry.activity) || !Number.isSafeInteger(entry.chargedPaise) || entry.chargedPaise <= 0 || !Number.isSafeInteger(entry.balanceAfterPaise) || entry.balanceAfterPaise < 0 || (workspace && workspace.toLowerCase() !== entry.workspace.toLowerCase()) || seen.has(entry.entryId.toLowerCase())) return false;
    seen.add(entry.entryId.toLowerCase()); return true;
  });
}

export const walletActivityLabels: Record<string, string> = { contacts: 'Contact', conversations: 'New chat', messages: 'Chat message', calls: 'Call', campaigns: 'Campaign', templates: 'Template', automations: 'Bot', dashboards: 'Dashboard', reports: 'Report', segments: 'Segment', ads: 'Ad' };
