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
