import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual client sources in a small browser fixture. No generated
// test bundles, live network requests or production dependencies are needed.
function compile(source) {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}
const walletCode = compile(readFileSync(new URL('../src/lib/walletEvents.ts', import.meta.url), 'utf8'));
const apiCode = compile(readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8').replace('import.meta.env', 'globalThis.__viteEnv'));
function evaluate(code, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, ...globals });
  return module.exports;
}
const walletEvents = evaluate(walletCode);
const workspace = '6ac33ff090f7a65c9f5704c8';
const otherWorkspace = '6ac33ff090f7a65c9f5704c9';
const receipt = (changes = {}) => ({ entryId: '6ac33ff090f7a65c9f5704d1', workspace, activity: 'messages', chargedPaise: 75, balanceAfterPaise: 599925, currency: 'INR', mode: 'test', ...changes });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function browser({ token = 'test-session', explicitWorkspace = workspace, fetch = async () => json({}) } = {}) {
  const storage = new Map(token ? [['waba_token', token]] : []), events = [], requests = [];
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const window = { location: { href: 'https://waba.test/?' + new URLSearchParams(explicitWorkspace ? { workspace: explicitWorkspace } : {}) }, dispatchEvent: event => { events.push(event); return true; } };
  class BrowserCustomEvent extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } }
  const apiModule = evaluate(apiCode, {
    __viteEnv: {}, URL, Event, CustomEvent: BrowserCustomEvent, localStorage, window,
    require: path => { assert.equal(path, './walletEvents'); return walletEvents; },
    fetch: (url, options) => { requests.push({ url, options }); return fetch(url, options); },
  });
  return { api: apiModule.api, window, localStorage, events, requests, charged: () => events.filter(event => event.type === 'waba:wallet-charged') };
}

test('committed positive test receipts are retained and scoped to the current workspace', () => {
  const current = receipt();
  assert.deepEqual(Array.from(walletEvents.readWalletCharges([current], workspace)), [current]);
  assert.equal(walletEvents.readWalletCharges([receipt({ workspace: otherWorkspace })], workspace).length, 0);
  assert.deepEqual(Array.from(walletEvents.readWalletCharges([receipt({ workspace: otherWorkspace }), current], workspace)), [current]);
});

test('receipt validation rejects zero, malformed values, wrong modes and invalid identifiers', () => {
  for (const value of [null, {}, 'invalid', undefined]) assert.equal(walletEvents.readWalletCharges(value).length, 0);
  for (const invalid of [
    null, 'invalid', receipt({ chargedPaise: 0 }), receipt({ chargedPaise: -75 }), receipt({ chargedPaise: 0.75 }),
    receipt({ chargedPaise: Number.MAX_SAFE_INTEGER + 1 }), receipt({ balanceAfterPaise: -1 }), receipt({ balanceAfterPaise: 0.1 }),
    receipt({ currency: 'USD' }), receipt({ mode: 'live' }), receipt({ activity: 'unknown' }), receipt({ activity: ['messages'] }),
    receipt({ entryId: 'not-an-id' }), receipt({ workspace: 'not-a-workspace' }), receipt({ entryId: [receipt().entryId] }), receipt({ workspace: [workspace] }),
  ]) assert.equal(walletEvents.readWalletCharges([invalid]).length, 0, JSON.stringify(invalid));
});

test('duplicate receipt IDs are displayed once while distinct activity charges are retained', () => {
  const first = receipt(), second = receipt({ entryId: '6ac33ff090f7a65c9f5704d2', activity: 'calls', chargedPaise: 500 });
  assert.deepEqual(Array.from(walletEvents.readWalletCharges([first, first, second], workspace)), [first, second]);
});

test('successful authenticated mutation dispatches exact server deductions and required headers', async () => {
  const entry = receipt();
  const fixture = browser({ fetch: async () => json({ walletCharges: [entry, entry], reason: 'Demo completed.' }, 201) });
  const result = await fixture.api.demoWalletActivity('messages', 'demo-idempotency-key');
  assert.equal(result.reason, 'Demo completed.');
  assert.equal(fixture.requests[0].url, '/api/wallet/demo-activity');
  assert.equal(fixture.requests[0].options.headers.Authorization, 'Bearer test-session');
  assert.equal(fixture.requests[0].options.headers['X-Workspace-Id'], workspace);
  assert.deepEqual(JSON.parse(fixture.requests[0].options.body), { activity: 'messages', idempotencyKey: 'demo-idempotency-key' });
  assert.deepEqual(fixture.events.map(event => event.type), ['waba:wallet-changed', 'waba:wallet-charged']);
  assert.deepEqual(Array.from(fixture.charged()[0].detail.charges), [entry]);
});

