import { config as dotenvConfig } from 'dotenv';
import { AgentConfig } from '../types';
import { logger } from './logger';

dotenvConfig();

interface CliArgs {
  db?: string;
  mode?: string;
  stage?: string;
  apiKey?: string;
  agentToken?: string;
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
    db:
      args['db'] ||
      (argv[0] === 'ro' && argv[1] && !argv[1].startsWith('--')
        ? argv[1]
        : undefined),
    mode: argv[0] === 'ro' ? 'ro' : undefined,
    stage: args['stage'],
    apiKey: args['api-key'],
    agentToken: args['agent-token'],
    connectionId: args['connection-id'],
    cloudUrl: args['cloud-url'],
    agentName: args['agent-name'],
    logLevel: args['log-level'],
    port: args['port'],
  };
}

export function hasHelpFlag(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes('--help') || argv.includes('-h') || argv.includes('help');
}

export function hasVersionFlag(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes('--version') || argv.includes('-v') || argv.includes('version');
}

export function printHelp(): void {
  console.log(`DataMCP Agent

Usage:
  datamcp-agent ro <postgresql://...> --stage qa --connection-id <conn_...>
  datamcp-agent --db <postgresql://...> --agent-token <agent_...> --connection-id <conn_...>

Options:
  --db <url>                  PostgreSQL URL. Also DATAMCP_DB_URL.
  --api-key <key>             Legacy DataMCP API key for older tunnels.
  --agent-token <token>       Agent token for a claimed tunnel.
  --connection-id <id>        DataMCP tunnel connection id.
  --stage <stage>             qa, production, or development (default: production).
  ro                          Enforce a local read-only ceiling for all queries.
  DATAMCP_READ_ONLY=true      Enforce the same ceiling in Docker or Kubernetes.
  --cloud-url <url>           DataMCP cloud URL. Default: wss://api.datamcp.app.
  --agent-name <name>         Friendly name shown in DataMCP.
  --log-level <level>         debug, info, warn, or error. Default: info.
  --port <port>               Local health port. Default: 3000.
  --help                      Show this help.
  --version                   Show version.

Examples:
  npx @datamcp/agent ro "$DATABASE_URL" --stage qa --connection-id "$DATAMCP_CONNECTION_ID"
  datamcp-agent --db "$DATABASE_URL" --agent-token "$DATAMCP_AGENT_TOKEN" --connection-id "$DATAMCP_CONNECTION_ID"
`);
}

export async function loadConfig(argv: string[] = process.argv.slice(2)): Promise<AgentConfig> {
  const cli = parseArgs(argv);

  const databaseUrl = cli.db || process.env.DATAMCP_DB_URL;
  if (!databaseUrl) {
    throw new Error(
      '--db <postgresql://...> or DATAMCP_DB_URL is required (creds stay on this machine)',
    );
  }

  const apiKey = cli.apiKey || process.env.DATAMCP_API_KEY || null;
  if (apiKey && !apiKey.startsWith('sk_live_') && !apiKey.startsWith('agent_')) {
    throw new Error('Invalid API key format — expected sk_live_* or agent_* prefix');
  }

  const connectionId =
    cli.connectionId || process.env.DATAMCP_CONNECTION_ID || null;
  const agentToken = cli.agentToken || process.env.DATAMCP_AGENT_TOKEN || null;
  if (!connectionId || ![apiKey, agentToken].some(Boolean)) {
    throw new Error(
      'A connection ID and DATAMCP_API_KEY or DATAMCP_AGENT_TOKEN are required. Create a Local Agent connection in the dashboard first.',
    );
  }

  const stage = cli.stage || process.env.DATAMCP_STAGE || 'production';
  const stageUrls: Record<string, string> = {
    production: 'wss://api.datamcp.app',
    qa: 'wss://api-qa.datamcp.app',
    development: 'ws://localhost:7834',
  };
  if (!stageUrls[stage]) {
    throw new Error(`Invalid stage: ${stage}`);
  }
  const cloudUrl = cli.cloudUrl || process.env.DATAMCP_CLOUD_URL || stageUrls[stage];
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
    agentToken,
    connectionId,
    databaseUrl,
    cloudUrl,
    agentName,
    heartbeatInterval,
    logLevel,
    port,
    readOnlyCeiling:
      cli.mode === 'ro' || process.env.DATAMCP_READ_ONLY === 'true',
  };

  logger.info('Configuration loaded', {
    cloudUrl: config.cloudUrl,
    agentName: config.agentName,
    connectionId: config.connectionId,
    authMode: agentToken ? 'agent' : 'registered',
    logLevel: config.logLevel,
    port: config.port,
  });

  return config;
}
