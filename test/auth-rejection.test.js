const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { AgentService } = require('../dist/services/agent.service');

test('does not reconnect after the server rejects the agent token', async () => {
  const agent = new AgentService(
    { heartbeatInterval: 60_000, connectionId: 'conn_test' },
    { closeAll: async () => {} },
  );
  const socket = new EventEmitter();
  let reconnects = 0;
  let disconnects = 0;
  socket.connect = () => { reconnects++; };
  socket.disconnect = () => { disconnects++; };
  agent.socket = socket;
  agent.setupEventHandlers();

  socket.emit('error', { message: 'invalid agent token' });
  socket.emit('disconnect', 'io server disconnect');

  assert.equal(reconnects, 0);
  assert.equal(disconnects, 1);
  await agent.stop();
});

test('continues to reconnect after a transient server disconnect', async () => {
  const agent = new AgentService(
    { heartbeatInterval: 60_000, connectionId: 'conn_test' },
    { closeAll: async () => {} },
  );
  const socket = new EventEmitter();
  let reconnects = 0;
  socket.connect = () => { reconnects++; };
  socket.disconnect = () => {};
  agent.socket = socket;
  agent.setupEventHandlers();

  socket.emit('disconnect', 'io server disconnect');

  assert.equal(reconnects, 1);
  await agent.stop();
});
