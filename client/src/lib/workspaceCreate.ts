import type { RolePolicy } from '../components/RoleAccessEditor';
export const CAPACITY_KEYS = ['contacts', 'conversations', 'calls', 'campaigns', 'templates', 'automations', 'dashboards', 'reports', 'segments', 'ads', 'members'] as const;
export const SEAT_LIMIT_KEYS = ['admin', 'agent', 'supervisor'] as const;
export const WORKSPACE_STEPS = ['Business', 'Access & plan', 'Capacity', 'Review'] as const;
export type WorkspaceStep = typeof WORKSPACE_STEPS[number];
export type WorkspaceOwnerOption = { _id: string; name?: string; email?: string; isActive?: boolean };
export type WorkspacePlanOption = { _id: string; name?: string; isActive?: boolean; features?: string[]; limits?: Record<string, number | null> };
export type WorkspaceDefaults = { defaultTimezone: string; defaultPlan: string | null; trialDays: number; disabledFeatures: string[]; sendingEnabled: boolean; passwordMinLength?: number };
export type WorkspaceCreateValues = {
  rolePolicy?: RolePolicy;
  name: string; slug: string; businessEmail: string; businessPhone: string;
  ownerMode: 'new' | 'existing'; owner: string; newOwnerName: string; newOwnerEmail: string; newOwnerPassword: string; confirmOwnerPassword: string;
  timezone: string; supportEmail: string; businessDescription: string;
  isActive: boolean; sendingEnabled: boolean; plan: string; expiryMode: 'inherit' | 'none' | 'trial' | 'date';
  trialDays: string; subscriptionEndsAt: string; disabledFeatures: string[]; addonFeatures: string[];
  limits: Record<string, string>; unlimited: string[]; seatLimits: Record<string, string>; adminNotes: string;
};
export type WorkspaceCreateContext = { users: WorkspaceOwnerOption[]; plans: WorkspacePlanOption[]; features: string[]; defaults: WorkspaceDefaults };
export type WorkspaceCreateError = { step: WorkspaceStep; message: string; field?: string };

export const initialWorkspaceCreateValues = (): WorkspaceCreateValues => ({
  name: '', slug: '', businessEmail: '', businessPhone: '', ownerMode: 'new', owner: '', newOwnerName: '', newOwnerEmail: '', newOwnerPassword: '', confirmOwnerPassword: '', timezone: '', supportEmail: '', businessDescription: '', isActive: true, sendingEnabled: true,
  plan: 'inherit', expiryMode: 'inherit', trialDays: '', subscriptionEndsAt: '', disabledFeatures: [], addonFeatures: [], limits: {}, unlimited: [], seatLimits: {}, adminNotes: '',
});

export const workspaceSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');

export function effectiveWorkspaceFeatures(values: WorkspaceCreateValues, context: WorkspaceCreateContext) {
  const plan = selectedWorkspacePlan(values, context);
  return context.features.filter(feature => !values.disabledFeatures.includes(feature) && !context.defaults.disabledFeatures.includes(feature) && (!plan || !plan.features || plan.features.includes(feature) || values.addonFeatures.includes(feature)));
}

export function isValidTimezone(value: string) {
  if (!value || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}

export function readWorkspaceDefaults(value: unknown): WorkspaceDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workspace defaults are unavailable. Retry loading before creating a workspace.');
  const settings = value as Record<string, unknown>;
  if (typeof settings.defaultTimezone !== 'string' || !isValidTimezone(settings.defaultTimezone) || !Number.isInteger(settings.trialDays) || Number(settings.trialDays) < 0 || Number(settings.trialDays) > 365) throw new Error('Platform workspace defaults are invalid. Review Platform settings, then retry.');
  const defaultPlan = settings.defaultPlan && typeof settings.defaultPlan === 'object' ? (settings.defaultPlan as { _id?: unknown })._id : settings.defaultPlan;
  if (defaultPlan != null && (typeof defaultPlan !== 'string' || !/^[a-f\d]{24}$/i.test(defaultPlan))) throw new Error('The default workspace plan is invalid. Review Platform settings, then retry.');
  const passwordMinLength = typeof settings.passwordMinLength === 'number' && Number.isInteger(settings.passwordMinLength) && settings.passwordMinLength >= 8 && settings.passwordMinLength <= 64 ? Math.max(10, settings.passwordMinLength) : 10;
  return { defaultTimezone: settings.defaultTimezone, defaultPlan: defaultPlan as string | null || null, trialDays: Number(settings.trialDays), disabledFeatures: Array.isArray(settings.disabledFeatures) ? settings.disabledFeatures.filter((feature): feature is string => typeof feature === 'string') : [], sendingEnabled: settings.sendingEnabled !== false, passwordMinLength };
}

