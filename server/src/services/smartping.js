import { createHmac, timingSafeEqual } from 'node:crypto';

export class SmartpingError extends Error {
  constructor(message, status = 400, uncertain = false) { super(message); this.status = status; this.uncertain = uncertain; }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new SmartpingError(label + ' is required.');
  return value.trim();
};
export function phoneNumber(value) {
  const phone = required(value, 'Phone number').replace(/[\s()-]/g, '');
  if (!/^\+?[1-9]\d{7,14}$/.test(phone)) throw new SmartpingError('Use a phone number with its country code.');
  return phone.startsWith('+') ? phone : '+' + phone;
}
function httpUrl(value, label, httpsOnly = false) {
  let url;
  try { url = new URL(required(value, label)); } catch { throw new SmartpingError(label + ' must be a valid URL.'); }
  if (!(httpsOnly ? ['https:'] : ['http:', 'https:']).includes(url.protocol) || url.username || url.password) throw new SmartpingError(label + ' must use ' + (httpsOnly ? 'HTTPS.' : 'HTTP or HTTPS.'));
  return url.toString();
}
function parameters(value, label) {
  if (!object(value) || Object.keys(value).length > 100) throw new SmartpingError(label + ' must be an indexed object.');
  for (const [key, entry] of Object.entries(value)) if (!/^\d+$/.test(key) || typeof entry !== 'string') throw new SmartpingError(label + ' must contain numeric keys and string values.');
  return { ...value };
}
function media(value, carousel = false) {
  if (!object(value) || !(carousel ? ['IMAGE', 'VIDEO'] : ['IMAGE', 'DOC', 'VIDEO']).includes(value.type)) throw new SmartpingError('Unsupported template media type.');
  const result = { url: httpUrl(value.url, 'Media URL'), type: value.type };
  for (const key of ['caption', 'fileName', 'mimeType']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' && !(key === 'mimeType' && value[key] === null)) throw new SmartpingError('Invalid media ' + key + '.');
      result[key] = value[key];
    }
  }
  return result;
}
function buttons(value, max = 10) {
  if (!Array.isArray(value) || value.length > max) throw new SmartpingError('Invalid number of template buttons.');
  return value.map(button => {
    if (!object(button) || !['URL', 'QUICK_REPLY'].includes(button.type)) throw new SmartpingError('Unsupported button type.');
    const result = { type: button.type, text: required(button.text, 'Button text') };
    if (button.index !== undefined) {
      if (!/^\d+$/.test(String(button.index))) throw new SmartpingError('Button index must be a non-negative integer.');
      result.index = button.index;
    }
    if (button.payload !== undefined) result.payload = required(button.payload, 'Button payload');
    if (button.type === 'QUICK_REPLY' && (!result.payload || result.index === undefined)) throw new SmartpingError('Quick replies require payload and index.');
    if (button.url !== undefined) {
      const placeholderUrl = required(button.url, 'Button URL');
      httpUrl(placeholderUrl.replace(/\{\{\d+\}\}/g, 'value'), 'Button URL');
      result.url = placeholderUrl;
    }
    // The authentication example uses type URL with payload, without a URL.
    if (button.type === 'URL' && !result.url && !result.payload) throw new SmartpingError('URL buttons require a URL or copy-code payload.');
    if (button.example !== undefined) {
      if (!Array.isArray(button.example) || !button.example.every(v => typeof v === 'string')) throw new SmartpingError('Button examples must be strings.');
      result.example = [...button.example];
    }
    return result;
  });
}

