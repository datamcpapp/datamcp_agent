import { HELP, parseArgs, versionString } from './cli';
import { resolveConfig } from './config';
import { DbExecutor } from './db/executor';
import { startHealthServer } from './health';
import { Logger } from './logger';
import { POLICY_LABEL } from './policy';
import { runSelftest } from './selftest';
import { TunnelClient } from './tunnel/client';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === 'help') { console.log(HELP); return; }
  if (parsed.command === 'version') { console.log(versionString()); return; }
  if (parsed.error) { console.error(`Error: ${parsed.error}\n\nRun \`datamcp --help\` for usage.`); process.exit(2); }

  const config = resolveConfig(parsed.cli);
  const logger = new Logger(config.logLevel);

  // --selftest: verify the policy on the real DB, then exit.
  if (parsed.selftest) {
    const ok = await runSelftest(config, logger);
    process.exit(ok ? 0 : 1);
  }

  logger.info(`Starting ${config.agentName} — policy=${config.policy} (${POLICY_LABEL[config.policy]}), stage=${config.stage}`);

  const executor = new DbExecutor(config, logger);
  try {
    const info = await executor.verifyConnectivity();
    logger.info(`DB reachable as ${info.user}/${info.database}`);
  } catch (err) {
    logger.error(`Cannot reach database: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Cloud connection requires credentials. Without them, guide the user.
  if (!config.connectionId || !(config.apiKey || config.anonToken)) {
    logger.error(
      'Missing cloud credentials. Provide --connection-id and --api-key ' +
      '(or --anon-token), or run with --selftest to validate the policy locally.',
    );
    await executor.close();
    process.exit(2);
  }

  const health = startHealthServer(config.healthPort, logger);
  const tunnel = new TunnelClient(config, executor, logger);
  tunnel.start();

  const shutdown = (sig: string) => {
    logger.info(`Received ${sig}, shutting down`);
    tunnel.stop();
    health.close();
    void executor.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