export function selectedWorkspacePlan(values: WorkspaceCreateValues, context: WorkspaceCreateContext) {
  const id = values.plan === 'inherit' ? context.defaults.defaultPlan : values.plan === 'none' ? null : values.plan;
  return id ? context.plans.find(plan => plan._id === id) : undefined;
}

function validLocalDate(value: string) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getFullYear() === Number(parts[1]) && date.getMonth() + 1 === Number(parts[2]) && date.getDate() === Number(parts[3]) && date.getHours() === Number(parts[4]) && date.getMinutes() === Number(parts[5]) && date.getSeconds() === Number(parts[6] || 0);
}

export function validateWorkspaceCreate(values: WorkspaceCreateValues, context: WorkspaceCreateContext, onlyStep?: WorkspaceStep): WorkspaceCreateError | null {
  const check = (step: WorkspaceStep) => !onlyStep || onlyStep === 'Review' || onlyStep === step;
  if (check('Business')) {
    if (!values.name.trim() || values.name.trim().length > 120) return { step: 'Business', field: 'name', message: 'Enter a workspace name of 1–120 characters.' };
    if (values.slug.trim() && !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(values.slug.trim())) return { step: 'Business', field: 'slug', message: 'Use a business identifier of 3–60 lowercase letters, numbers and internal hyphens.' };
    if (values.businessEmail.trim().length > 200 || values.businessEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.businessEmail.trim())) return { step: 'Business', field: 'businessEmail', message: 'Enter a valid business email within 200 characters, or leave it blank.' };
    if (values.businessPhone.trim().length > 32) return { step: 'Business', field: 'businessPhone', message: 'Keep the business phone within 32 characters.' };
    if (values.ownerMode === 'existing') {
      if (!context.users.some(user => user._id === values.owner && user.isActive === true)) return { step: 'Business', field: 'owner', message: 'Choose an active registered owner, or choose Create owner login.' };
    } else if (values.ownerMode === 'new') {
      if (!values.newOwnerName.trim() || values.newOwnerName.trim().length > 80) return { step: 'Business', field: 'newOwnerName', message: 'Enter an owner name of 1–80 characters.' };
      if (!values.newOwnerEmail.trim() || values.newOwnerEmail.trim().length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.newOwnerEmail.trim())) return { step: 'Business', field: 'newOwnerEmail', message: 'Enter the owner’s valid login email within 200 characters.' };
      const minimum = Math.max(10, context.defaults.passwordMinLength || 10);
      if (values.newOwnerPassword.length < minimum || !/[a-z]/.test(values.newOwnerPassword) || !/[A-Z]/.test(values.newOwnerPassword) || !/[0-9]/.test(values.newOwnerPassword) || new TextEncoder().encode(values.newOwnerPassword).length > 72) return { step: 'Business', field: 'newOwnerPassword', message: `Use at least ${minimum} characters with an uppercase letter, a lowercase letter and a number; maximum 72 UTF-8 bytes.` };
      if (values.newOwnerPassword !== values.confirmOwnerPassword) return { step: 'Business', field: 'confirmOwnerPassword', message: 'The owner passwords do not match.' };
    } else return { step: 'Business', field: 'ownerMode', message: 'Choose how the workspace owner account should be set up.' };
    if (!isValidTimezone(values.timezone.trim())) return { step: 'Business', field: 'timezone', message: 'Enter a valid timezone, such as Asia/Kolkata, UTC or America/New_York.' };
    if (values.supportEmail.trim().length > 200 || values.supportEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.supportEmail.trim())) return { step: 'Business', field: 'supportEmail', message: 'Enter a valid support email within 200 characters, or leave it blank to use the owner’s email.' };
    if (values.businessDescription.trim().length > 3000) return { step: 'Business', field: 'businessDescription', message: 'Keep the business description within 3,000 characters.' };
  }
  if (check('Access & plan')) {
    const planId = values.plan === 'inherit' ? context.defaults.defaultPlan : values.plan === 'none' ? null : values.plan;
    if (planId && !context.plans.some(plan => plan._id === planId && plan.isActive === true)) return { step: 'Access & plan', field: 'plan', message: 'Choose an active plan or No plan restriction. The selected/default plan is unavailable.' };
    if (!['inherit', 'none', 'trial', 'date'].includes(values.expiryMode)) return { step: 'Access & plan', field: 'expiryMode', message: 'Choose how subscription expiry should be configured.' };
    if (values.expiryMode === 'trial' && (!/^\d+$/.test(values.trialDays) || !Number.isInteger(Number(values.trialDays)) || Number(values.trialDays) < 0 || Number(values.trialDays) > 365)) return { step: 'Access & plan', field: 'trialDays', message: 'Trial length must be a whole number from 0 to 365 days. Use 0 for no expiry.' };
    if (values.expiryMode === 'date' && !validLocalDate(values.subscriptionEndsAt)) return { step: 'Access & plan', field: 'subscriptionEndsAt', message: 'Choose a valid subscription expiry date and time.' };
    if (values.disabledFeatures.some(feature => !context.features.includes(feature)) || new Set(values.disabledFeatures).size !== values.disabledFeatures.length) return { step: 'Access & plan', message: 'Review the workspace feature selection.' };
    if (values.addonFeatures.some(feature => !context.features.includes(feature)) || new Set(values.addonFeatures).size !== values.addonFeatures.length) return { step: 'Access & plan', message: 'Review the workspace add-on selection.' };
  }
  if (check('Capacity')) {
    if (values.unlimited.some(key => !CAPACITY_KEYS.includes(key as typeof CAPACITY_KEYS[number])) || Object.keys(values.limits).some(key => !CAPACITY_KEYS.includes(key as typeof CAPACITY_KEYS[number]))) return { step: 'Capacity', message: 'Review the workspace capacity selection.' };
    for (const key of CAPACITY_KEYS) {
      const value = values.limits[key]?.trim() || '';
      if (value && !values.unlimited.includes(key) && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) return { step: 'Capacity', field: `limit-${key}`, message: `${key[0].toUpperCase() + key.slice(1)} capacity must be a whole non-negative number, blank to inherit, or Unlimited.` };
    }
    if (Object.keys(values.seatLimits).some(key => !SEAT_LIMIT_KEYS.includes(key as typeof SEAT_LIMIT_KEYS[number]))) return { step: 'Capacity', message: 'Review the role seat limits.' };
    for (const key of SEAT_LIMIT_KEYS) {
      const value = values.seatLimits[key]?.trim() || '';
      if (value && (!/^\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) > 100000)) return { step: 'Capacity', field: `seat-${key}`, message: `${key[0].toUpperCase() + key.slice(1)} seats must be a whole number from 0 to 100,000, or blank for unlimited.` };
    }
    if (values.adminNotes.trim().length > 3000) return { step: 'Capacity', field: 'adminNotes', message: 'Keep private administrator notes within 3,000 characters.' };
  }
  return null;
}

