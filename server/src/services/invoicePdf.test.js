import test from 'node:test';
import assert from 'node:assert/strict';
import { generateInvoicePdf, invoicePdfData, invoicePdfFileName } from './invoicePdf.js';

const invoice = {
  _id: '507f1f77bcf86cd799439013', invoiceNumber: 'WABA-6AC3A2EE2388C88D28E337C2',
  workspace: { _id: '507f1f77bcf86cd799439012', name: 'Example business' },
  description: 'Workspace subscription', amount: 10000, currency: 'INR', status: 'Draft',
  createdAt: new Date('2026-10-05T00:00:00Z'), dueAt: new Date('2026-10-20T00:00:00Z'),
};

test('invoice PDF data comes from saved fields without inventing tax/payment information', () => {
  const data = invoicePdfData(invoice, { platformName: 'Example WABA', supportEmail: 'support@example.com' });
  assert.equal(data.number, invoice.invoiceNumber);
  assert.equal(data.workspace, invoice.workspace.name);
  assert.equal(data.total, 'INR 10,000.00');
  assert.equal(data.balance, 'Not payable');
  assert.equal(data.createdOn, '05 Oct 2026');
  assert.equal(data.dueOn, '20 Oct 2026');
  assert.deepEqual(data.support, ['support@example.com']);
  assert.equal(data.paymentReference, '');
  assert.equal(data.paidOn, '');
  assert.equal(invoice.status, 'Draft');
  assert.equal(invoice.amount, 10000);
});

test('paid/issued/void balances reflect stored status, not an assumed payment', () => {
  assert.equal(invoicePdfData({ ...invoice, status: 'Issued' }).balance, 'INR 10,000.00');
  const paid = invoicePdfData({ ...invoice, status: 'Paid', paidAt: '2026-10-06T00:00:00Z', paymentReference: 'BANK-REFERENCE' });
  assert.equal(paid.balance, 'INR 0.00'); assert.equal(paid.paymentReference, 'BANK-REFERENCE'); assert.equal(paid.paidOn, '06 Oct 2026');
  assert.equal(invoicePdfData({ ...invoice, status: 'Void' }).balance, 'Not payable');
  assert.equal(invoicePdfData({ ...invoice, amount: 0, status: 'Issued', currency: 'USD' }).total, 'USD 0.00');
  assert.equal(invoicePdfData({ ...invoice, currency: 'EUR', amount: 1250.25 }).total, 'EUR 1,250.25');
});

test('missing workspace/dates and invalid timezone are handled without fabricated values', () => {
  const data = invoicePdfData({ ...invoice, workspace: null, dueAt: undefined, createdAt: 'invalid' }, { defaultTimezone: 'Not/A-Timezone' });
  assert.equal(data.workspace, 'Workspace unavailable'); assert.equal(data.workspaceId, '');
  assert.equal(data.createdOn, 'Not set'); assert.equal(data.dueOn, 'Not set');
  assert.equal(invoicePdfData({ ...invoice, createdAt: '2026-10-04T23:30:00Z' }, { defaultTimezone: 'Asia/Kolkata' }).createdOn, '05 Oct 2026');
});

test('invalid saved invoice billing data is rejected rather than printed incorrectly', async () => {
  for (const fields of [{ amount: NaN }, { amount: Infinity }, { amount: -1 }, { amount: null }, { currency: 'GBP' }, { status: 'Unknown' }]) {
    assert.throws(() => invoicePdfData({ ...invoice, ...fields }), /invalid billing details/);
    await assert.rejects(generateInvoicePdf({ ...invoice, ...fields }), /invalid billing details/);
  }
});

test('attachment names cannot inject headers, directories or special extensions', () => {
  assert.equal(invoicePdfFileName(invoice), `${invoice.invoiceNumber}.pdf`);
  const unsafe = invoicePdfFileName({ invoiceNumber: '../../invoice\r\nContent-Type: text/html".html' });
  assert.match(unsafe, /^[a-zA-Z0-9_-]+\.pdf$/);
  assert.ok(!unsafe.includes('/') && !unsafe.includes('\r') && !unsafe.includes('\n'));
  assert.equal(invoicePdfFileName({}), 'invoice.pdf');
  assert.ok(invoicePdfFileName({ invoiceNumber: 'a'.repeat(500) }).length <= 104);
});

test('PDF renderer returns valid, embedded-font A4 bytes for every status without changing records', async () => {
  for (const status of ['Draft', 'Issued', 'Paid', 'Void']) {
    const saved = { ...invoice, status }, original = structuredClone(saved);
    const pdf = await generateInvoicePdf(saved);
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.toString('latin1'), /%%EOF/);
    assert.match(pdf.toString('latin1'), /\/FontFile2/);
    assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/);
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
    assert.deepEqual(saved, original);
  }
});

test('long descriptions and unbroken words paginate instead of clipping invoice content', async () => {
  const description = Array.from({ length: 90 }, (_, index) => `Line ${index + 1}`).join('\n');
  const pdf = await generateInvoicePdf({ ...invoice, description, status: 'Issued' });
  const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages >= 3, `Expected multiple pages, got ${pages}`);
  const unbroken = await generateInvoicePdf({ ...invoice, description: 'a'.repeat(1000), workspace: null });
  assert.equal(unbroken.subarray(0, 5).toString(), '%PDF-');
});

test('concurrent PDF downloads isolate invoice amounts, workspaces and buffers', async () => {
  const [first, second] = await Promise.all([generateInvoicePdf(invoice), generateInvoicePdf({ ...invoice, invoiceNumber: 'OTHER-INVOICE', workspace: { name: 'Other business' }, amount: 120 })]);
  assert.ok(!first.equals(second));
  assert.equal(first.subarray(0, 5).toString(), '%PDF-'); assert.equal(second.subarray(0, 5).toString(), '%PDF-');
});
