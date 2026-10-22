const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseService } = require('../dist/services/database.service');

const databaseUrl = process.env.DATAMCP_TEST_DATABASE_URL;

test(
  'real PostgreSQL caps complex query results before tunnel delivery',
  { skip: !databaseUrl },
  async () => {
  const database = new DatabaseService(databaseUrl, true);
  try {
    const queries = [
      'SELECT * FROM generate_series(1, 5000) n LIMIT 5000',
      'SELECT * FROM (SELECT * FROM generate_series(1, 5000) n LIMIT 5000) nested',
      'WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 5000) SELECT v FROM n',
      'SELECT * FROM generate_series(1, 2500) n UNION ALL SELECT * FROM generate_series(2501, 5000) n',
      'SELECT n, row_number() OVER (ORDER BY n DESC) FROM generate_series(1, 5000) n ORDER BY n DESC',
      "SELECT n, 'LIMIT 5000' label FROM generate_series(1, 5000) n",
      'SELECT * FROM generate_series(1, 5000) n; -- trailing comment',
    ];

    for (const [index, sql] of queries.entries()) {
      const result = await database.executeQuery({
        queryId: `case-${index}`,
        sql,
        params: [],
        maxRows: 100,
        readOnly: true,
      });
      assert.equal(result.success, true, `${sql}: ${result.error}`);
      assert.equal(result.rows.length, 100, sql);
      assert.equal(result.truncated, true, sql);
    }

    const parameterized = await database.executeQuery({
      queryId: 'parameterized',
      sql: 'SELECT $1::int AS value FROM generate_series(1, 5000)',
      params: [7],
      maxRows: 100,
      readOnly: true,
    });
    assert.equal(parameterized.success, true, parameterized.error);
    assert.equal(parameterized.rows.length, 100);
    assert.equal(parameterized.rows[0].value, 7);

    const oversized = await database.executeQuery({
      queryId: 'oversized',
      sql: "SELECT repeat('ю', 300000) AS payload",
      params: [],
      maxRows: 100,
      readOnly: true,
    });
    assert.equal(oversized.success, false);
    assert.match(oversized.error, /response size limit/);
  } finally {
    await database.closeAll();
  }
  },
);
