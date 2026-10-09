import { FEATURES, PlatformPlan } from '../models/Platform.js';
import { CAPACITY_KEYS, validateCapacities } from './accessControl.js';
import { SmartpingError } from './smartping.js';
import { validateWalletConfig } from './walletConfig.js';

export function validateCustomPlan(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SmartpingError('Provide custom plan details.');
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) throw new SmartpingError('Enter a custom plan name, up to 100 characters.');
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000)) throw new SmartpingError('Plan description must be at most 1000 characters.');
  const price = body.monthlyPrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(Math.round(price * 100)) || Math.abs(price * 100 - Math.round(price * 100)) > 0.000001) throw new SmartpingError('Monthly price must be a non-negative amount with at most two decimal places.');
  if (!['INR', 'USD', 'EUR'].includes(body.currency)) throw new SmartpingError('Choose a supported currency.');
  if (!Array.isArray(body.features) || new Set(body.features).size !== body.features.length || body.features.some(feature => !FEATURES.includes(feature))) throw new SmartpingError('Choose valid, unique WABA modules.');
  if (!validateCapacities(body.limits)) throw new SmartpingError('Plan limits must be whole non-negative numbers, or null for unlimited.');
  const activityPricesPaise = body.activityPricesPaise === undefined ? undefined : validateWalletConfig({ prices: body.activityPricesPaise }).prices;
  return { name: body.name.trim(), description: (body.description || '').trim(), monthlyPrice: Math.round(price * 100) / 100, currency: body.currency, features: [...body.features], limits: Object.fromEntries(CAPACITY_KEYS.map(key => [key, body.limits[key] ?? null])), ...(activityPricesPaise === undefined ? {} : { activityPricesPaise }) };
}

// The assigned catalogue plan stays intact underneath the negotiated override.
export async function effectiveWorkspacePlan(workspace, session = null) {
  if (workspace.customPlan) return { ...(workspace.customPlan.toObject ? workspace.customPlan.toObject() : workspace.customPlan), isCustom: true, basePlanId: workspace.plan?._id || workspace.plan || null };
  if (!workspace.plan) return null;
  if (Array.isArray(workspace.plan.features)) return { ...(workspace.plan.toObject ? workspace.plan.toObject() : workspace.plan), isCustom: false };
  let query = PlatformPlan.findById(workspace.plan);
  if (session) query = query.session(session);
  const plan = await query.lean();
  return plan ? { ...plan, isCustom: false } : null;
}
