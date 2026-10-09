import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Message } from '../models/Domain.js';
import router from './smartping.js';
import { callbackSignature } from '../services/smartping.js';
import { WalletEntry } from '../models/Wallet.js';

test('callback authorization, tenant correlation, duplicate events and delayed events', async () => {
  const workspaceId = '507f1f77bcf86cd799439011';
  const messageId = '507f1f77bcf86cd799439012';
  const otherWorkspace = '507f1f77bcf86cd799439013';
  const secret = 'test-webhook-secret-at-least-32-characters';
  const previousSecret = process.env.SMARTPING_WEBHOOK_SECRET;
  process.env.SMARTPING_WEBHOOK_SECRET = secret;
  const originals = { findOne: Message.findOne, updateOne: Message.updateOne, settle: WalletEntry.updateOne };
  let settlements = 0;
  WalletEntry.updateOne = async (filter, update) => { assert.equal(filter.workspace, workspaceId); assert.equal(filter.operationKey, 'activity:messages:' + messageId); assert.equal(filter.status, 'reserved'); assert.equal(update.$set.status, 'complete'); settlements++; return { matchedCount: 1 }; };
  let item = { _id: messageId, workspace: workspaceId, provider: 'smartping', status: 'queued' };
  let queries = 0;
  Message.findOne = async filter => {
    queries++;
    return filter._id === messageId && filter.workspace === workspaceId ? { ...item } : null;
  };
  Message.updateOne = async (filter, update) => {
    const timestamp = update.$set.providerEventAt;
    const providerId = filter.$and[1].$or[1].providerMessageId;
    if (!filter.status.$in.includes(item.status) || (item.providerEventAt && item.providerEventAt > timestamp) || (item.providerMessageId && item.providerMessageId !== providerId)) return { matchedCount: 0, modifiedCount: 0 };
    item = { ...item, ...update.$set };
    if (update.$unset?.error !== undefined) delete item.error;
    return { matchedCount: 1, modifiedCount: 1 };
  };
  const app = express(); app.use(express.json()); app.use('/api/integrations/smartping', router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/integrations/smartping/events/';
  const post = (status, timestamp, token = callbackSignature(workspaceId, messageId, secret), workspace = workspaceId, providerId = 'provider-id') => fetch(base + workspace + '/' + messageId + '?token=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: { id: providerId }, type: 'event', event: { status }, timestamp }) });
  try {
    assert.equal((await post('SENT', 1000, 'bad')).status, 401); assert.equal(queries, 0);
    assert.equal((await post('SENT', 1000, callbackSignature(workspaceId, messageId, secret), otherWorkspace)).status, 401);
    assert.equal((await post('DELIVERED', 2000)).status, 200); assert.equal(item.status, 'delivered'); assert.equal(settlements, 1);
    assert.equal((await post('DELIVERED', 2000)).status, 200); assert.equal(item.status, 'delivered');
    assert.equal((await post('SENT', 3000)).status, 200); assert.equal(item.status, 'delivered');
    assert.equal((await post('READ', 4000)).status, 200); assert.equal(item.status, 'read');
    assert.equal((await post('FAILED', 5000)).status, 200); assert.equal(item.status, 'read');
    assert.equal((await post('READ', 3000)).status, 200); assert.equal(item.providerEventAt.getTime(), 4000);
    assert.equal((await post('READ', 6000, callbackSignature(workspaceId, messageId, secret), workspaceId, 'wrong-id')).status, 409);
    assert.equal((await post('UNKNOWN', 7000)).status, 400);
    item = { ...item, status: 'unknown', providerEventAt: undefined, error: { message: 'Unconfirmed request' } };
    assert.equal((await post('SENT', 8000)).status, 200); assert.equal(item.status, 'sent'); assert.equal(item.error, undefined);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    Message.findOne = originals.findOne; Message.updateOne = originals.updateOne; WalletEntry.updateOne = originals.settle;
    if (previousSecret === undefined) delete process.env.SMARTPING_WEBHOOK_SECRET; else process.env.SMARTPING_WEBHOOK_SECRET = previousSecret;
  }
});
