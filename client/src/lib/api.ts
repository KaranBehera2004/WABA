import { readWalletCharges, type WalletDemoResult } from './walletEvents';
export type { WalletCharge, WalletDemoResult } from './walletEvents';
const API_URL = import.meta.env.VITE_API_URL || '/api';

export type User = { id: string; _id?: string; name: string; email: string; role: string; company?: string; workspaceId?: string };
export type PublicPlatformInfo = {
  platformName: string; supportEmail: string; supportPhone: string; supportUrl: string; termsUrl: string; privacyUrl: string;
  loginTitle: string; loginDescription: string; footerText: string; registrationEnabled: boolean; memberAccessEnabled: boolean;
  maintenanceEnabled: boolean; maintenanceMessage: string; passwordMinLength: number; passwordRequireUppercase: boolean; passwordRequireNumber: boolean; trialDays: number; signupRestricted: boolean;
};
export const defaultPublicPlatform: PublicPlatformInfo = { platformName: 'WABADesk', supportEmail: '', supportPhone: '', supportUrl: '', termsUrl: '', privacyUrl: '', loginTitle: 'Welcome back', loginDescription: 'Enter your credentials to access your workspace.', footerText: '', registrationEnabled: true, memberAccessEnabled: true, maintenanceEnabled: false, maintenanceMessage: '', passwordMinLength: 8, passwordRequireUppercase: false, passwordRequireNumber: false, trialDays: 0, signupRestricted: false };
export type Resource = 'contacts' | 'calls' | 'campaigns' | 'conversations' | 'templates' | 'automations' | 'dashboards' | 'reports' | 'segments' | 'ads';
export type SmartpingTemplate = { templateId: string; templateUId?: string; parameterValues?: Record<string,string>; headerParameterValues?: Record<string,string>; media?: Record<string,unknown>; buttons?: Record<string,unknown>[]; cards?: Record<string,unknown>[] };
export type SmartpingStatus = { provider: string; configured: boolean; missing: string[]; from?: string; journeyId?: string; workspaceId?: string; deliveryTracking: boolean };
export type WalletEntry = { _id: string; createdAt: string; kind: string; activity?: string; recordId?: string; deltaPaise: number; balanceAfterPaise: number; unitPricePaise?: number; status: string; reason: string; actor?: { name: string } };
export type WalletData = { wallet: { workspace: string; balancePaise: number; mode: 'test'; currency: 'INR' }; settings: { deductionsEnabled: boolean; pricingSource?: 'default' | 'custom'; prices: Record<string, number> }; units: Record<string, string>; entries?: WalletEntry[]; nextCursor?: string | null };
export type Workspace = { _id: string; name: string; slug: string; settings?: { timezone?: string; supportEmail?: string; businessDescription?: string }; whatsapp?: { connected?: boolean; phoneNumberId?: string; businessAccountId?: string }; members: { user: User; role: string; joinedAt: string }[] };

