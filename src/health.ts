import * as http from 'http';

import { Logger } from './logger';

/**
 * Minimal HTTP liveness endpoint for Docker/k8s health probes.
 * GET /health → 200 {"status":"ok"}.
 */
export function startHealthServer(port: number, logger: Logger): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => logger.info(`Health server on :${port}`));
  return server;
}