export function createWorkspacePayload(values: WorkspaceCreateValues, context: WorkspaceCreateContext): Record<string, unknown> {
  const error = validateWorkspaceCreate(values, context);
  if (error) throw new Error(error.message);
  const owner = values.ownerMode === 'existing' ? context.users.find(user => user._id === values.owner) : undefined;
  const ownerEmail = values.ownerMode === 'new' ? values.newOwnerEmail.trim().toLowerCase() : owner?.email || '';
  const limits: Record<string, number | null> = {};
  for (const key of CAPACITY_KEYS) {
    if (values.unlimited.includes(key)) limits[key] = null;
    else if (values.limits[key]?.trim()) limits[key] = Number(values.limits[key]);
  }
  const payload: Record<string, unknown> = {
    name: values.name.trim(), email: values.businessEmail.trim().toLowerCase(), phone: values.businessPhone.trim(), isActive: values.isActive, sendingEnabled: values.sendingEnabled,
    settings: { timezone: values.timezone.trim(), supportEmail: values.supportEmail.trim() || ownerEmail, businessDescription: values.businessDescription.trim() },
    disabledFeatures: [...values.disabledFeatures], addonFeatures: [...values.addonFeatures], limits,
    seatLimits: Object.fromEntries(SEAT_LIMIT_KEYS.map(key => [key, values.seatLimits[key]?.trim() ? Number(values.seatLimits[key]) : null])), adminNotes: values.adminNotes.trim(),
  };
  if (values.rolePolicy) payload.rolePolicy = values.rolePolicy;
  if (values.slug.trim()) payload.slug = values.slug.trim();
  if (values.ownerMode === 'existing') payload.owner = values.owner;
  else payload.newOwner = { name: values.newOwnerName.trim(), email: ownerEmail, password: values.newOwnerPassword };
  if (values.plan !== 'inherit') payload.plan = values.plan === 'none' ? null : values.plan;
  if (values.expiryMode === 'none') payload.subscriptionEndsAt = null;
  if (values.expiryMode === 'trial') payload.trialDays = Number(values.trialDays);
  if (values.expiryMode === 'date') payload.subscriptionEndsAt = new Date(values.subscriptionEndsAt).toISOString();
  return payload;
}
