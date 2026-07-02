import { loadConfig } from './config';
import { DbExecutor } from './db/executor';
import { startHealthServer } from './health';
import { Logger } from './logger';
import { TunnelClient } from './tunnel/client';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  logger.info(
    `Starting ${config.agentName} — stage=${config.stage}, readOnly=${config.readOnly}`,
  );

  const executor = new DbExecutor(config, logger);

  // Fail fast if the local database is unreachable — better to crash loudly at
  // startup than to connect to the cloud and reject every query.
  try {
    await executor.verifyConnectivity();
  } catch (err) {
    logger.error(
      `Cannot reach database: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  const health = startHealthServer(config.healthPort, logger);
  const tunnel = new TunnelClient(config, executor, logger);
  tunnel.start();

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    tunnel.stop();
    health.close();
    void executor.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