function expireSessionIfNeeded(status: number, data: { code?: string }, token: string | null) {
  if (status === 401 && token && localStorage.getItem('waba_token') === token && ['AUTH_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'SESSION_REVOKED', 'SESSION_EXPIRED'].includes(data.code || '')) {
    localStorage.removeItem('waba_token'); window.dispatchEvent(new Event('waba:session-expired'));
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('waba_token');
  const workspace = new URL(window.location.href).searchParams.get('workspace');
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(workspace && /^[a-f0-9]{24}$/i.test(workspace) ? { 'X-Workspace-Id': workspace } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  expireSessionIfNeeded(response.status, data, token);
  if (token && localStorage.getItem('waba_token') === token && new URL(window.location.href).searchParams.get('workspace') === workspace && !['GET', 'HEAD', 'OPTIONS'].includes(options.method || 'GET')) {
    window.dispatchEvent(new Event('waba:wallet-changed'));
    const charges = response.ok ? readWalletCharges(data.walletCharges, workspace && /^[a-f0-9]{24}$/i.test(workspace) ? workspace : undefined) : [];
    if (charges.length) window.dispatchEvent(new CustomEvent('waba:wallet-charged', { detail: { charges } }));
  }
  if (!response.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
  return data;
}

async function downloadInvoice(id: string, signal?: AbortSignal): Promise<{ blob: Blob; fileName: string }> {
  const token = localStorage.getItem('waba_token');
  const workspace = new URL(window.location.href).searchParams.get('workspace');
  const response = await fetch(`${API_URL}/superadmin/invoices/${encodeURIComponent(id)}/download`, {
    signal,
    headers: {
      Accept: 'application/pdf',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(workspace && /^[a-f0-9]{24}$/i.test(workspace) ? { 'X-Workspace-Id': workspace } : {}),
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    expireSessionIfNeeded(response.status, data, token);
    throw new Error(data.message || 'Unable to download the invoice. Please try again.');
  }
  if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf') throw new Error('The server did not return an invoice PDF. Please try again.');
  const disposition = response.headers.get('Content-Disposition') || '';
  let suggestedName = disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1]?.trim() || '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encodedName) { try { suggestedName = decodeURIComponent(encodedName); } catch { /* Use the plain filename if the encoded header is invalid. */ } }
  const safeName = suggestedName.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').slice(0, 180);
  const fileName = /\.pdf$/i.test(safeName) ? safeName : `invoice-${id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'download'}.pdf`;
  const blob = await response.blob();
  if (!blob.size) throw new Error('The invoice PDF is empty. Please try again.');
  if (localStorage.getItem('waba_token') !== token) throw new Error('Your session changed. Please sign in and download the invoice again.');
  return { blob, fileName };
}

async function downloadWalletHistory(signal?: AbortSignal): Promise<{ blob: Blob; fileName: string }> {
  const token = localStorage.getItem('waba_token');
  const workspace = new URL(window.location.href).searchParams.get('workspace');
  const response = await fetch(`${API_URL}/wallet/export`, {
    signal,
    headers: {
      Accept: 'text/csv',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(workspace && /^[a-f0-9]{24}$/i.test(workspace) ? { 'X-Workspace-Id': workspace } : {}),
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    expireSessionIfNeeded(response.status, data, token);
    throw new Error(data.message || 'Unable to export transaction history. Please try again.');
  }
  if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/csv') throw new Error('The server did not return a transaction CSV. Please try again.');
  const disposition = response.headers.get('Content-Disposition') || '';
  let suggestedName = disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1]?.trim() || '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encodedName) { try { suggestedName = decodeURIComponent(encodedName); } catch { /* Retain the plain filename. */ } }
  const safeName = suggestedName.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').slice(0, 180);
  const fileName = /\.csv$/i.test(safeName) ? safeName : `waba-wallet-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  const blob = await response.blob();
  if (!blob.size) throw new Error('The transaction CSV is empty. Please try again.');
  if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
  if (localStorage.getItem('waba_token') !== token || new URL(window.location.href).searchParams.get('workspace') !== workspace) throw new Error('Your session or workspace changed. Please export transaction history again.');
  return { blob, fileName };
}

export const api = {
  conversations: <T>(filters: Record<string,string> = {}) => request<{items:T[];total:number;canClaim:boolean}>('/conversations?' + new URLSearchParams(filters)),
  conversationAction: <T>(id: string, action: string, body: Record<string,unknown> = {}) => request<T>(`/conversations/${encodeURIComponent(id)}/${action}`, {method:'POST',body:JSON.stringify(body)}),
  conversationActivity: <T>(id: string) => request<{items:T[]}>(`/conversations/${encodeURIComponent(id)}/activity`),
  platformInfo: () => request<PublicPlatformInfo>('/auth/platform'),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (payload: { name: string; company: string; email: string; password: string }) =>
    request<{ token: string; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  me: () => request<{ user: User }>('/auth/me'),
  list: <T>(resource: Resource) => request<{ items: T[] }>(`/${resource}`),
  create: <T>(resource: Resource, payload: Record<string, unknown>) => request<{ item: T }>(`/${resource}`, { method: 'POST', body: JSON.stringify(payload) }),
  update: <T>(resource: Resource, id: string, payload: Record<string, unknown>) => request<{ item: T }>(`/${resource}/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  remove: (resource: Exclude<Resource, 'conversations'>, id: string) => request<void>(`/${resource}/${id}`, { method: 'DELETE', body: JSON.stringify({confirm:true}) }),
  overview: <T>(days = 7) => request<T>(`/overview?days=${days}`),
  downloadReport: (id: string) => request<{ fileName: string; content: string }>(`/reports/${id}/download`),
  updateProfile: (payload: { name?: string; company?: string }) => request<{ user: User }>('/auth/me', { method: 'PATCH', body: JSON.stringify(payload) }),
  analytics: <T>() => request<T>('/analytics'),
  wallet: (before = '') => request<WalletData>(`/wallet${before ? '?before=' + encodeURIComponent(before) : ''}`),
  walletSummary: () => request<WalletData>('/wallet/summary'),
  downloadWalletHistory,
  demoWalletActivity: (activity: string, idempotencyKey: string) => request<WalletDemoResult>('/wallet/demo-activity', { method: 'POST', body: JSON.stringify({ activity, idempotencyKey }) }),
  currentWorkspace: () => request<{ workspace: Workspace; membershipRole?: string; customPermissions?: boolean; enabledFeatures?: string[]; permissions?: string[] }>('/workspaces/current'),
  announcements: () => request<{ items: { _id: string; title: string; message: string; level: string }[] }>('/workspaces/current/announcements'),
  updateWorkspace: (payload: Record<string, unknown>) => request<{ workspace: Workspace }>('/workspaces/current', { method: 'PATCH', body: JSON.stringify(payload) }),
  inviteMember: (email: string, role: string) => request<{ message: string }>('/workspaces/current/invite', { method: 'POST', body: JSON.stringify({ email, role }) }),
  messages: <T>(conversationId: string) => request<{ items: T[] }>(`/conversations/${conversationId}/messages`),
  smartpingStatus: () => request<SmartpingStatus>('/integrations/smartping/status'),
  checkSmartpingAuthentication: () => request<{ authenticated: boolean; message: string }>('/integrations/smartping/check', { method: 'POST' }),
  configureSmartpingTemplate: (id: string, template: SmartpingTemplate) => request<{ item: unknown }>(`/integrations/smartping/templates/${id}/configure`, { method: 'POST', body: JSON.stringify({ template }) }),
  sendTemplate: <T>(conversationId: string, template: SmartpingTemplate, idempotencyKey: string) => request<{ item: T; duplicate: boolean }>(`/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ type: 'template', template, idempotencyKey }) }),
  sendCampaign: (id: string, template: SmartpingTemplate, contactIds: string[], idempotencyKey: string) => request<{ accepted: number; total: number; message: string }>(`/integrations/smartping/campaigns/${id}/send`, { method: 'POST', body: JSON.stringify({ template, contactIds, idempotencyKey }) }),
};

export const businessApi = {
  put: <T>(path: string, body: Record<string,unknown>) => request<T>('/business' + path, {method:'PUT',body:JSON.stringify(body)}),
  get: <T>(path: string) => request<T>('/business' + path),
  post: <T>(path: string, body: Record<string,unknown> = {}) => request<T>('/business' + path, {method:'POST',body:JSON.stringify(body)}),
  patch: <T>(path: string, body: Record<string,unknown>) => request<T>('/business' + path, {method:'PATCH',body:JSON.stringify(body)}),
  remove: <T>(path: string) => request<T>('/business' + path, {method:'DELETE',body:JSON.stringify({confirm:true})}),
};

export const superadminApi = {
  downloadInvoice,
  get: <T>(path: string) => request<T>(`/superadmin${path}`),
  post: <T>(path: string, body: Record<string, unknown>) => request<T>(`/superadmin${path}`, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: Record<string, unknown>) => request<T>(`/superadmin${path}`, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: Record<string, unknown>) => request<T>(`/superadmin${path}`, { method: 'PUT', body: JSON.stringify(body) }),
  remove: (path: string) => request<{ message: string }>(`/superadmin${path}`, { method: 'DELETE' }),
};
