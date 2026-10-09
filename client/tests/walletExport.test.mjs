import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the production helper without network requests or generated bundles.
function compile(source) {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}
function evaluate(code, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, ...globals });
  return module.exports;
}
const walletEvents = evaluate(compile(readFileSync(new URL('../src/lib/walletEvents.ts', import.meta.url), 'utf8')));
const apiCode = compile(readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8').replace('import.meta.env', 'globalThis.__viteEnv'));
const workspace = '6ac33ff090f7a65c9f5704c8';
const otherWorkspace = '6ac33ff090f7a65c9f5704c9';
const csvContent = 'Date,Activity,Change INR,Balance after INR\r\n2026-10-05,Messages,-0.75,5999.25\r\n';
const csv = (body = csvContent, headers = {}) => new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="transactions.csv"', ...headers } });
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function browser({ token = 'test-session', explicitWorkspace = workspace, fetch = async () => csv() } = {}) {
  const storage = new Map(token ? [['waba_token', token]] : []), events = [], requests = [];
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const window = { location: { href: 'https://waba.test/?' + new URLSearchParams(explicitWorkspace ? { workspace: explicitWorkspace } : {}) }, dispatchEvent: event => { events.push(event); return true; } };
  class BrowserCustomEvent extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } }
  const apiModule = evaluate(apiCode, {
    __viteEnv: {}, URL, Event, CustomEvent: BrowserCustomEvent, Blob, AbortController, DOMException, localStorage, window,
    require: path => { assert.equal(path, './walletEvents'); return walletEvents; },
    fetch: (url, options) => { requests.push({ url, options }); return fetch(url, options); },
  });
  return { api: apiModule.api, localStorage, window, events, requests };
}

test('wallet export downloads a CSV using current authentication and workspace without billing events', async () => {
  const fixture = browser();
  const result = await fixture.api.downloadWalletHistory();
  assert.equal(fixture.requests[0].url, '/api/wallet/export');
  const options = fixture.requests[0].options;
  assert.ok(!options.method || options.method === 'GET');
  assert.equal(options.headers.Authorization, 'Bearer test-session');
  assert.equal(options.headers['X-Workspace-Id'], workspace);
  assert.equal(options.headers.Accept, 'text/csv');
  assert.equal(options.headers['Content-Type'], undefined);
  assert.equal(options.body, undefined);
  assert.equal(result.fileName, 'transactions.csv');
  assert.ok(result.blob instanceof Blob);
  assert.equal(await result.blob.text(), csvContent);
  assert.equal(fixture.events.length, 0);
});

test('wallet export omits absent credentials and invalid workspace headers', async () => {
  for (const explicitWorkspace of [null, 'not-a-workspace', workspace + '/other']) {
    const fixture = browser({ token: null, explicitWorkspace });
    await fixture.api.downloadWalletHistory();
    assert.equal(fixture.requests[0].options.headers.Authorization, undefined);
    assert.equal(fixture.requests[0].options.headers['X-Workspace-Id'], undefined);
    assert.equal(fixture.events.length, 0);
  }
});

test('wallet export accepts CSV MIME case and charset variants but rejects other response types', async () => {
  const valid = browser({ fetch: async () => csv(csvContent, { 'Content-Type': 'Text/CSV; charset=UTF-8' }) });
  assert.equal((await valid.api.downloadWalletHistory()).blob.size > 0, true);
  for (const type of ['text/html', 'application/json', 'application/octet-stream', 'application/pdf', 'text/csv-malicious']) {
    const fixture = browser({ fetch: async () => csv(csvContent, { 'Content-Type': type }) });
    await assert.rejects(fixture.api.downloadWalletHistory(), /CSV/i);
    assert.equal(fixture.events.length, 0);
  }
  const missing = browser({ fetch: async () => { const response = csv(); response.headers.delete('Content-Type'); return response; } });
  await assert.rejects(missing.api.downloadWalletHistory(), /CSV/i);
});

test('wallet export rejects an empty successful CSV', async () => {
  const fixture = browser({ fetch: async () => csv('') });
  await assert.rejects(fixture.api.downloadWalletHistory(), /empty/i);
  assert.equal(fixture.events.length, 0);
});

test('wallet export accepts attachment CSV filenames including encoded UTF-8 names', async () => {
  for (const [header, expected] of [
    ['attachment; filename="wallet history.csv"', 'wallet history.csv'],
    ['attachment; filename=history.CSV', 'history.CSV'],
    ["attachment; filename=plain.csv; filename*=UTF-8''wallet%20history.csv", 'wallet history.csv'],
    ["attachment; filename=plain.csv; filename*=UTF-8''bad%XX.csv", 'plain.csv'],
  ]) {
    const fixture = browser({ fetch: async () => csv(csvContent, { 'Content-Disposition': header }) });
    assert.equal((await fixture.api.downloadWalletHistory()).fileName, expected);
  }
});

