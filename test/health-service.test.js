const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { HealthService } = require('../dist/services/health.service');

test('health endpoint binds only to loopback', async () => {
  const originalCreateServer = http.createServer;
  let listenHost;
  http.createServer = () => ({
    listen: (_port, host, callback) => {
      listenHost = host;
      callback();
    },
    on: () => {},
    close: (callback) => callback(),
  });

  const service = new HealthService(3000, {
    isConnected: () => false,
    getAgentId: () => null,
  });

  try {
    service.start();
    assert.equal(listenHost, '127.0.0.1');
  } finally {
    service.stop();
    http.createServer = originalCreateServer;
  }
});
