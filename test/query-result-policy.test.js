const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  boundReadQuery,
  capAgentRows,
  resolveMaxRows,
} = require('../dist/services/query-result-policy');

test('clamps untrusted requested row limits', () => {
  assert.equal(resolveMaxRows(undefined), 100);
  assert.equal(resolveMaxRows(0), 100);
  assert.equal(resolveMaxRows(Number.NaN), 100);
  assert.equal(resolveMaxRows(12.5), 100);
  assert.equal(resolveMaxRows(50_000), 10_000);
  assert.equal(resolveMaxRows(50), 50);
});

test('puts the row limit outside complex read queries', () => {
  const queries = [
    'SELECT * FROM users LIMIT 1000000',
    "SELECT 'LIMIT 1000000' AS label FROM users",
    'SELECT * FROM (SELECT * FROM users LIMIT 1000000) nested',
    'SELECT id FROM a UNION ALL SELECT id FROM b',
    'WITH RECURSIVE nums AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM nums WHERE n < 1000) SELECT * FROM nums',
    'SELECT * FROM users ORDER BY created_at DESC;',
    'VALUES (1), (2), (3)',
    'SELECT 1; -- trailing comment',
    'SELECT 1; /* trailing comment */',
  ];
  for (const sql of queries) {
    const bounded = boundReadQuery(sql, 100);
    assert.match(bounded, /^SELECT \* FROM \(/);
    assert.match(bounded, /\) AS datamcp_result LIMIT 101$/);
  }
});

test('rejects non-read queries in read-only mode', () => {
  assert.throws(() => boundReadQuery('UPDATE users SET admin = true', 100));
  assert.throws(() => boundReadQuery('DELETE FROM users', 100));
});

test('caps row count and UTF-8 byte count before the agent replies', () => {
  assert.deepEqual(capAgentRows([{ id: 1 }, { id: 2 }, { id: 3 }], 2), {
    rows: [{ id: 1 }, { id: 2 }],
    truncated: true,
  });
  const largeRow = { payload: 'ю'.repeat(300_000) };
  assert.deepEqual(capAgentRows([{ id: 1 }, largeRow], 100), {
    rows: [{ id: 1 }],
    truncated: true,
  });
  assert.throws(() => capAgentRows([{ payload: 'x'.repeat(600_000) }], 100));
  assert.deepEqual(capAgentRows([{ id: 1 }, { id: 2 }], 2), {
    rows: [{ id: 1 }, { id: 2 }],
    truncated: false,
  });
});
