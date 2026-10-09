import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/lib/adminDeletion.ts', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
const api = module.exports;
const id = '507f1f77bcf86cd799439011';
const preview = changes => ({ resource: 'users', scope: 'all', token: 'signed-preview', confirmation: 'DELETE USERS', targets: [{ id, name: 'Agent' }], protected: [], matchedCount: 1, ...changes });
test('selected deletion requires distinct valid IDs and delete all does not send search filters', () => {
  assert.equal(JSON.stringify(api.buildDeletionPreviewPayload('users', 'all')), '{"resource":"users","scope":"all"}');
  for (const ids of [[], ['bad'], [id, id]]) assert.throws(() => api.buildDeletionPreviewPayload('users', 'selected', ids));
  assert.throws(() => api.buildDeletionPreviewPayload('users', 'all', [id]));
});
test('confirmation is exact and execute sends only the signed snapshot, never client-chosen IDs', () => {
  const value = api.readDeletionPreview(preview(), 'users', 'all');
  assert.throws(() => api.createDeletionExecutePayload(value, 'delete users'));
  assert.deepEqual(Object.keys(api.createDeletionExecutePayload(value, 'DELETE USERS')).sort(), ['confirmation', 'token']);
  assert.throws(() => api.createDeletionExecutePayload(null, 'DELETE USERS'));
});
test('invalid counts, duplicates and protected overlaps cannot authorize a deletion', () => {
  for (const changes of [{ matchedCount: 2 }, { matchedCount: 0 }, { token: '' }, { confirmation: 'DELETE WORKSPACES' }, { protected: [{ id, name: 'Owner', reason: 'Protected' }], matchedCount: 2 }]) assert.throws(() => api.readDeletionPreview(preview(changes), 'users', 'all'));
});
test('large valid signed snapshots fit the backend token allowance', () => {
  assert.equal(api.readDeletionPreview(preview({ token: 'a'.repeat(50000) }), 'users', 'all').token.length, 50000);
  assert.throws(() => api.readDeletionPreview(preview({ token: 'a'.repeat(65537) }), 'users', 'all'));
});
test('no eligible target disables confirmation and response counts are validated', () => {
  const value = api.readDeletionPreview(preview({ targets: [], matchedCount: 0 }), 'users', 'all');
  assert.ok(api.validateDeletionConfirmation(value, 'DELETE USERS'));
  assert.throws(() => api.readDeletionResult({ resource: 'users', deletedCount: 1, protectedCount: 1, protected: [] }, 'users'));
});