test('wallet export sanitizes paths and falls back to a dated CSV name for absent or wrong extensions', async () => {
  for (const header of ['', 'attachment', 'attachment; filename="wallet.html"', 'attachment; filename="history.csv.exe"']) {
    const fixture = browser({ fetch: async () => csv(csvContent, { 'Content-Disposition': header }) });
    const result = await fixture.api.downloadWalletHistory();
    assert.match(result.fileName, /^waba-wallet-transactions-\d{4}-\d{2}-\d{2}\.csv$/);
  }
  const unsafe = browser({ fetch: async () => csv(csvContent, { 'Content-Disposition': 'attachment; filename="../../history.csv"' }) });
  const result = await unsafe.api.downloadWalletHistory();
  assert.match(result.fileName, /\.csv$/i);
  assert.doesNotMatch(result.fileName, /[\u0000-\u001f\u007f<>:"/\\|?*]/);
  assert.ok(result.fileName.length <= 180);
});

test('wallet export reports JSON errors and preserves the session for non-authentication failures', async () => {
  const fixture = browser({ fetch: async () => json({ message: 'Wallet export is unavailable.' }, 403) });
  await assert.rejects(fixture.api.downloadWalletHistory(), /Wallet export is unavailable/);
  assert.equal(fixture.localStorage.getItem('waba_token'), 'test-session');
  assert.equal(fixture.events.length, 0);
  const malformed = browser({ fetch: async () => new Response('<html>Unavailable</html>', { status: 502 }) });
  await assert.rejects(malformed.api.downloadWalletHistory(), /download|export/i);
  assert.equal(malformed.events.length, 0);
});

test('wallet export expires only the current session for recognized authentication errors', async () => {
  for (const code of ['AUTH_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'SESSION_REVOKED', 'SESSION_EXPIRED']) {
    const fixture = browser({ fetch: async () => json({ code, message: 'Please sign in again.' }, 401) });
    await assert.rejects(fixture.api.downloadWalletHistory(), /Please sign in again/);
    assert.equal(fixture.localStorage.getItem('waba_token'), null);
    assert.deepEqual(fixture.events.map(event => event.type), ['waba:session-expired']);
  }
  let resolve;
  const stale = browser({ fetch: () => new Promise(done => { resolve = done; }) });
  const request = stale.api.downloadWalletHistory();
  stale.localStorage.setItem('waba_token', 'new-session');
  resolve(json({ code: 'SESSION_REVOKED', message: 'Old session expired.' }, 401));
  await assert.rejects(request, /Old session expired/);
  assert.equal(stale.localStorage.getItem('waba_token'), 'new-session');
  assert.equal(stale.events.length, 0);
});

test('wallet export rejects successful downloads after the login or workspace changes', async () => {
  for (const change of ['session', 'workspace']) {
    let resolve;
    const fixture = browser({ fetch: () => new Promise(done => { resolve = done; }) });
    const request = fixture.api.downloadWalletHistory();
    if (change === 'session') fixture.localStorage.setItem('waba_token', 'new-session');
    else fixture.window.location.href = 'https://waba.test/?workspace=' + otherWorkspace;
    resolve(csv());
    await assert.rejects(request, /session|workspace/i);
    assert.equal(fixture.events.length, 0);
  }
});

test('wallet export forwards cancellation and network errors without wallet events', async () => {
  const controller = new AbortController();
  const fixture = browser({ fetch: async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.signal.aborted, true);
    throw new DOMException('Export cancelled.', 'AbortError');
  } });
  controller.abort();
  await assert.rejects(fixture.api.downloadWalletHistory(controller.signal), error => error.name === 'AbortError');
  assert.equal(fixture.events.length, 0);
  const network = browser({ fetch: async () => { throw new Error('Network unavailable'); } });
  await assert.rejects(network.api.downloadWalletHistory(), /Network unavailable/);
  assert.equal(network.events.length, 0);
});

test('wallet export checks cancellation and context again after reading the response body', async () => {
  for (const change of ['abort', 'session', 'workspace']) {
    let resolveBlob, startBlob;
    const started = new Promise(resolve => { startBlob = resolve; });
    const response = csv();
    response.blob = () => { startBlob(); return new Promise(resolve => { resolveBlob = resolve; }); };
    const controller = new AbortController();
    const fixture = browser({ fetch: async () => response });
    const request = fixture.api.downloadWalletHistory(controller.signal);
    await started;
    if (change === 'abort') controller.abort();
    else if (change === 'session') fixture.localStorage.setItem('waba_token', 'new-session');
    else fixture.window.location.href = 'https://waba.test/?workspace=' + otherWorkspace;
    resolveBlob(new Blob([csvContent], { type: 'text/csv' }));
    await assert.rejects(request, error => change === 'abort' ? error.name === 'AbortError' : /session|workspace/i.test(error.message));
    assert.equal(fixture.events.length, 0);
  }
});
