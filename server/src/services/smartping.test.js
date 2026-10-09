import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, configuration, createSmartpingClient, deliveryUpdate, validateTemplate, callbackSignature, verifyCallback } from './smartping.js';

const env = { SMARTPING_WORKSPACE_ID: 'workspace-a', SMARTPING_JOURNEY_ID: 'journey-1', SMARTPING_FROM: '+918565565943', SMARTPING_DEPT_ID: 'department-1', SMARTPING_LOGIN_URL: 'https://account.example.com/account/enterprise/login', SMARTPING_EMAIL: 'account@example.com', SMARTPING_PASSWORD: 'test-password', SMARTPING_CALLBACK_BASE_URL: 'https://app.example.com', SMARTPING_WEBHOOK_SECRET: 'test-secret-at-least-32-characters-long' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('text payload follows documented envelope, metadata and authentication-independent callback', () => {
  const payload = buildPayload({ workspaceId: 'workspace-a', messageId: 'message-a', to: '919876543210', template: { templateId: 'text-template' }, metaData: { tag1: 'Campaign' } }, env);
  assert.equal(payload.to, '+919876543210'); assert.equal(payload.channel, 'WhatsApp'); assert.equal(payload.deptId, 'department-1');
  assert.deepEqual(payload.message, { template: { templateId: 'text-template' } });
  assert.deepEqual(payload.metaData, { tag1: 'Campaign' });
  const url = new URL(payload.callbackUrl);
  assert.equal(url.pathname, '/api/integrations/smartping/events/workspace-a/message-a');
  assert.ok(verifyCallback('workspace-a', 'message-a', url.searchParams.get('token'), env.SMARTPING_WEBHOOK_SECRET));
  assert.equal(verifyCallback('workspace-b', 'message-a', url.searchParams.get('token'), env.SMARTPING_WEBHOOK_SECRET), false);
  assert.throws(() => buildPayload({ workspaceId: 'workspace-b' }, env), /not configured/);
});

test('documented IMAGE, DOC, VIDEO, body/header variables and URL/quick reply payloads are preserved', () => {
  for (const type of ['IMAGE', 'DOC', 'VIDEO']) {
    const template = { templateId: 'media-template', templateUId: '', media: { url: 'https://media.example.com/file', type, fileName: 'file', mimeType: null }, parameterValues: { 0: 'Customer' }, headerParameterValues: { 0: 'Header' }, buttons: [{ text: 'Open', type: 'URL', url: 'http://example.com/{{1}}', payload: 'value', index: 0, example: ['value'] }, { text: 'Yes', type: 'QUICK_REPLY', payload: 'yes', index: 1 }] };
    assert.deepEqual(validateTemplate(template), template);
  }
});

test('authentication copy code and carousel constraints match the examples', () => {
  const authentication = { templateId: 'auth', parameterValues: { 0: '1234' }, buttons: [{ index: 0, text: 'Copy Code', type: 'URL', payload: '1234' }] };
  assert.deepEqual(validateTemplate(authentication), authentication);
  const card = { media: { url: 'https://media.example.com/image.png', type: 'IMAGE' }, parameterValues: { 0: 'Offer' }, buttons: [{ text: 'Open', type: 'URL', url: 'http://example.com', index: '0' }] };
  assert.equal(validateTemplate({ templateId: 'carousel', cards: Array(10).fill(card) }).cards.length, 10);
  assert.throws(() => validateTemplate({ templateId: 'carousel', cards: Array(11).fill(card) }), /1 to 10/);
  assert.throws(() => validateTemplate({ templateId: 'carousel', cards: [{ ...card, buttons: Array(3).fill(card.buttons[0]) }] }), /buttons/);
  assert.throws(() => validateTemplate({ templateId: 'carousel', cards: [{ ...card, media: { ...card.media, type: 'DOC' } }] }), /media/);
});

test('invalid inputs fail before any provider request', () => {
  assert.throws(() => validateTemplate({ templateId: 'x', parameterValues: ['a'] }), /indexed object/);
  assert.throws(() => validateTemplate({ templateId: 'x', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] }), /payload and index/);
  assert.throws(() => validateTemplate({ templateId: 'x', media: { type: 'IMAGE', url: 'file:///local' } }), /HTTP/);
  assert.throws(() => validateTemplate({ templateId: 'x', secret: 'x' }), /undocumented/);
  assert.equal(configuration({}).configured, false);
});

test('login response token is cached and sent in authentication-token header', async () => {
  const requests = [];
  const client = createSmartpingClient({ env, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return url.includes('/login') ? json({ status: true, response: { token: 'provider-token' }, message: { code: 0 } }) : json({ status: true, code: 100, data: { id: 'accepted-id' } });
  } });
  assert.deepEqual(await client.send({ test: true }), { id: 'accepted-id' }); await client.send({ test: true });
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests[0].options.body), { email: env.SMARTPING_EMAIL, password: env.SMARTPING_PASSWORD });
  assert.equal(requests[1].url, 'https://waba.smartping.io/chatbird/api/message/send');
  assert.equal(requests[1].options.headers['authentication-token'], 'provider-token');
  assert.equal(requests[1].options.redirect, 'error');
});

test('static tokens skip login; failed HTTP-200 provider responses are rejected', async () => {
  let count = 0;
  const client = createSmartpingClient({ env: { SMARTPING_AUTH_TOKEN: 'static-token' }, fetchImpl: async (_url, options) => {
    count++; assert.equal(options.headers['authentication-token'], 'static-token');
    return json({ status: false, message: 'Validation Failed' });
  } });
  await assert.rejects(client.send({}), /rejected/); assert.equal(count, 1);
});

test('login errors, timeouts and malformed success do not become sent messages or automatic retries', async () => {
  const loginFailure = createSmartpingClient({ env, fetchImpl: async () => json({ status: false, message: { code: 1403 } }) });
  await assert.rejects(loginFailure.send({}), /login failed/);
  for (const response of [null, { status: true, code: 100, data: {} }]) {
    let attempts = 0;
    const client = createSmartpingClient({ env: { SMARTPING_AUTH_TOKEN: 'token' }, fetchImpl: async () => { attempts++; if (response === null) throw new Error('Timeout'); return json(response); } });
    await assert.rejects(client.send({}), error => error.uncertain === true); assert.equal(attempts, 1);
  }
});

test('delivery events parse the documented statuses and millisecond timestamp', () => {
  for (const status of ['SENT', 'DELIVERED', 'READ', 'FAILED']) {
    const result = deliveryUpdate({ context: { id: 'provider-id' }, type: 'event', event: { status }, timestamp: 1722496121000, error: { code: '0', message: 'Failed Retry' } });
    assert.equal(result.status, status.toLowerCase()); assert.equal(result.timestamp.getTime(), 1722496121000);
    assert.equal(Boolean(result.error), status === 'FAILED');
  }
  assert.throws(() => deliveryUpdate({}), /Invalid/);
  const signature = callbackSignature('a', 'b', 'secret');
  assert.equal(verifyCallback('a', 'b', signature, 'wrong'), false);
});
