import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../app.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { AdminAudit, PlatformInvoice, PlatformSettings } from '../models/Platform.js';
import { TestWallet, WalletEntry, WalletConfig } from '../models/Wallet.js';

test('invoice PDF download is authenticated, audited, attachment-safe and read-only', async t => {
  const userId = '507f1f77bcf86cd799439011';
  const workspaceId = '507f1f77bcf86cd799439012';
  const invoiceId = '507f1f77bcf86cd799439013';
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'invoice-download-route-test-only';
  const originals = [];
  const mock = (object, key, value) => { originals.push([object, key, object[key]]); object[key] = value; };
  const user = { _id: new mongoose.Types.ObjectId(userId), role: 'superadmin', isActive: true, sessionVersion: 0 };
  const settings = { platformName: 'Invoice Test Platform', supportEmail: 'support@example.test', defaultTimezone: 'Asia/Kolkata' };
  const savedInvoice = {
    _id: new mongoose.Types.ObjectId(invoiceId),
    invoiceNumber: 'WABA-TEST-001', workspace: { _id: new mongoose.Types.ObjectId(workspaceId), name: 'Test Business' },
    description: 'Monthly workspace subscription', amount: 10000, currency: 'INR', status: 'Draft',
    createdAt: new Date('2026-10-05T05:00:00Z'), dueAt: new Date('2026-10-20T00:00:00Z'),
  };
  let invoice = savedInvoice, invoiceReads = 0, settingReads = 0, queryError;
  const audits = [];
  mock(User, 'findById', async id => { assert.equal(String(id), userId); return user; });
  mock(PlatformInvoice, 'findById', id => {
    invoiceReads++;
    assert.equal(String(id), invoiceId);
    return { populate: (field, projection) => {
      assert.equal(field, 'workspace'); assert.equal(projection, 'name');
      return { lean: async () => { if (queryError) throw queryError; return invoice; } };
    } };
  });
  mock(PlatformSettings, 'findOne', filter => {
    settingReads++; assert.deepEqual(filter, { key: 'platform' });
    return { lean: async () => settings };
  });
  mock(AdminAudit, 'create', async item => { audits.push(item); return item; });
  const noMutation = () => assert.fail('Downloading an invoice must not mutate billing, wallets or workspaces.');
  mock(mongoose, 'startSession', noMutation);
  for (const Model of [PlatformInvoice, Workspace, TestWallet, WalletEntry, WalletConfig]) {
    for (const method of ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne']) mock(Model, method, noMutation);
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const token = (role = 'superadmin', version = 0) => jwt.sign({ sub: userId, role, version }, process.env.JWT_SECRET, { issuer: 'waba-api', expiresIn: '1h' });
  const request = (id = invoiceId, bearer = token()) => fetch(`${base}/api/superadmin/invoices/${id}/download`, {
    headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), Origin: process.env.CLIENT_URL || 'http://localhost:5173' },
  });
  const jsonError = async (response, expectedStatus) => {
    assert.equal(response.status, expectedStatus);
    assert.match(response.headers.get('content-type'), /^application\/json\b/);
    assert.equal(response.headers.get('content-disposition'), null);
    const data = await response.json(); assert.equal(typeof data.message, 'string');
    return data;
  };
  const pdfResponse = async response => {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/pdf\b/);
    assert.match(response.headers.get('cache-control'), /\bprivate\b/);
    assert.match(response.headers.get('cache-control'), /\bno-store\b/);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="WABA-TEST-001.pdf"');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.match(bytes.subarray(-100).toString('ascii'), /%%EOF/);
    assert.ok(bytes.length > 1000, 'The attachment must contain an actual PDF, not JSON or an empty placeholder.');
    return bytes;
  };
  try {
    await t.test('no authentication and stale sessions return JSON without querying invoices', async () => {
      assert.equal((await jsonError(await request(invoiceId, ''), 401)).code, 'AUTH_REQUIRED');
      assert.equal((await jsonError(await request(invoiceId, 'not-a-jwt'), 401)).code, 'SESSION_EXPIRED');
      user.sessionVersion = 1;
      assert.equal((await jsonError(await request(), 401)).code, 'SESSION_REVOKED');
      user.sessionVersion = 0;
      user.isActive = false;
      assert.equal((await jsonError(await request(), 401)).code, 'ACCOUNT_UNAVAILABLE');
      user.isActive = true;
      assert.equal(invoiceReads, 0); assert.equal(settingReads, 0); assert.equal(audits.length, 0);
    });
    await t.test('database role cannot be overridden by a superadmin claim in the token', async () => {
      user.role = 'owner'; await jsonError(await request(), 403); user.role = 'superadmin';
      assert.equal(invoiceReads, 0); assert.equal(audits.length, 0);
    });
    await t.test('invalid IDs and missing records fail before setting PDF attachment headers', async () => {
      await jsonError(await request('not-an-object-id'), 400); assert.equal(invoiceReads, 0);
      invoice = null; await jsonError(await request(), 404); invoice = savedInvoice;
      assert.equal(settingReads, 0); assert.equal(audits.length, 0);
    });
    await t.test('all saved invoice statuses download without changing their status or wallet balance', async () => {
      for (const status of ['Draft', 'Issued', 'Paid', 'Void']) {
        invoice = { ...savedInvoice, status, ...(status === 'Paid' ? { paidAt: new Date('2026-10-06T00:00:00Z'), paymentReference: 'EXTERNAL-PAYMENT-001' } : {}) };
        const before = JSON.stringify(invoice), beforeSettings = JSON.stringify(settings), auditCount = audits.length;
        // A database superadmin remains authorized even if their token carries an old non-root role.
        await pdfResponse(await request(invoiceId, token('owner')));
        assert.equal(JSON.stringify(invoice), before); assert.equal(JSON.stringify(settings), beforeSettings);
        assert.equal(audits.length, auditCount + 1, 'Successful read downloads must be included in the root audit log.');
        const audit = audits.at(-1);
        assert.equal(String(audit.actor), userId); assert.equal(String(audit.workspace), workspaceId);
        assert.match(audit.action, /^GET .*\/invoices\/507f1f77bcf86cd799439013\/download$/);
        assert.deepEqual(audit.details, { statusCode: 200, fields: [], invoiceId, format: 'pdf' });
      }
      invoice = savedInvoice;
    });
    await t.test('the real application exposes Content-Disposition to the browser', async () => {
      const response = await request();
      assert.match(response.headers.get('access-control-expose-headers'), /Content-Disposition/i);
      assert.equal(response.headers.get('access-control-allow-origin'), process.env.CLIENT_URL || 'http://localhost:5173');
      await pdfResponse(response);
    });
    await t.test('stored invoice numbers cannot inject headers or path separators into the filename', async () => {
      invoice = { ...savedInvoice, invoiceNumber: 'WABA-"/\\\r\nX-Evil: yes' };
      const response = await request(); assert.equal(response.status, 200);
      assert.match(response.headers.get('content-disposition'), /^attachment; filename="[A-Za-z0-9_-]+\.pdf"$/);
      assert.equal(response.headers.get('x-evil'), null);
      assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString('ascii'), '%PDF-');
      invoice = savedInvoice;
    });
    await t.test('a deleted workspace does not prevent the saved invoice from downloading', async () => {
      invoice = { ...savedInvoice, workspace: null };
      await pdfResponse(await request()); assert.equal(audits.at(-1).workspace, undefined);
      invoice = savedInvoice;
    });
    await t.test('invalid stored billing data and database failures remain JSON errors with no false audit success', async () => {
      const before = audits.length;
      for (const invalid of [{ amount: -1 }, { amount: Infinity }, { currency: 'INVALID' }, { status: 'Unknown' }]) {
        invoice = { ...savedInvoice, ...invalid }; await jsonError(await request(), 500);
      }
      invoice = savedInvoice; queryError = new Error('Test invoice lookup failed.');
      await jsonError(await request(), 500); queryError = undefined;
      assert.equal(audits.length, before);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [object, key, original] of originals.reverse()) object[key] = original;
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  }
});