test('free, duplicate, malformed and cross-workspace mutation receipts never show a deduction', async () => {
  for (const body of [
    { chargedPaise: 0, walletCharges: [] }, { duplicate: true, walletCharges: [] },
    { walletCharges: [receipt({ chargedPaise: 0 })] }, { walletCharges: 'invalid' },
    { walletCharges: [receipt({ workspace: otherWorkspace })] }, { walletCharges: [receipt({ entryId: ['bad'] })] },
  ]) {
    const fixture = browser({ fetch: async () => json(body) });
    await fixture.api.demoWalletActivity('messages', 'demo-idempotency-key');
    assert.equal(fixture.charged().length, 0);
    assert.deepEqual(fixture.events.map(event => event.type), ['waba:wallet-changed']);
  }
});

test('read-only and unauthenticated requests do not dispatch wallet mutation events', async () => {
  const read = browser({ fetch: async () => json({ walletCharges: [receipt()] }) });
  await read.api.walletSummary();
  assert.equal(read.events.length, 0);
  const anonymous = browser({ token: null, fetch: async () => json({ walletCharges: [receipt()] }) });
  await anonymous.api.demoWalletActivity('messages', 'demo-idempotency-key');
  assert.equal(anonymous.events.length, 0);
  assert.equal(anonymous.requests[0].options.headers.Authorization, undefined);
});

test('failed responses refresh possible reservations but cannot publish a deduction receipt', async () => {
  const fixture = browser({ fetch: async () => json({ message: 'Activity failed.', walletCharges: [receipt()] }, 500) });
  await assert.rejects(fixture.api.demoWalletActivity('messages', 'demo-idempotency-key'), /Activity failed/);
  assert.equal(fixture.charged().length, 0);
  assert.deepEqual(fixture.events.map(event => event.type), ['waba:wallet-changed']);
  const malformed = browser({ fetch: async () => new Response('<html>Error</html>', { status: 502 }) });
  await assert.rejects(malformed.api.demoWalletActivity('messages', 'demo-idempotency-key'), /Something went wrong/);
  assert.equal(malformed.charged().length, 0);
  const network = browser({ fetch: async () => { throw new Error('Network unavailable'); } });
  await assert.rejects(network.api.demoWalletActivity('messages', 'demo-idempotency-key'), /Network unavailable/);
  assert.equal(network.events.length, 0);
});

test('late responses cannot notify a different login session or workspace', async () => {
  for (const change of ['session', 'workspace']) {
    let resolve;
    const fixture = browser({ fetch: () => new Promise(done => { resolve = done; }) });
    const request = fixture.api.demoWalletActivity('messages', 'demo-idempotency-key');
    if (change === 'session') fixture.localStorage.setItem('waba_token', 'new-session');
    else fixture.window.location.href = 'https://waba.test/?workspace=' + otherWorkspace;
    resolve(json({ walletCharges: [receipt()] }, 201));
    await request;
    assert.equal(fixture.events.length, 0);
  }
});

test('recognized session expiry clears only the current session and does not emit wallet events', async () => {
  for (const code of ['AUTH_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'SESSION_REVOKED', 'SESSION_EXPIRED']) {
    const fixture = browser({ fetch: async () => json({ code, message: 'Sign in again.', walletCharges: [receipt()] }, 401) });
    await assert.rejects(fixture.api.demoWalletActivity('messages', 'demo-idempotency-key'), /Sign in again/);
    assert.equal(fixture.localStorage.getItem('waba_token'), null);
    assert.deepEqual(fixture.events.map(event => event.type), ['waba:session-expired']);
  }
  let resolve;
  const late = browser({ fetch: () => new Promise(done => { resolve = done; }) });
  const request = late.api.demoWalletActivity('messages', 'demo-idempotency-key');
  late.localStorage.setItem('waba_token', 'new-session');
  resolve(json({ code: 'SESSION_REVOKED', message: 'Old session revoked.' }, 401));
  await assert.rejects(request, /Old session revoked/);
  assert.equal(late.localStorage.getItem('waba_token'), 'new-session');
  assert.equal(late.events.length, 0);
});

test('provider authentication failures without session expiry codes leave the login intact', async () => {
  const fixture = browser({ fetch: async () => json({ code: 'PROVIDER_AUTH_FAILED', message: 'Provider authentication failed.' }, 401) });
  await assert.rejects(fixture.api.demoWalletActivity('messages', 'demo-idempotency-key'), /Provider authentication failed/);
  assert.equal(fixture.localStorage.getItem('waba_token'), 'test-session');
  assert.equal(fixture.charged().length, 0);
  assert.equal(fixture.events.some(event => event.type === 'waba:session-expired'), false);
});
