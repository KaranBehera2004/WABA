import { SmartpingError } from './smartping.js';

// Integer paise only. This is a separate testing ledger, never a real payment account.
export const ACTIVITY_PRICES = { contacts: 100, conversations: 200, messages: 75, calls: 500, campaigns: 1000, templates: 300, automations: 800, dashboards: 1500, reports: 500, segments: 200, ads: 2000 };
export const ACTIVITY_UNITS = { contacts: 'New contact', conversations: 'New conversation', messages: 'Outgoing template attempt', calls: 'New call log', campaigns: 'New campaign', templates: 'New template', automations: 'New bot', dashboards: 'New dashboard', reports: 'Generated report', segments: 'New segment', ads: 'New stored ad' };
export const WALLET_DEFAULTS = { deductionsEnabled: true, openingMinPaise: 500000, openingMaxPaise: 1000000, prices: ACTIVITY_PRICES };
export const MAX_WALLET_PAISE = 100000000000;
export function workspacePricing(settings, workspace) {
  const saved = workspace?.customPlan?.activityPricesPaise;
  const overrides = saved?.toObject ? saved.toObject() : saved || {};
  const prices = { ...settings.prices };
  for (const [activity, amount] of Object.entries(overrides)) {
    if (amount === undefined) continue;
    if (!Object.hasOwn(ACTIVITY_PRICES, activity) || !Number.isSafeInteger(amount) || amount < 0 || amount > 1000000) throw new SmartpingError('This business has invalid activity prices. Ask the Super Admin to update its custom plan.', 409);
    prices[activity] = amount;
  }
  return { ...settings, prices, pricingSource: Object.values(overrides).some(value => value !== undefined) ? 'custom' : 'default' };
}
export function validateWalletConfig(body) {
  const updates = {};
  if (body.deductionsEnabled !== undefined) {
    if (typeof body.deductionsEnabled !== 'boolean') throw new SmartpingError('Deductions enabled must be true or false.');
    updates.deductionsEnabled = body.deductionsEnabled;
  }
  for (const key of ['openingMinPaise', 'openingMaxPaise']) if (body[key] !== undefined) {
    if (!Number.isSafeInteger(body[key]) || body[key] < 0 || body[key] > 100000000) throw new SmartpingError('Opening test credits must be whole paise between 0 and 100000000.');
    updates[key] = body[key];
  }
  if (body.prices !== undefined) {
    if (!body.prices || typeof body.prices !== 'object' || Array.isArray(body.prices) || Object.keys(body.prices).some(key => !Object.hasOwn(ACTIVITY_PRICES, key)) || Object.values(body.prices).some(value => !Number.isSafeInteger(value) || value < 0 || value > 1000000)) throw new SmartpingError('Choose valid activities and prices from 0 to 1000000 whole paise.');
    updates.prices = body.prices;
  }
  return updates;
}
export function validateWalletAdjustment(body) {
  if (!['credit', 'debit'].includes(body.direction) || !Number.isSafeInteger(body.amountPaise) || body.amountPaise <= 0 || body.amountPaise > 100000000) throw new SmartpingError('Choose credit or debit and a positive amount of at most 100000000 whole paise.');
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 300) throw new SmartpingError('A reason of 1 to 300 characters is required.');
  if (typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9._-]{8,100}$/.test(body.idempotencyKey)) throw new SmartpingError('A unique adjustment request key is required.');
  return { direction: body.direction, amountPaise: body.amountPaise, reason: body.reason.trim(), idempotencyKey: body.idempotencyKey };
}
