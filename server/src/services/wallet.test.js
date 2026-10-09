import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import { Contact, Message } from '../models/Domain.js';
import { TestWallet, WalletConfig, WalletEntry } from '../models/Wallet.js';
import { ACTIVITY_PRICES, MAX_WALLET_PAISE, validateWalletAdjustment, validateWalletConfig } from './walletConfig.js';
import { adjustTestWallet, chargeActivity, demoWalletActivity, ensureTestWallet, persistMeteredMessage, refundRejectedMessage, settleMessageCharge, walletTransaction } from './wallet.js';
import { createWithCapacity } from './capacity.js';
import { walletChargeReceipt } from './walletReceipts.js';

test('test prices and adjustments reject forged modes, invalid amounts and activities', () => {
  assert.deepEqual(validateWalletConfig({ deductionsEnabled: false, prices: { contacts: 0, messages: 75 }, mode: 'live', currency: 'USD', balancePaise: 999999 }), { deductionsEnabled: false, prices: { contacts: 0, messages: 75 } });
  for (const body of [{ deductionsEnabled: 'false' }, { prices: { unknown: 1 } }, { prices: { contacts: -1 } }, { prices: { messages: 0.1 } }, { prices: { contacts: '1' } }, { prices: [] }, { openingMinPaise: null }, { openingMaxPaise: 100000001 }]) assert.throws(() => validateWalletConfig(body));
  const payload = { direction: 'credit', amountPaise: 10000, reason: ' Test top-up ', idempotencyKey: 'test-key-123' };
  assert.equal(validateWalletAdjustment(payload).reason, 'Test top-up');
  for (const body of [{ ...payload, direction: 'setBalance' }, { ...payload, amountPaise: 0 }, { ...payload, amountPaise: -1 }, { ...payload, amountPaise: 1.5 }, { ...payload, reason: '' }, { ...payload, idempotencyKey: 'tiny' }]) assert.throws(() => validateWalletAdjustment(body));
  assert.ok(new TestWallet({ workspace: '507f1f77bcf86cd799439011', balancePaise: -1 }).validateSync());
  assert.ok(new TestWallet({ workspace: '507f1f77bcf86cd799439011', balancePaise: 1.5 }).validateSync());
  assert.ok(new TestWallet({ workspace: '507f1f77bcf86cd799439011', balancePaise: 1, mode: 'live' }).validateSync());
  assert.ok(new WalletConfig({ prices: { messages: 1.5 } }).validateSync());
});

