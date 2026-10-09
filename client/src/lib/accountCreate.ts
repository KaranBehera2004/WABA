export const ACCOUNT_MODES = ['existing', 'new', 'platform'] as const;
export const ACCOUNT_WORKSPACE_ROLES = ['admin', 'agent', 'supervisor'] as const;
export type AccountMode = typeof ACCOUNT_MODES[number];
export type AccountWorkspaceRole = typeof ACCOUNT_WORKSPACE_ROLES[number];
export type AccountWorkspaceOption = { _id: string; name: string; isActive?: boolean; subscriptionEndsAt?: string | null };
export type AccountPolicy = { passwordMinLength: number; passwordRequireUppercase: boolean; passwordRequireNumber: boolean };
export type AccountCreateValues = {
  mode: AccountMode; name: string; email: string; password: string; confirmPassword: string;
  workspaceId: string; workspaceRole: AccountWorkspaceRole; acknowledgePlatformAccess: boolean;
};
export type AccountCreateContext = { workspaces: AccountWorkspaceOption[]; policy: AccountPolicy };
export type AccountCreateError = { field: keyof AccountCreateValues; message: string };
export type NewBusinessOwnerSeed = { name: string; email: string; password: string; confirmPassword: string };

export const initialAccountCreateValues = (): AccountCreateValues => ({
  mode: 'existing', name: '', email: '', password: '', confirmPassword: '', workspaceId: '', workspaceRole: 'agent', acknowledgePlatformAccess: false,
});

export function readAccountPolicy(value: unknown): AccountPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Account security policy is unavailable. Retry before creating an account.');
  const settings = value as Record<string, unknown>;
  if (typeof settings.passwordMinLength !== 'number' || !Number.isInteger(settings.passwordMinLength) || settings.passwordMinLength < 8 || settings.passwordMinLength > 64 || ['passwordRequireUppercase', 'passwordRequireNumber'].some(key => settings[key] !== undefined && typeof settings[key] !== 'boolean')) throw new Error('Account security policy is invalid. Review Platform settings and retry.');
  return { passwordMinLength: Math.max(10, settings.passwordMinLength), passwordRequireUppercase: settings.passwordRequireUppercase === true, passwordRequireNumber: settings.passwordRequireNumber === true };
}

export function validateAccountCreate(values: AccountCreateValues, context: AccountCreateContext): AccountCreateError | null {
  if (!ACCOUNT_MODES.includes(values.mode)) return { field: 'mode', message: 'Choose whether this account joins an existing business, creates a new business, or administers the platform.' };
  if (!values.name.trim() || values.name.trim().length > 80) return { field: 'name', message: 'Enter an account name of 1–80 characters.' };
  if (!values.email.trim() || values.email.trim().length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) return { field: 'email', message: 'Enter a valid login email within 200 characters.' };
  const minimum = Math.max(10, context.policy.passwordMinLength);
  if (values.password.length < minimum) return { field: 'password', message: `Use at least ${minimum} password characters.` };
  if (new TextEncoder().encode(values.password).length > 72) return { field: 'password', message: 'The password must not exceed 72 UTF-8 bytes.' };
  if ((context.policy.passwordRequireUppercase || values.mode === 'new') && !/[A-Z]/.test(values.password)) return { field: 'password', message: 'Include an uppercase letter in the password.' };
  if (values.mode === 'new' && !/[a-z]/.test(values.password)) return { field: 'password', message: 'Include a lowercase letter in the owner password.' };
  if ((context.policy.passwordRequireNumber || values.mode === 'new') && !/[0-9]/.test(values.password)) return { field: 'password', message: 'Include a number in the password.' };
  if (values.password !== values.confirmPassword) return { field: 'confirmPassword', message: 'The passwords do not match.' };
  if (values.mode === 'existing') {
    if (!/^[a-f\d]{24}$/i.test(values.workspaceId) || !context.workspaces.some(workspace => workspace._id === values.workspaceId)) return { field: 'workspaceId', message: 'Choose a stored business / workspace. A typed company name does not give business access.' };
    if (!ACCOUNT_WORKSPACE_ROLES.includes(values.workspaceRole)) return { field: 'workspaceRole', message: 'Choose Admin, Agent or Supervisor. New owners are created with a new business, not by replacing an existing owner.' };
  }
  if (values.mode === 'platform' && values.acknowledgePlatformAccess !== true) return { field: 'acknowledgePlatformAccess', message: 'Confirm that this person should receive full superadmin access to all businesses and platform controls.' };
  return null;
}

export function createAccountPayload(values: AccountCreateValues, context: AccountCreateContext): Record<string, unknown> {
  const error = validateAccountCreate(values, context);
  if (error) throw new Error(error.message);
  if (values.mode === 'new') throw new Error('Complete the new-business setup wizard before creating this owner account.');
  const payload: Record<string, unknown> = { name: values.name.trim(), email: values.email.trim().toLowerCase(), password: values.password };
  if (values.mode === 'platform') payload.role = 'superadmin';
  else { payload.role = values.workspaceRole; payload.workspaceId = values.workspaceId; payload.workspaceRole = values.workspaceRole; }
  return payload;
}

export function newBusinessOwnerSeed(values: AccountCreateValues, context: AccountCreateContext): NewBusinessOwnerSeed {
  const error = validateAccountCreate(values, context);
  if (error) throw new Error(error.message);
  if (values.mode !== 'new') throw new Error('Choose New business to continue business setup.');
  return { name: values.name.trim(), email: values.email.trim().toLowerCase(), password: values.password, confirmPassword: values.confirmPassword };
}

export function accountWorkspaceWarning(workspace: AccountWorkspaceOption | undefined, now = Date.now()): string {
  if (!workspace) return '';
  if (workspace.isActive === false) return 'This business is suspended. The account can be created, but business access stays unavailable until a superadmin activates the workspace.';
  if (workspace.subscriptionEndsAt && Number.isFinite(new Date(workspace.subscriptionEndsAt).getTime()) && new Date(workspace.subscriptionEndsAt).getTime() <= now) return 'This business subscription has expired. The account can be created, but business access stays unavailable until a superadmin extends the subscription.';
  return '';
}
