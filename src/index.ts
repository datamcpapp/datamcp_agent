#!/usr/bin/env node
import { loadConfig } from './utils/config';
import { logger } from './utils/logger';
import { AgentService } from './services/agent.service';
import { DatabaseService } from './services/database.service';
import { HealthService } from './services/health.service';
import { anonymousBootstrap, printBootstrapResult } from './services/bootstrap.service';

async function main() {
  try {
    const config = await loadConfig();
    logger.setLevel(config.logLevel);

    logger.info('DataMCP Agent starting...', {
      version: '1.0.0',
      name: config.agentName,
    });

    const databaseService = new DatabaseService(config.databaseUrl);

    // Preflight: bail early with a clear error if the local DB is unreachable
    // (plan §10.7) — saves a round-trip to the cloud bootstrap endpoint.
    try {
      await databaseService.preflight();
      logger.info('Local database preflight OK');
    } catch (err) {
      console.error(
        `\nCannot connect to local database: ${err instanceof Error ? err.message : err}`,
      );
      console.error('Check your --db URL and that Postgres is running.\n');
      process.exit(2);
    }

    if (!config.connectionId) {
      if (config.apiKey) {
        // Registered flow without --connection-id: would need POST
        // /api/agents/bootstrap (with api-key auth). Not implemented yet —
        // require an explicit connectionId for the registered path until then.
        console.error(
          '\nRegistered bootstrap (--api-key without --connection-id) is not ' +
            'implemented yet. Pass --connection-id <id> with your --api-key.\n',
        );
        process.exit(2);
      }
      // Anonymous flow: hit POST /api/agents/anonymous, print MCP + claim URLs.
      const result = await anonymousBootstrap(config.cloudUrl);
      config.connectionId = result.connectionId;
      config.anonToken = result.anonToken;
      printBootstrapResult(result);
    }

    const agentService = new AgentService(config, databaseService);
    const healthService = new HealthService(config.port, agentService);

    healthService.start();
    agentService.start();

    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      healthService.stop();
      await agentService.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', { error: error.message, stack: error.stack });
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', { reason });
      process.exit(1);
    });

    logger.info('DataMCP Agent started successfully');
  } catch (error) {
    logger.error('Failed to start agent', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    process.exit(1);
  }
}

void main();
