import { config as dotenvConfig } from 'dotenv';
import { AgentConfig } from '../types';
import { logger } from './logger';

dotenvConfig();

interface CliArgs {
  db?: string;
  apiKey?: string;
  connectionId?: string;
  cloudUrl?: string;
  agentName?: string;
  logLevel?: string;
  port?: string;
}

/**
 * Minimal arg parser — no external deps. Supports --flag=value and --flag value.
 */
function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[arg.slice(2)] = next;
        i++;
      } else {
        args[arg.slice(2)] = 'true';
      }
    }
  }
  return {
    db: args['db'],
    apiKey: args['api-key'],
    connectionId: args['connection-id'],
    cloudUrl: args['cloud-url'],
    agentName: args['agent-name'],
    logLevel: args['log-level'],
    port: args['port'],
  };
}

export async function loadConfig(argv: string[] = process.argv.slice(2)): Promise<AgentConfig> {
  const cli = parseArgs(argv);

  const databaseUrl = cli.db || process.env.DATAMCP_DB_URL;
  if (!databaseUrl) {
    throw new Error(
      '--db <postgresql://...> or DATAMCP_DB_URL is required (creds stay on this machine)',
    );
  }

  // apiKey is OPTIONAL — its absence triggers anonymous bootstrap flow.
  const apiKey = cli.apiKey || process.env.DATAMCP_API_KEY || null;
  if (apiKey && !apiKey.startsWith('sk_live_') && !apiKey.startsWith('agent_')) {
    throw new Error('Invalid API key format — expected sk_live_* or agent_* prefix');
  }

  const connectionId = cli.connectionId || process.env.DATAMCP_CONNECTION_ID || null;

  const cloudUrl = cli.cloudUrl || process.env.DATAMCP_CLOUD_URL || 'wss://api.datamcp.app';
  const agentName =
    cli.agentName || process.env.AGENT_NAME || (await import('os')).hostname();
  const heartbeatInterval = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);
  const logLevel = (cli.logLevel ||
    process.env.LOG_LEVEL ||
    'info') as AgentConfig['logLevel'];
  const port = parseInt(cli.port || process.env.PORT || '3000', 10);

  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: ${logLevel}`);
  }
  if (heartbeatInterval < 5000 || heartbeatInterval > 300000) {
    throw new Error('HEARTBEAT_INTERVAL must be 5000–300000 ms');
  }
  if (port < 1 || port > 65535) {
    throw new Error('PORT must be 1–65535');
  }

  const config: AgentConfig = {
    apiKey,
    anonToken: null,
    agentToken: null,
    connectionId,
    databaseUrl,
    cloudUrl,
    agentName,
    heartbeatInterval,
    logLevel,
    port,
  };

  logger.info('Configuration loaded', {
    cloudUrl: config.cloudUrl,
    agentName: config.agentName,
    connectionId: config.connectionId ?? '(pending bootstrap)',
    authMode: apiKey ? 'registered' : 'anonymous',
    logLevel: config.logLevel,
    port: config.port,
  });

  return config;
}
