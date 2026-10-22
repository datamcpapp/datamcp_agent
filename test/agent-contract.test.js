const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadConfig } = require('../dist/utils/config');
const { DatabaseService } = require('../dist/services/database.service');

test('accepts the dashboard command for a QA read-only tunnel', async () => {
  const config = await loadConfig([
    'ro',
    'postgres://user:password@localhost:5432/app',
    '--stage',
    'qa',
    '--connection-id',
    'conn_example',
    '--agent-token',
    'agent_example',
  ]);

  assert.equal(
    config.databaseUrl,
    'postgres://user:password@localhost:5432/app',
  );
  assert.equal(config.cloudUrl, 'wss://api-qa.datamcp.app');
  assert.equal(config.connectionId, 'conn_example');
  assert.equal(config.agentToken, 'agent_example');
  assert.equal(config.readOnlyCeiling, true);
});

test('accepts a claimed agent token', async () => {
  const config = await loadConfig([
    '--db',
    'postgres://localhost/app',
    '--connection-id',
    'conn_example',
    '--agent-token',
    'agent_example',
  ]);

  assert.equal(config.agentToken, 'agent_example');
});

test('accepts an environment database URL with read-only mode', async () => {
  const previousUrl = process.env.DATAMCP_DB_URL;
  const previousReadOnly = process.env.DATAMCP_READ_ONLY;
  process.env.DATAMCP_DB_URL = 'postgres://localhost/app';
  process.env.DATAMCP_READ_ONLY = 'true';
  try {
    const config = await loadConfig([
      'ro',
      '--stage',
      'qa',
      '--connection-id',
      'conn_example',
      '--agent-token',
      'agent_example',
    ]);
    assert.equal(config.databaseUrl, 'postgres://localhost/app');
    assert.equal(config.readOnlyCeiling, true);
  } finally {
    if (previousUrl === undefined) delete process.env.DATAMCP_DB_URL;
    else process.env.DATAMCP_DB_URL = previousUrl;
    if (previousReadOnly === undefined) delete process.env.DATAMCP_READ_ONLY;
    else process.env.DATAMCP_READ_ONLY = previousReadOnly;
  }
});

test('rejects an unregistered run before opening a database connection', async () => {
  const apiKey = process.env.DATAMCP_API_KEY;
  const agentToken = process.env.DATAMCP_AGENT_TOKEN;
  const connectionId = process.env.DATAMCP_CONNECTION_ID;
  delete process.env.DATAMCP_API_KEY;
  delete process.env.DATAMCP_AGENT_TOKEN;
  delete process.env.DATAMCP_CONNECTION_ID;
  try {
    await assert.rejects(
      loadConfig(['--db', 'postgres://localhost/app']),
      /Create a Local Agent connection in the dashboard first/,
    );
  } finally {
    for (const [key, value] of Object.entries({
      DATAMCP_API_KEY: apiKey,
      DATAMCP_AGENT_TOKEN: agentToken,
      DATAMCP_CONNECTION_ID: connectionId,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('runs read-only requests inside a read-only transaction', async () => {
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [{ one: 1 }], fields: [{ name: 'one' }], rowCount: 1 };
    },
    release: () => {},
  };
  const database = new DatabaseService('postgres://localhost/app');
  database.pool = { connect: async () => client };

  const result = await database.executeQuery({
    queryId: 'query_1',
    sql: 'select 1',
    readOnly: true,
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    'BEGIN TRANSACTION READ ONLY',
    'SET LOCAL statement_timeout = 30000',
    {
      text: 'SELECT * FROM (\nselect 1\n) AS datamcp_result LIMIT 101',
      values: [],
      queryMode: 'extended',
    },
    'ROLLBACK',
  ]);
});

test('local read-only ceiling overrides cloud write requests', async () => {
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [], fields: [], rowCount: 0 };
    },
    release: () => {},
  };
  const database = new DatabaseService('postgres://localhost/app', true);
  database.pool = { connect: async () => client };

  await database.executeQuery({
    queryId: 'query_2',
    sql: 'select 1',
    readOnly: false,
  });

  assert.equal(calls[0], 'BEGIN TRANSACTION READ ONLY');
  assert.equal(calls.at(-1), 'ROLLBACK');
});
