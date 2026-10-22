const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseService } = require('../dist/services/database.service');
const { Client } = require('pg');

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

test(
  'real PostgreSQL commits bounded writes, rolls back oversized results, and enforces the local ceiling',
  { skip: !databaseUrl || process.env.DATAMCP_TEST_WRITE !== '1' },
  async () => {
    const client = new Client({ connectionString: databaseUrl });
    const writable = new DatabaseService(databaseUrl);
    const capped = new DatabaseService(databaseUrl, true);
    await client.connect();
    try {
      await client.query('CREATE TABLE datamcp_agent_write_probe (id integer PRIMARY KEY, payload text)');
      await client.query("INSERT INTO datamcp_agent_write_probe SELECT n, 'original' FROM generate_series(1, 2000) n");

      const update = await writable.executeQuery({
        queryId: 'write-returning',
        sql: "UPDATE datamcp_agent_write_probe SET payload = 'changed' RETURNING id, payload",
        maxRows: 100,
        readOnly: false,
      });
      assert.equal(update.success, true, update.error);
      assert.equal(update.rowCount, 2000);
      assert.equal(update.rows.length, 100);
      assert.equal(update.truncated, true);
      const count = await client.query("SELECT count(*)::int AS total FROM datamcp_agent_write_probe WHERE payload = 'changed'");
      assert.equal(count.rows[0].total, 2000);

      const schema = await writable.extractSchema({ requestId: 'write-schema' });
      assert.equal(schema.success, true, schema.error);
      const table = schema.schema.tables.find((item) => item.name === 'datamcp_agent_write_probe');
      assert.deepEqual(table.privileges, {
        select: true,
        insert: true,
        update: true,
        delete: true,
      });

      const oversized = await writable.executeQuery({
        queryId: 'write-oversized',
        sql: "UPDATE datamcp_agent_write_probe SET payload = repeat('x', 600000) WHERE id = 1 RETURNING payload",
        maxRows: 100,
        readOnly: false,
      });
      assert.equal(oversized.success, false);
      assert.match(oversized.error, /response size limit/);
      const unchanged = await client.query('SELECT payload FROM datamcp_agent_write_probe WHERE id = 1');
      assert.equal(unchanged.rows[0].payload, 'changed');

      const forbidden = await capped.executeQuery({
        queryId: 'local-ceiling',
        sql: "UPDATE datamcp_agent_write_probe SET payload = 'forbidden' WHERE id = 1 RETURNING id",
        readOnly: false,
      });
      assert.equal(forbidden.success, false);
      assert.match(forbidden.error, /Read-only tunnel queries/);
    } finally {
      await client.query('DROP TABLE IF EXISTS datamcp_agent_write_probe');
      await client.end();
      await writable.closeAll();
      await capped.closeAll();
    }
  },
);
