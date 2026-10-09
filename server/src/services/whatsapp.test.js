import test from 'node:test';
import assert from 'node:assert/strict';
import { Contact, Conversation, Message } from '../models/Domain.js';
import { SmartpingError } from './smartping.js';
import { sendTemplate } from './whatsapp.js';
import { attachWalletCharge, markNewWalletCharge } from './walletReceipts.js';
import { WhatsAppNumber } from '../models/Business.js';

// In-memory model substitutes: these tests never connect to MongoDB or Smartping.
test('template dispatch records, consent, idempotency and uncertain outcomes', async t => {
  const workspace = '507f1f77bcf86cd799439011';
  const conversation = { _id: '507f1f77bcf86cd799439012', contact: '507f1f77bcf86cd799439013' };
  const template = { templateId: 'approved-template', parameterValues: { 0: 'Customer' } };
  const sender = '507f1f77bcf86cd799439014';
  const env = { SMARTPING_WORKSPACE_ID: workspace, SMARTPING_JOURNEY_ID: 'journey', SMARTPING_FROM: '+919876543210', SMARTPING_AUTH_TOKEN: 'test-only-token', SMARTPING_CALLBACK_BASE_URL: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originals = { init: Message.init, findOne: Message.findOne, findById: Message.findById, updateOne: Message.updateOne, save: Message.prototype.save, contact: Contact.findOne, conversation: Conversation.updateOne };
  const originalNumber = WhatsAppNumber.findOne;
  const originalContactFind=Contact.find;
  Contact.find=()=>({select:()=>({lean:async()=>[]})});
  let disconnected = false;
  WhatsAppNumber.findOne = async () => disconnected ? { provider: 'smartping', phone: env.SMARTPING_FROM, disconnectedAt: new Date() } : null;
  let records = [], consent = true, providerCalls = 0, persistenceFailure = false, onSend = null, reserves = 0, settlements = 0, refunds = 0;
  const reset = () => { records = []; consent = true; providerCalls = 0; persistenceFailure = false; onSend = null; reserves = 0; settlements = 0; refunds = 0; };
  Message.init = async () => Message;
  Message.findOne = async filter => records.find(item => String(item.workspace) === String(filter.workspace) && item.idempotencyKey === filter.idempotencyKey) || null;
  Message.findById = async id => records.find(item => String(item._id) === String(id));
  Message.prototype.save = async function () { this.createdAt = new Date(); records.push(this); return this; };
  Message.updateOne = async (filter, update) => {
    if (persistenceFailure && update.$set.providerMessageId) throw new Error('Simulated persistence failure');
    const item = records.find(record => String(record._id) === String(filter._id) && String(record.workspace) === String(filter.workspace));
    if (!item || (filter.status && item.status !== filter.status) || (filter.providerEventAt && item.providerEventAt) || (filter.$or && item.providerMessageId && item.providerMessageId !== filter.$or[1].providerMessageId)) return { matchedCount: 0 };
    item.set(update.$set); return { matchedCount: 1 };
  };
  Contact.findOne = async filter => filter.workspace === workspace && String(filter._id) === conversation.contact ? { phone: '+919123456789', subscribed: consent, optInAt: new Date('2025-01-01'), optInSource: 'test' } : null;
  Conversation.updateOne = async () => ({ matchedCount: 1 });
  const providerClient = { send: async payload => {
    providerCalls++; assert.equal(records.length, 1, 'save the request before network activity');
    assert.equal(payload.to, '+919123456789');
    if (onSend) await onSend();
    return { id: 'provider-id' };
  } };
  const billing = { persist: async item => { reserves++; const saved = await item.save(); return attachWalletCharge(saved, markNewWalletCharge({ _id: '507f1f77bcf86cd799439019', workspace, activity: 'messages', kind: 'activity', status: 'reserved', deltaPaise: -75, balanceAfterPaise: 999925 })); }, settle: async () => { settlements++; }, refund: async () => { refunds++; } };
  const dispatch = (changes = {}) => sendTemplate({ workspace, conversation, sender, template, idempotencyKey: 'test-request-123', providerClient, policyChecker: async () => {}, billing, ...changes });
  try {
    await t.test('acceptance is persisted once, not assumed delivered; same request never sends twice', async () => {
      reset(); const result = await dispatch(); assert.equal(result.item.status, 'queued'); assert.equal(result.item.providerMessageId, 'provider-id');
      const duplicate = await dispatch(); assert.equal(duplicate.duplicate, true); assert.equal(providerCalls, 1);
      assert.equal(result.walletCharges[0].chargedPaise, 75); assert.deepEqual(duplicate.walletCharges, []);
      assert.equal(reserves, 1); assert.equal(settlements, 1); assert.equal(refunds, 0);
      await assert.rejects(dispatch({ template: { templateId: 'different' } }), error => error.status === 409); assert.equal(providerCalls, 1);
    });
    await t.test('a callback arriving before acceptance is not downgraded', async () => {
      reset(); onSend = () => records[0].set({ status: 'read', providerMessageId: 'provider-id', providerEventAt: new Date() });
      const result = await dispatch(); assert.equal(result.item.status, 'read'); assert.equal(providerCalls, 1);
    });
    await t.test('workspace binding and opt-out prevent provider calls', async () => {
      reset(); consent = false; await assert.rejects(dispatch(), /opted out/); assert.equal(records.length, 0);
      await assert.rejects(dispatch({ workspace: '507f1f77bcf86cd799439015' }), /not configured/); assert.equal(providerCalls, 0);
    });
    await t.test('timeouts stay unknown and a repeated key never retries', async () => {
      reset(); onSend = () => { throw new SmartpingError('Unconfirmed request', 502, true); };
      await assert.rejects(dispatch(), error => error.uncertain); assert.equal(records[0].status, 'unknown');
      const replay = await dispatch(); assert.equal(replay.duplicate, true); assert.deepEqual(replay.walletCharges, []); assert.equal(providerCalls, 1);
      assert.equal(reserves, 1); assert.equal(settlements, 0); assert.equal(refunds, 0);
    });
    await t.test('disconnecting the sending number prevents all provider calls', async () => {
      reset(); disconnected = true;
      try { await assert.rejects(dispatch(), /disconnected/); assert.equal(providerCalls, 0); assert.equal(records.length, 0); }
      finally { disconnected = false; }
    });
    await t.test('explicit rejection is failed, while persistence failure is unknown', async () => {
      reset(); onSend = () => { throw new SmartpingError('Rejected request', 502); };
      await assert.rejects(dispatch(), /Rejected/); assert.equal(records[0].status, 'failed'); assert.equal(refunds, 1);
      const replay = await dispatch(); assert.equal(replay.duplicate, true); assert.deepEqual(replay.walletCharges, []); assert.equal(refunds, 1);
      reset(); persistenceFailure = true; await assert.rejects(dispatch(), error => error.uncertain); assert.equal(records[0].status, 'unknown'); assert.equal(providerCalls, 1); assert.equal(refunds, 0);
    });
    await t.test('a conflicting early callback cannot have its provider ID overwritten', async () => {
      reset(); onSend = () => records[0].set({ status: 'delivered', providerMessageId: 'different-provider-id', providerEventAt: new Date() });
      await assert.rejects(dispatch(), /correlated/); assert.equal(records[0].providerMessageId, 'different-provider-id'); assert.equal(records[0].status, 'delivered');
    });
    await t.test('insufficient wallet credits prevent a provider call or message persistence', async () => {
      reset(); await assert.rejects(dispatch({ billing: { ...billing, persist: async () => { throw new SmartpingError('Insufficient test wallet balance.', 402); } } }), error => error.status === 402);
      assert.equal(providerCalls, 0); assert.equal(records.length, 0); assert.equal(refunds, 0);
    });
  } finally {
    Message.init = originals.init; Message.findOne = originals.findOne; Message.findById = originals.findById; Message.updateOne = originals.updateOne; Message.prototype.save = originals.save;
    Contact.findOne = originals.contact; Conversation.updateOne = originals.conversation;
    WhatsAppNumber.findOne = originalNumber;
    Contact.find=originalContactFind;
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
