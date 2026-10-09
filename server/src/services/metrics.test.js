import test from 'node:test';
import assert from 'node:assert/strict';
import { averageResponseTime, csv, messageMetrics } from './metrics.js';

test('delivery totals exclude incoming messages, queued messages, and failures', () => {
  assert.deepEqual(messageMetrics([
    { direction: 'inbound', status: 'read' },
    ...['queued', 'failed', 'sent', 'delivered', 'read'].map(status => ({ direction: 'outbound', status })),
  ]), { sent: 3, delivered: 2, read: 1 });
});

test('response time pairs the first unanswered inbound with an actual sent reply per conversation', () => {
  const message = (conversation, direction, seconds, status = 'sent') => ({ conversation, direction, status, createdAt: new Date(seconds * 1000) });
  assert.equal(averageResponseTime([
    message('a', 'inbound', 0), message('a', 'inbound', 10), message('b', 'inbound', 20),
    message('a', 'outbound', 30, 'failed'), message('a', 'outbound', 60),
    message('b', 'outbound', 140), message('a', 'outbound', 200), message('c', 'inbound', 250),
  ]), 90000);
  assert.equal(averageResponseTime([message('c', 'inbound', 1)]), null);
});

test('CSV quotes values and protects spreadsheet formulas', () => {
  assert.equal(csv([['A "quote"', '=SUM(1)', '+91999', 'a,b']]), '"A ""quote""","\'=SUM(1)","\'+91999","a,b"');
});

test('CSV neutralizes whitespace-prefixed formulas and leading line control characters', () => {
  assert.equal(csv([['  =SUM(1)', '\n=NOW()', 'ordinary text']]), '"\'  =SUM(1)","\'\n=NOW()","ordinary text"');
});
