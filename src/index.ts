#!/usr/bin/env node
import { loadConfig } from './utils/config';
import { hasHelpFlag, hasVersionFlag, printHelp } from './utils/config';
import { logger } from './utils/logger';
import { AgentService } from './services/agent.service';
import { DatabaseService } from './services/database.service';
import { HealthService } from './services/health.service';
import { VERSION } from './version';

async function main() {
  try {
    if (hasHelpFlag()) {
      printHelp();
      return;
    }

    if (hasVersionFlag()) {
      console.log(VERSION);
      return;
    }

    const config = await loadConfig();
    logger.setLevel(config.logLevel);

    logger.info('DataMCP Agent starting...', {
      version: VERSION,
      name: config.agentName,
    });

    const databaseService = new DatabaseService(
      config.databaseUrl,
      config.readOnlyCeiling,
    );

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
