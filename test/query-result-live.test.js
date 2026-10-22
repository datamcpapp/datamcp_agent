const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseService } = require('../dist/services/database.service');
const { Client } = require('pg');
const { EventEmitter } = require('node:events');
const { AgentService } = require('../dist/services/agent.service');

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

    const byteBounded = await database.executeQuery({
      queryId: 'byte-bounded',
      sql: "SELECT repeat('x', 200000) AS payload FROM generate_series(1, 5)",
      maxRows: 100,
      readOnly: true,
    });
    assert.equal(byteBounded.success, true, byteBounded.error);
    assert.equal(byteBounded.rows.length, 2);
    assert.equal(byteBounded.truncated, true);

    const rowBounded = await database.executeQuery({
      queryId: 'row-bounded',
      sql: 'SELECT n FROM generate_series(1, 12000) n',
      maxRows: 50_000,
      readOnly: true,
    });
    assert.equal(rowBounded.success, true, rowBounded.error);
    assert.equal(rowBounded.rows.length, 10_000);
    assert.equal(rowBounded.truncated, true);
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
    const originalLabel = `write-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const changedLabel = `${originalLabel}-changed`;
    await client.connect();
    try {
      await client.query(
        'INSERT INTO private_probe (label) SELECT $1 FROM generate_series(1, 2000)',
        [originalLabel],
      );

      const update = await writable.executeQuery({
        queryId: 'write-returning',
        sql: 'UPDATE private_probe SET label = $1 WHERE label = $2 RETURNING id, label',
        params: [changedLabel, originalLabel],
        maxRows: 100,
        readOnly: false,
      });
      assert.equal(update.success, true, update.error);
      assert.equal(update.rowCount, 2000);
      assert.equal(update.rows.length, 100);
      assert.equal(update.truncated, true);
      const count = await client.query(
        'SELECT count(*)::int AS total FROM private_probe WHERE label = $1',
        [changedLabel],
      );
      assert.equal(count.rows[0].total, 2000);

      const schema = await writable.extractSchema({ requestId: 'write-schema' });
      assert.equal(schema.success, true, schema.error);
      const table = schema.schema.tables.find((item) => item.name === 'private_probe');
      assert.deepEqual(table.privileges, {
        select: true,
        insert: true,
        update: true,
        delete: true,
      });

      const oversized = await writable.executeQuery({
        queryId: 'write-oversized',
        sql: 'UPDATE private_probe SET label = repeat($1, 600000) WHERE id = (SELECT id FROM private_probe WHERE label = $2 LIMIT 1) RETURNING label',
        params: ['x', changedLabel],
        maxRows: 100,
        readOnly: false,
      });
      assert.equal(oversized.success, false);
      assert.match(oversized.error, /response size limit/);
      const unchanged = await client.query(
        'SELECT count(*)::int AS total FROM private_probe WHERE label = $1',
        [changedLabel],
      );
      assert.equal(unchanged.rows[0].total, 2000);

      const forbidden = await capped.executeQuery({
        queryId: 'local-ceiling',
        sql: 'UPDATE private_probe SET label = $1 WHERE label = $2 RETURNING id',
        params: ['forbidden', changedLabel],
        readOnly: false,
      });
      assert.equal(forbidden.success, false);
      assert.match(forbidden.error, /Read-only tunnel queries/);
    } finally {
      await client.query(
        'DELETE FROM private_probe WHERE label IN ($1, $2)',
        [originalLabel, changedLabel],
      );
      await client.end();
      await writable.closeAll();
      await capped.closeAll();
    }
  },
);

test(
  'real PostgreSQL executes a write once when the tunnel disconnects mid-query',
  { skip: !databaseUrl || process.env.DATAMCP_TEST_WRITE !== '1' },
  async () => {
    const database = new DatabaseService(databaseUrl);
    const client = new Client({ connectionString: databaseUrl });
    const agent = new AgentService(
      { heartbeatInterval: 60_000, connectionId: 'conn_midwrite_test' },
      database,
    );
    const socket = new EventEmitter();
    socket.connected = true;
    socket.disconnect = () => {};
    socket.connect = () => {};
    agent.socket = socket;
    agent.setupEventHandlers();
    const results = [];
    socket.on('query_result', (result) => results.push(result));
    const label = `midwrite-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await client.connect();
    try {
      socket.emit('connected', { connectionId: 'conn_midwrite_test' });
      socket.emit('execute_query', {
        queryId: 'midwrite-query',
        sql: 'INSERT INTO private_probe (label) SELECT $1 FROM (SELECT pg_sleep(1)) delay RETURNING id',
        params: [label],
        readOnly: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(agent.inFlightQueries.has('midwrite-query'), true);
      socket.connected = false;
      socket.emit('disconnect', 'transport close');

      const deadline = Date.now() + 5000;
      while (!agent.pendingQueryResults.has('midwrite-query') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(agent.pendingQueryResults.has('midwrite-query'), true);
      assert.equal(results.length, 0);

      socket.connected = true;
      socket.emit('connected', { connectionId: 'conn_midwrite_test' });
      assert.equal(results.length, 1);
      assert.equal(results[0].success, true, results[0].error);
      assert.equal(results[0].rowCount, 1);

      socket.emit('execute_query', {
        queryId: 'midwrite-query',
        sql: 'INSERT INTO private_probe (label) SELECT $1 FROM (SELECT pg_sleep(1)) delay RETURNING id',
        params: [label],
        readOnly: false,
      });
      assert.equal(results.length, 2);
      const count = await client.query(
        'SELECT count(*)::int AS total FROM private_probe WHERE label = $1',
        [label],
      );
      assert.equal(count.rows[0].total, 1);

      socket.emit('query_ack', { queryId: 'midwrite-query' });
      assert.equal(agent.pendingQueryResults.has('midwrite-query'), false);
    } finally {
      await client.query('DELETE FROM private_probe WHERE label = $1', [label]);
      await client.end();
      await agent.stop();
    }
  },
);

test(
  'real PostgreSQL rolls back a write when its statement times out',
  { skip: !databaseUrl || process.env.DATAMCP_TEST_WRITE !== '1' },
  async () => {
    const database = new DatabaseService(databaseUrl);
    const client = new Client({ connectionString: databaseUrl });
    const label = `timeout-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await client.connect();
    try {
      const result = await database.executeQuery({
        queryId: 'timed-out-write',
        sql: 'INSERT INTO private_probe (label) SELECT $1 FROM (SELECT pg_sleep(2)) delay RETURNING id',
        params: [label],
        timeoutMs: 1000,
        readOnly: false,
      });
      assert.equal(result.success, false);
      assert.match(result.error, /statement timeout/);
      const count = await client.query(
        'SELECT count(*)::int AS total FROM private_probe WHERE label = $1',
        [label],
      );
      assert.equal(count.rows[0].total, 0);
    } finally {
      await client.query('DELETE FROM private_probe WHERE label = $1', [label]);
      await client.end();
      await database.closeAll();
    }
  },
);

test(
  'real PostgreSQL does not apply a write after a lock timeout',
  { skip: !databaseUrl || process.env.DATAMCP_TEST_WRITE !== '1' },
  async () => {
    const database = new DatabaseService(databaseUrl);
    const client = new Client({ connectionString: databaseUrl });
    const blocker = new Client({ connectionString: databaseUrl });
    const label = `lock-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await client.connect();
    await blocker.connect();
    try {
      const inserted = await client.query(
        'INSERT INTO private_probe (label) VALUES ($1) RETURNING id',
        [label],
      );
      const rowId = inserted.rows[0].id;
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM private_probe WHERE id = $1 FOR UPDATE', [rowId]);

      const result = await database.executeQuery({
        queryId: 'locked-write',
        sql: 'UPDATE private_probe SET label = $1 WHERE id = $2 RETURNING id',
        params: [`${label}-changed`, rowId],
        timeoutMs: 1000,
        readOnly: false,
      });
      assert.equal(result.success, false);
      assert.match(result.error, /statement timeout/);
      await blocker.query('ROLLBACK');

      const unchanged = await client.query(
        'SELECT label FROM private_probe WHERE id = $1',
        [rowId],
      );
      assert.equal(unchanged.rows[0].label, label);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await client.query('DELETE FROM private_probe WHERE label IN ($1, $2)', [label, `${label}-changed`]);
      await blocker.end();
      await client.end();
      await database.closeAll();
    }
  },
);
