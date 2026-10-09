import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/lib/workspaceExpiry.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
vm.runInNewContext(output.outputText, { module, exports: module.exports, Date });
const { expiryInputValue, expiryPayload } = module.exports;
test('expiry edits preserve the exact instant including local timezone and milliseconds', () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ['Asia/Kolkata', 'UTC', 'America/New_York']) {
      process.env.TZ = timezone;
      for (const instant of ['2026-10-09T00:00:00.000Z','2026-11-09T18:29:59.123Z','2026-03-08T07:15:00.000Z']) assert.equal(expiryPayload(expiryInputValue(instant)), instant, timezone);
    }
    process.env.TZ = 'Asia/Kolkata';
    assert.equal(expiryInputValue('2026-10-09T00:00:00.000Z'), '2026-10-09T05:30:00.000');
    assert.equal(expiryPayload('2026-11-09T23:59'), '2026-11-09T18:29:00.000Z');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('empty expiry remains unlimited and invalid dates cannot silently roll over', () => {
  assert.equal(expiryInputValue(null), '');
  assert.equal(expiryPayload(''), null);
  for (const value of ['not-a-date','2026-02-30T12:00','2026-11-09','2026-11-09T24:00','2026-11-09T23:60']) assert.throws(() => expiryPayload(value), /valid expiry/);
});