export function validateTemplate(value) {
  if (!object(value)) throw new SmartpingError('A Smartping template object is required.');
  const result = { templateId: required(value.templateId, 'Smartping template ID') };
  const allowed = ['templateId', 'templateUId', 'parameterValues', 'headerParameterValues', 'media', 'buttons', 'cards'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new SmartpingError('Template contains an undocumented field.');
  if (value.templateUId !== undefined) {
    if (typeof value.templateUId !== 'string') throw new SmartpingError('Template UID must be a string.');
    result.templateUId = value.templateUId;
  }
  for (const key of ['parameterValues', 'headerParameterValues']) if (value[key] !== undefined) result[key] = parameters(value[key], key);
  if (value.media !== undefined) result.media = media(value.media);
  if (value.buttons !== undefined) result.buttons = buttons(value.buttons);
  if (value.cards !== undefined) {
    if (!Array.isArray(value.cards) || !value.cards.length || value.cards.length > 10) throw new SmartpingError('Carousel templates support 1 to 10 cards.');
    result.cards = value.cards.map(card => {
      if (!object(card) || !Array.isArray(card.buttons) || !card.buttons.length) throw new SmartpingError('Each carousel card requires media and 1 to 2 buttons.');
      const item = { media: media(card.media, true), buttons: buttons(card.buttons, 2) };
      if (card.parameterValues !== undefined) item.parameterValues = parameters(card.parameterValues, 'Card parameters');
      return item;
    });
  }
  return result;
}

export function configuration(env = process.env) {
  const missing = ['SMARTPING_WORKSPACE_ID', 'SMARTPING_JOURNEY_ID', 'SMARTPING_FROM'].filter(key => !env[key]);
  if (!env.SMARTPING_AUTH_TOKEN) {
    for (const key of ['SMARTPING_LOGIN_URL', 'SMARTPING_EMAIL', 'SMARTPING_PASSWORD']) if (!env[key]) missing.push(key);
  }
  if (env.SMARTPING_CALLBACK_BASE_URL && (!env.SMARTPING_WEBHOOK_SECRET || env.SMARTPING_WEBHOOK_SECRET.length < 32)) missing.push('SMARTPING_WEBHOOK_SECRET (32+ characters)');
  if (env.SMARTPING_FROM) { try { phoneNumber(env.SMARTPING_FROM); } catch { missing.push('SMARTPING_FROM (valid country-code number)'); } }
  if (!env.SMARTPING_AUTH_TOKEN && env.SMARTPING_LOGIN_URL) { try { httpUrl(env.SMARTPING_LOGIN_URL, 'Login URL', true); } catch { missing.push('SMARTPING_LOGIN_URL (valid HTTPS URL)'); } }
  if (env.SMARTPING_CALLBACK_BASE_URL) {
    try {
      const url = new URL(httpUrl(env.SMARTPING_CALLBACK_BASE_URL, 'Callback base URL', true));
      if (url.pathname !== '/' || url.search || url.hash) throw new Error('Origin required');
    } catch { missing.push('SMARTPING_CALLBACK_BASE_URL (HTTPS origin, no path/query)'); }
  }
  return { configured: missing.length === 0, missing, provider: 'smartping', from: env.SMARTPING_FROM || '', journeyId: env.SMARTPING_JOURNEY_ID || '', deliveryTracking: Boolean(env.SMARTPING_CALLBACK_BASE_URL && env.SMARTPING_WEBHOOK_SECRET?.length >= 32) };
}

export function assertConfigured(workspaceId, env = process.env) {
  const config = configuration(env);
  if (!config.configured || String(workspaceId) !== env.SMARTPING_WORKSPACE_ID) throw new SmartpingError('Smartping is not configured for this workspace. Check the server integration settings.', 409);
  return config;
}

export function callbackSignature(workspaceId, messageId, secret) {
  return createHmac('sha256', secret).update(String(workspaceId) + ':' + String(messageId)).digest('hex');
}
export function verifyCallback(workspaceId, messageId, token, secret) {
  if (!secret || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(callbackSignature(workspaceId, messageId, secret)), Buffer.from(token));
}
export function buildPayload({ workspaceId, messageId, to, template, metaData }, env = process.env) {
  assertConfigured(workspaceId, env);
  const payload = { journeyId: env.SMARTPING_JOURNEY_ID, from: phoneNumber(env.SMARTPING_FROM), to: phoneNumber(to), channel: 'WhatsApp', message: { template: validateTemplate(template) } };
  if (env.SMARTPING_DEPT_ID) payload.deptId = env.SMARTPING_DEPT_ID;
  if (metaData !== undefined) {
    if (!object(metaData) || Object.keys(metaData).some(key => !['tag1', 'tag2', 'tag3'].includes(key) || typeof metaData[key] !== 'string')) throw new SmartpingError('Metadata supports string values for tag1, tag2, and tag3.');
    payload.metaData = { ...metaData };
  }
  if (env.SMARTPING_CALLBACK_BASE_URL) {
    const base = httpUrl(env.SMARTPING_CALLBACK_BASE_URL, 'Callback base URL', true).replace(/\/$/, '');
    payload.callbackUrl = base + '/api/integrations/smartping/events/' + workspaceId + '/' + messageId + '?token=' + callbackSignature(workspaceId, messageId, env.SMARTPING_WEBHOOK_SECRET);
  }
  return payload;
}

export function createSmartpingClient({ env = process.env, fetchImpl = fetch } = {}) {
  let token = null;
  let loginPromise = null;
  const timeout = () => AbortSignal.timeout(20000);
  async function login() {
    if (env.SMARTPING_AUTH_TOKEN) return env.SMARTPING_AUTH_TOKEN;
    if (token) return token;
    if (!loginPromise) loginPromise = (async () => {
      const url = httpUrl(env.SMARTPING_LOGIN_URL, 'Smartping login URL', true);
      let response;
      try { response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: required(env.SMARTPING_EMAIL, 'Smartping email'), password: required(env.SMARTPING_PASSWORD, 'Smartping password') }), signal: timeout() }); }
      catch { throw new SmartpingError('Smartping authentication could not be reached.', 502); }
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.status !== true || typeof data?.response?.token !== 'string' || !data.response.token) throw new SmartpingError('Smartping login failed. Verify the server credentials and login URL.', 502);
      token = data.response.token;
      return token;
    })().finally(() => { loginPromise = null; });
    return loginPromise;
  }
  async function send(payload) {
    const authToken = await login();
    let response;
    try {
      response = await fetchImpl('https://waba.smartping.io/chatbird/api/message/send', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'authentication-token': authToken }, body: JSON.stringify(payload), signal: timeout() });
    } catch { throw new SmartpingError('Smartping did not confirm the request. Check its delivery report before retrying to avoid duplicate messages.', 502, true); }
    const data = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) token = null;
    if (response.ok && data?.status === true && data.code === 100 && typeof data.data?.id === 'string' && data.data.id) return { id: data.data.id };
    if (data?.status === false || response.status === 401 || response.status === 403) throw new SmartpingError('Smartping rejected the request. Verify credentials, journey, sender number, approved template, and its parameters.', 502);
    throw new SmartpingError('Smartping returned an unconfirmed response. Check its delivery report before retrying.', 502, true);
  }
  return { login, send };
}

export function deliveryUpdate(event) {
  if (!object(event) || event.type !== 'event' || typeof event.context?.id !== 'string' || !event.context.id.trim() || !['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(event.event?.status)) throw new SmartpingError('Invalid Smartping delivery event.');
  const timestamp = Number(event.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8640000000000000) throw new SmartpingError('Delivery event requires a valid millisecond timestamp.');
  return { providerMessageId: event.context.id, status: event.event.status.toLowerCase(), timestamp: new Date(timestamp), error: event.event.status === 'FAILED' ? { code: String(event.error?.code || ''), message: String(event.error?.message || 'Delivery failed').slice(0, 500) } : undefined };
}
