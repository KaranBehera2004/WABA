import { FEATURES } from '../models/Platform.js';
import { validateCapacities, validateSeatLimits, validateRolePolicy } from './accessControl.js';
import { passwordPolicyError } from './platformConfig.js';
import { SmartpingError } from './smartping.js';

const fail = message => { throw new SmartpingError(message, 400); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, key, max, required = false) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(`Enter a valid ${key}${required ? ' (required)' : ''}, up to ${max} characters.`);
  return value.trim();
};

export function validateSubscriptionExpiry(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) fail('Subscription expiry must be a valid ISO date, or null for no expiry.');
  const date = new Date(value);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  const time = value.includes('T') ? value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/) : null;
  if (!Number.isFinite(date.getTime()) || calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day || (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59))) fail('Subscription expiry must be a valid ISO date, or null for no expiry.');
  return date;
}

export function validateWorkspaceBusinessFields(body) {
  const fields = {};
  if (body.slug !== undefined) {
    const slug = text(body.slug, 'business identifier', 60, true).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(slug)) fail('Business identifier must be 3 to 60 lowercase letters, numbers and hyphens; start and end with a letter or number.');
    fields.slug = slug;
  }
  if (body.email !== undefined) {
    const email = text(body.email, 'business email', 200).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid business email.');
    fields.email = email;
  }
  if (body.phone !== undefined) fields.phone = text(body.phone, 'business phone', 32);
  if (body.addonFeatures !== undefined) {
    if (!Array.isArray(body.addonFeatures) || body.addonFeatures.some(feature => !FEATURES.includes(feature)) || new Set(body.addonFeatures).size !== body.addonFeatures.length) fail('Choose valid, distinct add-on features.');
    fields.addonFeatures = [...body.addonFeatures];
  }
  if (body.seatLimits !== undefined) {
    if (!validateSeatLimits(body.seatLimits)) fail('Seat limits must be whole numbers from 0 to 100000, or null for unlimited, for Business Admin, Agent and Supervisor roles only.');
    fields.seatLimits = { ...body.seatLimits };
  }
  if (body.rolePolicy !== undefined) {
    if (!validateRolePolicy(body.rolePolicy)) fail('Choose known creation roles and unique business permissions for each role.');
    fields.rolePolicy = body.rolePolicy;
  }
  return fields;
}

export function validateWorkspaceOwner(body, settings) {
  if ((body.owner !== undefined) === (body.newOwner !== undefined)) fail('Choose either an existing registered owner or a new owner account, not both.');
  if (body.owner !== undefined) {
    if (typeof body.owner !== 'string' || !/^[a-f0-9]{24}$/i.test(body.owner)) fail('Choose a valid registered owner.');
    return { owner: body.owner };
  }
  if (!object(body.newOwner)) fail('Provide the new owner name, email and password.');
  const name = text(body.newOwner.name, 'owner name', 80, true);
  const email = text(body.newOwner.email, 'owner email', 200, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid owner email.');
  const password = body.newOwner.password;
  const passwordError = passwordPolicyError(password, settings, 10);
  if (passwordError) fail(passwordError);
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) fail('Owner password must include a lowercase letter, an uppercase letter and a number.');
  return { newOwner: { name, email, password } };
}

// This is intentionally used only by the superadmin provisioning endpoint.
// Public registration and ordinary workspace creation never forward its options.
export function validateWorkspaceConfiguration(body) {
  if (!object(body)) fail('Provide workspace configuration as an object.');
  const config = { name: text(body.name, 'workspace name', 120, true), ...validateWorkspaceBusinessFields(body) };
  for (const key of ['isActive', 'sendingEnabled']) if (body[key] !== undefined) {
    if (typeof body[key] !== 'boolean') fail(`${key} must be true or false.`);
    config[key] = body[key];
  }
  if (body.plan !== undefined) {
    if (body.plan !== null && (typeof body.plan !== 'string' || !/^[a-f0-9]{24}$/i.test(body.plan))) fail('Choose a valid active plan, or no plan.');
    config.plan = body.plan;
  }
  if (body.subscriptionEndsAt !== undefined && body.trialDays !== undefined) fail('Choose either a subscription expiry or trial days, not both.');
  if (body.subscriptionEndsAt !== undefined) config.subscriptionEndsAt = validateSubscriptionExpiry(body.subscriptionEndsAt);
  if (body.trialDays !== undefined) {
    if (!Number.isSafeInteger(body.trialDays) || body.trialDays < 0 || body.trialDays > 365) fail('Trial days must be a whole number from 0 to 365.');
    config.trialDays = body.trialDays;
  }
  if (body.disabledFeatures !== undefined) {
    if (!Array.isArray(body.disabledFeatures) || body.disabledFeatures.some(feature => !FEATURES.includes(feature)) || new Set(body.disabledFeatures).size !== body.disabledFeatures.length) fail('Choose valid, distinct workspace features.');
    config.disabledFeatures = [...body.disabledFeatures];
  }
  if (body.settings !== undefined) {
    if (!object(body.settings)) fail('Workspace settings must be an object.');
    config.settings = {};
    if (body.settings.timezone !== undefined) {
      const timezone = text(body.settings.timezone, 'timezone', 100, true);
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { fail('Choose a valid IANA timezone.'); }
      config.settings.timezone = timezone;
    }
    if (body.settings.supportEmail !== undefined) {
      const email = text(body.settings.supportEmail, 'support email', 200);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid support email.');
      config.settings.supportEmail = email;
    }
    if (body.settings.businessDescription !== undefined) config.settings.businessDescription = text(body.settings.businessDescription, 'business description', 3000);
  }
  if (body.limits !== undefined) {
    if (!validateCapacities(body.limits)) fail('Workspace limits must contain known capacities with whole non-negative numbers, or null for unlimited.');
    config.limits = { ...body.limits };
  }
  if (config.rolePolicy) config.permissionRules = config.rolePolicy.permissionCeilings;
  if (body.adminNotes !== undefined) config.adminNotes = text(body.adminNotes, 'administrator notes', 3000);
  return config;
}