test('test wallet ledger is atomic, idempotent and isolated between businesses', async t => {
  const workspace = '507f1f77bcf86cd799439011', other = '507f1f77bcf86cd799439012', actor = '507f1f77bcf86cd799439013', recordId = '507f1f77bcf86cd799439014';
  let store, ended = 0, gate = Promise.resolve();
  const reset = () => { store = { wallets: [], entries: [], messages: [], records: [], customPlans: {}, config: { openingMinPaise: 1000, openingMaxPaise: 1000 }, recordFailure: false }; };
  const clone = value => JSON.parse(JSON.stringify(value));
  const originals = []; const mock = (object, key, fn) => { originals.push([object, key, object[key]]); object[key] = fn; };
  const session = {
    withTransaction: async fn => {
      const previous = gate; let release; gate = new Promise(resolve => { release = resolve; }); await previous;
      const snapshot = clone(store);
      try { await fn(); } catch (error) { store = snapshot; throw error; } finally { release(); }
    }, endSession: async () => { ended++; },
  };
  const query = fn => { const q = { session: passed => { assert.equal(passed, session); return q; }, lean: async () => fn(), then: (resolve, reject) => Promise.resolve().then(fn).then(resolve, reject) }; return q; };
  const matches = (item, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === 'balancePaise') return (value.$gte === undefined || item[key] >= value.$gte) && (value.$lte === undefined || item[key] <= value.$lte);
    return String(item[key]) === String(value);
  });
  const create = key => async (items, options) => {
    assert.equal(options.session, session); const rows = clone(items);
    if (key === 'entries') for (const item of rows) assert.ok(!store.entries.some(row => row.workspace === item.workspace && row.operationKey === item.operationKey), 'ledger operation keys are unique');
    for (const item of rows) { item._id ||= new mongoose.Types.ObjectId().toString(); item.status ||= 'complete'; item.createdAt = new Date().toISOString(); store[key].push(item); }
    return rows;
  };
  mock(mongoose, 'startSession', async () => session);
  mock(WalletConfig, 'findOne', () => query(() => clone(store.config)));
  mock(Workspace, 'exists', filter => query(() => [workspace, other].includes(String(filter._id))));
  mock(Workspace, 'findOneAndUpdate', async (filter, update, options) => { assert.equal(options.session, session); assert.equal(update.$inc.capacityVersion, 1); return [workspace, other].includes(String(filter._id)) ? { _id: filter._id, limits: { contacts: null }, customPlan: store.customPlans[String(filter._id)] } : null; });
  mock(TestWallet, 'findOne', filter => query(() => store.wallets.find(item => matches(item, filter)) || null));
  mock(TestWallet, 'create', create('wallets'));
  mock(TestWallet, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(options.session, session); const item = store.wallets.find(item => matches(item, filter)); if (!item) return null;
    item.balancePaise += update.$inc.balancePaise; assert.ok(item.balancePaise >= 0 && item.balancePaise <= MAX_WALLET_PAISE); return { ...item };
  });
  mock(WalletEntry, 'findOne', filter => query(() => clone(store.entries.find(item => matches(item, filter)) || null)));
  mock(WalletEntry, 'create', create('entries'));
  mock(WalletEntry, 'findOneAndUpdate', async (filter, update, options) => { assert.equal(options.session, session); const item = store.entries.find(row => matches(row, filter)); if (!item) return null; Object.assign(item, update.$set); return { ...item }; });
  mock(WalletEntry, 'updateOne', async (filter, update) => { const item = store.entries.find(row => matches(row, filter)); if (item) Object.assign(item, update.$set); return { matchedCount: item ? 1 : 0 }; });
  mock(Message, 'create', create('messages'));
  mock(Message, 'findOne', filter => query(() => store.messages.find(row => matches(row, filter)) || null));
  mock(Contact, 'create', async (items, options) => { if (store.recordFailure) throw new Error('Record validation failed'); return create('records')(items, options); });
  const charge = (activity = 'contacts', id = recordId, business = workspace, reserved = false) => walletTransaction(passed => chargeActivity({ workspace: business, activity, recordId: id, actor, session: passed, reserved }));
  const adjustment = (changes = {}) => adjustTestWallet(workspace, { direction: 'credit', amountPaise: 500, reason: 'Test adjustment', idempotencyKey: 'adjustment-test-key', ...changes }, actor);
  const message = () => new Message({ _id: recordId, workspace, conversation: other, sender: actor, direction: 'outbound', type: 'template', idempotencyKey: 'message-test-key', status: 'queued' });
  try {
    await t.test('opening credits are random within bounds, persisted once and never refilled on reads', async () => {
      reset(); store.config = { openingMinPaise: 500000, openingMaxPaise: 1000000 };
      const first = await ensureTestWallet(workspace); assert.ok(first.balancePaise >= 500000 && first.balancePaise <= 1000000);
      store.config.openingMinPaise = 10; store.config.openingMaxPaise = 10;
      const second = await ensureTestWallet(workspace); assert.equal(second.balancePaise, first.balancePaise); assert.equal(store.wallets.length, 1); assert.equal(store.entries.length, 1);
      assert.equal(store.entries[0].operationKey, 'opening:test-v1'); assert.equal(store.entries[0].deltaPaise, first.balancePaise);
    });
    await t.test('each of the eleven activities charges its configured integer-paise price', async () => {
      reset(); store.config.openingMinPaise = 100000; store.config.openingMaxPaise = 100000;
      for (const [activity, price] of Object.entries(ACTIVITY_PRICES)) { const result = await charge(activity, new mongoose.Types.ObjectId()); assert.equal(result.deltaPaise, -price); assert.equal(result.unitPricePaise, price); }
      assert.equal(store.wallets[0].balancePaise, 100000 - Object.values(ACTIVITY_PRICES).reduce((a, b) => a + b, 0)); assert.equal(store.entries.length, 12);
    });
    await t.test('same record cannot be charged twice, even if its price changes', async () => {
      reset(); const first = await charge(); store.config.prices = { contacts: 999 };
      const duplicate = await charge(); assert.equal(duplicate._id, first._id); assert.equal(store.wallets[0].balancePaise, 900); assert.equal(store.entries.length, 2);
      assert.equal(walletChargeReceipt(first).chargedPaise, 100); assert.equal(walletChargeReceipt(duplicate), null);
    });
    await t.test('insufficient funds and negative balances are blocked', async () => {
      reset(); store.config.prices = { contacts: 1001 };
      await assert.rejects(charge(), error => error.status === 402); assert.equal(store.entries.length, 0); assert.equal(store.wallets.length, 0);
      await ensureTestWallet(workspace);
      await assert.rejects(adjustment({ direction: 'debit', amountPaise: 1001 }), error => error.status === 409); assert.equal(store.wallets[0].balancePaise, 1000);
    });
    await t.test('billing can be paused and zero prices remain free', async () => {
      reset(); store.config.deductionsEnabled = false; assert.equal(await charge(), null); assert.equal(store.entries.length, 0);
      store.config.deductionsEnabled = true; store.config.prices = { contacts: 0 };
      const entry = await charge(); assert.equal(entry.deltaPaise, 0); assert.equal(store.wallets[0].balancePaise, 1000);
    });
    await t.test('charges in one business never alter another business wallet', async () => {
      reset(); await ensureTestWallet(other); await charge(); assert.equal(store.wallets.find(row => row.workspace === other).balancePaise, 1000); assert.equal(store.wallets.find(row => row.workspace === workspace).balancePaise, 900);
    });
    await t.test('negotiated rates affect future charges in one business; restore uses defaults and preserves history', async () => {
      reset(); await ensureTestWallet(workspace); await ensureTestWallet(other);
      store.customPlans[workspace] = { activityPricesPaise: { contacts: 25, campaigns: 0 } };
      const first = await charge('contacts', recordId); assert.equal(first.unitPricePaise,25); assert.equal(first.deltaPaise,-25);
      const second = await charge('contacts',recordId,other); assert.equal(second.unitPricePaise,100); assert.equal(store.wallets.find(row=>row.workspace===other).balancePaise,900);
      const free = await charge('campaigns',new mongoose.Types.ObjectId()); assert.equal(free.deltaPaise,0);
      store.customPlans[workspace].activityPricesPaise.contacts=50;
      assert.equal((await charge('contacts',recordId)).unitPricePaise,25);
      assert.equal((await charge('contacts',new mongoose.Types.ObjectId())).unitPricePaise,50);
      delete store.customPlans[workspace];
      assert.equal((await charge('contacts',new mongoose.Types.ObjectId())).unitPricePaise,100);
      assert.equal(store.entries.find(entry=>entry._id===first._id).unitPricePaise,25); assert.equal(store.config.prices,undefined);
    });
    await t.test('message reservation and rejection refund use the recorded custom rate', async () => {
      reset(); store.customPlans[workspace]={activityPricesPaise:{messages:20}};
      await persistMeteredMessage(message()); assert.equal(store.wallets[0].balancePaise,980); assert.equal(store.entries.at(-1).unitPricePaise,20);
      store.customPlans[workspace].activityPricesPaise.messages=99;
      assert.equal(await refundRejectedMessage(workspace,recordId),true); assert.equal(store.wallets[0].balancePaise,1000); assert.equal(store.entries.at(-1).deltaPaise,20);
    });
    await t.test('administrator adjustments are repeat-safe and preserve attribution', async () => {
      reset(); const first = await adjustment(); const duplicate = await adjustment(); assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true); assert.equal(store.wallets[0].balancePaise, 1500); assert.equal(store.entries.length, 2); assert.equal(first.entry.actor, actor);
      await assert.rejects(adjustment({ amountPaise: 600 }), error => error.status === 409); assert.equal(store.wallets[0].balancePaise, 1500);
    });
    await t.test('creation failure rolls back its deduction and ledger entries', async () => {
      reset(); await ensureTestWallet(workspace); store.recordFailure = true;
      const req = { workspace: { _id: workspace }, user: { _id: actor, role: 'agent' } };
      await assert.rejects(createWithCapacity(req, 'contacts', Contact, { workspace, name: 'Invalid' }), /validation failed/);
      assert.equal(store.wallets[0].balancePaise, 1000); assert.equal(store.entries.length, 1); assert.equal(store.records.length, 0);
      assert.equal(req.walletCharges, undefined);
      store.recordFailure = false; await createWithCapacity(req, 'contacts', Contact, { workspace, name: 'Valid' });
      assert.equal(store.wallets[0].balancePaise, 900); assert.equal(store.records.length, 1); assert.equal(store.entries.at(-1).recordId, store.records[0]._id);
      assert.equal(req.walletCharges.length, 1); assert.equal(req.walletCharges[0].chargedPaise, 100); assert.equal(req.walletCharges[0].balanceAfterPaise, 900);
    });
    await t.test('parallel usage cannot spend the same final credits twice', async () => {
      reset(); store.config.openingMinPaise = 100; store.config.openingMaxPaise = 100; await ensureTestWallet(workspace);
      const results = await Promise.allSettled([charge('contacts', new mongoose.Types.ObjectId()), charge('contacts', new mongoose.Types.ObjectId())]);
      assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); assert.equal(results.filter(item => item.status === 'rejected' && item.reason.status === 402).length, 1);
      assert.equal(store.wallets[0].balancePaise, 0); assert.equal(store.entries.filter(row => row.kind === 'activity').length, 1);
    });
    await t.test('message reserve and message creation commit together', async () => {
      reset(); const saved = await persistMeteredMessage(message()); assert.equal(saved._id, recordId); assert.equal(store.messages.length, 1); assert.equal(store.wallets[0].balancePaise, 925); assert.equal(store.entries.at(-1).status, 'reserved');
      await settleMessageCharge(workspace, recordId); await settleMessageCharge(workspace, recordId); assert.equal(store.entries.at(-1).status, 'complete'); assert.equal(store.wallets[0].balancePaise, 925);
    });
    await t.test('explicit rejection refunds original reserved price once, not the current price', async () => {
      reset(); await persistMeteredMessage(message()); store.config.prices = { messages: 999 };
      assert.equal(await refundRejectedMessage(workspace, recordId), true); assert.equal(await refundRejectedMessage(workspace, recordId), false);
      assert.equal(store.wallets[0].balancePaise, 1000); assert.equal(store.entries.filter(row => row.kind === 'refund').length, 1); assert.equal(store.entries.at(-1).deltaPaise, 75);
      assert.equal(store.entries.find(row => row.kind === 'activity').status, 'refunded');
    });
    await t.test('recorded provider acceptance or callbacks prevent rejection refunds', async () => {
      reset(); await persistMeteredMessage(message()); store.messages[0].providerMessageId = 'provider-accepted';
      assert.equal(await refundRejectedMessage(workspace, recordId), false); assert.equal(store.wallets[0].balancePaise, 925);
      delete store.messages[0].providerMessageId; store.messages[0].providerEventAt = new Date().toISOString();
      assert.equal(await refundRejectedMessage(workspace, recordId), false); assert.equal(store.entries.filter(row => row.kind === 'refund').length, 0);
    });
    await t.test('ledger deltas reconcile with wallet balance after charges and corrections', async () => {
      reset(); await charge(); await adjustment(); await adjustment({ direction: 'debit', amountPaise: 123, idempotencyKey: 'different-key-123' });
      assert.equal(store.entries.filter(row => row.workspace === workspace).reduce((total, row) => total + row.deltaPaise, 0), store.wallets[0].balancePaise);
      assert.equal(store.entries.at(-1).balanceAfterPaise, store.wallets[0].balancePaise);
    });
    await t.test('demo charges server-configured prices without creating messages or business records', async () => {
      reset(); store.config.openingMinPaise = 100000; store.config.openingMaxPaise = 100000;
      for (const [activity, price] of Object.entries(ACTIVITY_PRICES)) {
        const result = await demoWalletActivity(workspace, { activity, idempotencyKey: 'demo-' + activity + '-key', amountPaise: 0, workspace: other }, actor);
        assert.equal(result.chargedPaise, price); assert.equal(result.walletCharges.length, 1); assert.equal(result.walletCharges[0].workspace, workspace); assert.equal(result.walletCharges[0].activity, activity);
      }
      assert.equal(store.messages.length, 0); assert.equal(store.records.length, 0);
      assert.ok(store.entries.filter(row => row.kind === 'activity').every(row => row.reason.includes('No provider action or business record')));
      assert.equal(store.entries.reduce((total, row) => total + row.deltaPaise, 0), store.wallets[0].balancePaise);
    });
    await t.test('demo retries do not deduct again and conflicting request keys are rejected', async () => {
      reset(); const payload = { activity: 'calls', idempotencyKey: 'demo-repeat-key' };
      const results = await Promise.all([demoWalletActivity(workspace, payload, actor), demoWalletActivity(workspace, payload, actor)]);
      assert.equal(results.filter(row => row.duplicate).length, 1); assert.equal(results.filter(row => row.walletCharges.length).length, 1);
      const duplicate = results.find(row => row.duplicate); assert.equal(duplicate.chargedPaise, 0); assert.equal(duplicate.balanceAfterPaise, 500);
      assert.equal(store.entries.length, 2); assert.equal(store.wallets[0].balancePaise, 500);
      await assert.rejects(demoWalletActivity(workspace, { ...payload, activity: 'messages' }, actor), error => error.status === 409);
    });
    await t.test('demo paused/free/invalid/insufficient requests do not claim a deduction', async () => {
      reset(); store.config.deductionsEnabled = false;
      let result = await demoWalletActivity(workspace, { activity: 'calls', idempotencyKey: 'demo-paused-key' }, actor);
      assert.equal(result.chargedPaise, 0); assert.deepEqual(result.walletCharges, []); assert.match(result.reason, /paused/); assert.equal(store.entries.length, 1);
      store.config.deductionsEnabled = true; store.config.prices = { calls: 0 };
      result = await demoWalletActivity(workspace, { activity: 'calls', idempotencyKey: 'demo-free-key' }, actor);
      assert.equal(result.chargedPaise, 0); assert.deepEqual(result.walletCharges, []); assert.match(result.reason, /free/); assert.equal(store.wallets[0].balancePaise, 1000);
      store.config.prices.calls = 1001;
      await assert.rejects(demoWalletActivity(workspace, { activity: 'calls', idempotencyKey: 'demo-overdraw-key' }, actor), error => error.status === 402);
      for (const payload of [{ activity: 'unknown', idempotencyKey: 'demo-invalid-key' }, { activity: 'calls', idempotencyKey: 'tiny' }, {}]) await assert.rejects(demoWalletActivity(workspace, payload, actor), error => error.status === 400);
      assert.equal(store.wallets[0].balancePaise, 1000); assert.equal(store.entries.length, 2);
      store.wallets[0].mode = 'live'; await assert.rejects(demoWalletActivity(workspace, { activity: 'calls', idempotencyKey: 'demo-live-key' }, actor), error => error.status === 409);
    });
    assert.ok(ended > 0);
  } finally { for (const [object, key, original] of originals.reverse()) object[key] = original; }
});
