import * as http from 'http';
import { logger } from '../utils/logger';
import { AgentService } from './agent.service';

/**
 * Health service for HTTP health checks
 */
export class HealthService {
  private server: http.Server | null = null;

  constructor(
    private port: number,
    private agentService: AgentService,
  ) {}

  /**
   * Start HTTP server for health checks
   */
  start(): void {
    this.server = http.createServer((req, res) => {
      const url = req.url;

      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (url === '/health') {
        this.handleHealthCheck(res);
      } else if (url === '/ready') {
        this.handleReadinessCheck(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.server.listen(this.port, () => {
      logger.info(`Health server listening on port ${this.port}`);
    });

    this.server.on('error', (error) => {
      logger.error('Health server error', { error: error.message });
    });
  }

  /**
   * Handle liveness probe - is the agent running?
   */
  private handleHealthCheck(res: http.ServerResponse): void {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: '1.0.0',
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
  }

  /**
   * Handle readiness probe - is the agent connected to cloud?
   */
  private handleReadinessCheck(res: http.ServerResponse): void {
    const isConnected = this.agentService.isConnected();
    const agentId = this.agentService.getAgentId();

    const readiness = {
      status: isConnected ? 'ready' : 'not_ready',
      connected: isConnected,
      agentId,
      timestamp: new Date().toISOString(),
    };

    const statusCode = isConnected ? 200 : 503;

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readiness));
  }

  /**
   * Stop health server
   */
  stop(): void {
    if (this.server) {
      this.server.close(() => {
        logger.info('Health server stopped');
      });
      this.server = null;
    }
  }
}
