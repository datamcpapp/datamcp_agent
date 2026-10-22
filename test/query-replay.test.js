const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { AgentService } = require('../dist/services/agent.service');

test('replays a write result after reconnect without executing SQL twice', async () => {
  let executions = 0;
  const database = {
    executeQuery: async (request) => {
      executions++;
      return {
        queryId: request.queryId,
        success: true,
        rows: [],
        rowCount: 1,
        duration: 1,
      };
    },
    closeAll: async () => {},
  };
  const agent = new AgentService(
    { heartbeatInterval: 60_000, connectionId: 'conn_test' },
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
  socket.emit('connected', { connectionId: 'conn_test' });
  socket.emit('execute_query', {
    queryId: 'query_write',
    sql: 'UPDATE private_probe SET label = label',
    readOnly: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(results.length, 1);
  assert.equal(executions, 1);

  socket.connected = false;
  socket.emit('disconnect', 'transport close');
  socket.connected = true;
  socket.emit('connected', { connectionId: 'conn_test' });
  assert.equal(results.length, 2);
  assert.equal(executions, 1);

  socket.emit('execute_query', {
    queryId: 'query_write',
    sql: 'UPDATE private_probe SET label = label',
    readOnly: false,
  });
  assert.equal(results.length, 3);
  assert.equal(executions, 1);

  socket.emit('query_ack', { queryId: 'query_write' });
  socket.emit('execute_query', {
    queryId: 'query_write',
    sql: 'UPDATE private_probe SET label = label',
    readOnly: false,
  });
  assert.equal(executions, 1);
  assert.match(results.at(-1).error, /already executed/);
  await agent.stop();
});

test('buffers a result produced while the socket is offline', async () => {
  let finishQuery;
  const database = {
    executeQuery: () => new Promise((resolve) => { finishQuery = resolve; }),
    closeAll: async () => {},
  };
  const agent = new AgentService(
    { heartbeatInterval: 60_000, connectionId: 'conn_test' },
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

  socket.emit('connected', { connectionId: 'conn_test' });
  socket.emit('execute_query', { queryId: 'query_offline', sql: 'SELECT 1' });
  socket.connected = false;
  socket.emit('disconnect', 'transport close');
  finishQuery({ queryId: 'query_offline', success: true, rows: [{ one: 1 }], duration: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(results.length, 0);

  socket.connected = true;
  socket.emit('connected', { connectionId: 'conn_test' });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].rows, [{ one: 1 }]);
  await agent.stop();
});

test('does not execute a long-running write again after its result is acknowledged', async () => {
  let finishQuery;
  let executions = 0;
  const database = {
    executeQuery: () => {
      executions++;
      return new Promise((resolve) => { finishQuery = resolve; });
    },
    closeAll: async () => {},
  };
  const agent = new AgentService(
    { heartbeatInterval: 60_000, connectionId: 'conn_test' },
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

  socket.emit('connected', { connectionId: 'conn_test' });
  const request = { queryId: 'slow_write', sql: 'UPDATE private_probe SET label = label', readOnly: false };
  socket.emit('execute_query', request);
  assert.equal(executions, 1);
  agent.completedQueryIds.set(request.queryId, Date.now() - 121_000);
  finishQuery({ queryId: request.queryId, success: true, rowCount: 1, duration: 121_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(results.length, 1);

  socket.emit('query_ack', { queryId: request.queryId });
  socket.emit('execute_query', request);
  assert.equal(executions, 1);
  assert.match(results.at(-1).error, /already executed/);
  await agent.stop();
});

test('keeps an unacknowledged result beyond two minutes for a long query', async () => {
  const agent = new AgentService(
    { heartbeatInterval: 60_000, connectionId: 'conn_test' },
    { closeAll: async () => {} },
  );
  const createdAt = Date.now() - 121_000;
  agent.pendingQueryResults.set('long_query', {
    result: { queryId: 'long_query', success: true, rowCount: 1 },
    createdAt,
  });
  agent.completedQueryIds.set('long_query', createdAt);

  agent.pruneQueryHistory();

  assert.equal(agent.pendingQueryResults.has('long_query'), true);
  assert.equal(agent.completedQueryIds.has('long_query'), true);

  const expiredAt = Date.now() - 12 * 60_000;
  agent.pendingQueryResults.set('expired_query', {
    result: { queryId: 'expired_query', success: true, rowCount: 1 },
    createdAt: expiredAt,
  });
  agent.completedQueryIds.set('expired_query', expiredAt);
  agent.pruneQueryHistory();
  assert.equal(agent.pendingQueryResults.has('expired_query'), false);
  assert.equal(agent.completedQueryIds.has('expired_query'), false);
  await agent.stop();
});

test('bounds offline results without re-executing evicted writes', async () => {
  let executions = 0;
  const database = {
    executeQuery: async (request) => {
      executions++;
      return { queryId: request.queryId, success: true, rowCount: 1 };
    },
    closeAll: async () => {},
  };
  const agent = new AgentService(
    { heartbeatInterval: 60_000, connectionId: 'conn_test' },
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

  socket.emit('connected', { connectionId: 'conn_test' });
  socket.connected = false;
  socket.emit('disconnect', 'transport close');
  for (let index = 0; index < 100; index++) {
    socket.emit('execute_query', {
      queryId: `write_${index}`,
      sql: 'UPDATE private_probe SET label = label',
      readOnly: false,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executions, 100);
  assert.equal(agent.pendingQueryResults.size, 32);
  assert.equal(agent.completedQueryIds.size, 100);

  socket.connected = true;
  socket.emit('connected', { connectionId: 'conn_test' });
  assert.equal(results.length, 32);
  socket.emit('execute_query', {
    queryId: 'write_0',
    sql: 'UPDATE private_probe SET label = label',
    readOnly: false,
  });
  assert.equal(executions, 100);
  assert.match(results.at(-1).error, /already executed/);
  await agent.stop();
});
