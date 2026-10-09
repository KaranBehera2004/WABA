import { SmartpingError } from './smartping.js';

export const PLATFORM_DEFAULTS = {
  platformName: 'WABADesk', supportEmail: '', supportPhone: '', supportUrl: '', termsUrl: '', privacyUrl: '',
  loginTitle: 'Welcome back', loginDescription: 'Enter your credentials to access your workspace.', footerText: '',
  registrationEnabled: true, workspaceCreationEnabled: true, memberAccessEnabled: true,
  maintenanceEnabled: false, maintenanceMessage: 'WABA is temporarily under maintenance. Please try again later.',
  sendingEnabled: true, broadcastsEnabled: true, maxBroadcastRecipients: 100, disabledFeatures: [],
  defaultTimezone: 'Asia/Kolkata', defaultPlan: null, trialDays: 0, workspaceLimitPerOwner: null,
  allowedSignupDomains: [], passwordMinLength: 8, passwordRequireUppercase: false, passwordRequireNumber: false, sessionLifetimeHours: null,
};
export const PLATFORM_FIELDS = Object.keys(PLATFORM_DEFAULTS);
const switches = ['registrationEnabled', 'workspaceCreationEnabled', 'memberAccessEnabled', 'maintenanceEnabled', 'sendingEnabled', 'broadcastsEnabled', 'passwordRequireUppercase', 'passwordRequireNumber'];
const numbers = { maxBroadcastRecipients: [1, 100], trialDays: [0, 365], workspaceLimitPerOwner: [0, 1000], passwordMinLength: [8, 64], sessionLifetimeHours: [1, 720] };
const optionalNumbers = ['workspaceLimitPerOwner', 'sessionLifetimeHours'];
export function validatePlatformConfig(body, features) {
  const updates = Object.fromEntries(PLATFORM_FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  const fail = message => { throw new SmartpingError(message); };
  for (const key of switches) if (updates[key] !== undefined && typeof updates[key] !== 'boolean') fail('Settings switches must be true or false.');
  for (const [key, [min, max]] of Object.entries(numbers)) if (updates[key] !== undefined && !(updates[key] === null && optionalNumbers.includes(key)) && (!Number.isSafeInteger(updates[key]) || updates[key] < min || updates[key] > max)) fail(`${key} must be a whole number from ${min} to ${max}${optionalNumbers.includes(key) ? ', or null to use the default' : ''}.`);
  const strings = { platformName: 100, supportEmail: 200, supportPhone: 40, supportUrl: 500, termsUrl: 500, privacyUrl: 500, loginTitle: 100, loginDescription: 500, footerText: 300, maintenanceMessage: 500, defaultTimezone: 100 };
  for (const [key, max] of Object.entries(strings)) if (updates[key] !== undefined) {
    if (typeof updates[key] !== 'string' || updates[key].trim().length > max) fail(`Invalid ${key}.`);
    updates[key] = updates[key].trim();
  }
  for (const key of ['platformName', 'loginTitle', 'loginDescription', 'maintenanceMessage', 'defaultTimezone']) if (updates[key] === '') fail(`${key} cannot be empty.`);
  if (updates.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.supportEmail)) fail('Enter a valid support email.');
  for (const key of ['supportUrl', 'termsUrl', 'privacyUrl']) if (updates[key]) {
    try { const url = new URL(updates[key]); if (url.protocol !== 'https:' || url.username || url.password) fail('invalid'); }
    catch { fail(`${key} must be a valid HTTPS link without embedded credentials.`); }
  }
  if (updates.defaultTimezone !== undefined) try { new Intl.DateTimeFormat('en', { timeZone: updates.defaultTimezone }); } catch { fail('Choose a valid IANA timezone.'); }
  if (updates.disabledFeatures !== undefined && (!Array.isArray(updates.disabledFeatures) || updates.disabledFeatures.some(key => !features.includes(key)) || new Set(updates.disabledFeatures).size !== updates.disabledFeatures.length)) fail('Choose valid, distinct platform features.');
  if (updates.allowedSignupDomains !== undefined) {
    if (!Array.isArray(updates.allowedSignupDomains) || updates.allowedSignupDomains.length > 100 || updates.allowedSignupDomains.some(value => typeof value !== 'string' || value.trim().length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value.trim()))) fail('Enter valid email domains such as example.com; do not include @, wildcards or links.');
    updates.allowedSignupDomains = [...new Set(updates.allowedSignupDomains.map(value => value.trim().toLowerCase()))];
  }
  if (updates.defaultPlan !== undefined && updates.defaultPlan !== null && (typeof updates.defaultPlan !== 'string' || !/^[a-f0-9]{24}$/i.test(updates.defaultPlan))) fail('Choose a valid default plan.');
  return updates;
}
export function passwordPolicyError(password, settings, minimum = 8) {
  const length = Math.max(minimum, settings.passwordMinLength || 8);
  if (typeof password !== 'string' || password.length < length) return `Use a password of at least ${length} characters.`;
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must not exceed 72 UTF-8 bytes.';
  if (settings.passwordRequireUppercase && !/[A-Z]/.test(password)) return 'Password must include an uppercase letter.';
  if (settings.passwordRequireNumber && !/[0-9]/.test(password)) return 'Password must include a number.';
  return '';
}
export function signupAllowed(email, settings) {
  return !settings.allowedSignupDomains?.length || settings.allowedSignupDomains.includes(email.split('@').at(-1));
}
export function sessionExpiry(settings, env = process.env) {
  return settings.sessionLifetimeHours ? settings.sessionLifetimeHours * 3600 : env.JWT_EXPIRES_IN || '7d';
}
export function newWorkspaceDefaults(settings, planExists = true, now = new Date()) {
  return {
    ...(settings.defaultPlan && planExists ? { plan: settings.defaultPlan } : {}),
    ...(settings.trialDays > 0 ? { subscriptionEndsAt: new Date(now.getTime() + settings.trialDays * 86400000) } : {}),
    timezone: settings.defaultTimezone || 'Asia/Kolkata',
  };
}
