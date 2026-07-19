import * as dotenv from 'dotenv';

import { Policy, parsePolicy } from '../policy';

dotenv.config();

export type Stage = 'production' | 'qa' | 'staging' | 'development';

export interface AgentConfig {
  policy: Policy;
  stage: Stage;
  /** Base websocket URL of the DataMCP cloud (namespace `/agents` is appended). */
  cloudUrl: string;
  connectionId: string | null;
  apiKey: string | null;
  anonToken: string | null;
  agentToken: string | null;
  /** Local database this agent reaches; credentials never leave this host. */
  databaseUrl: string;
  statementTimeoutMs: number;
  maxResultRows: number;
  maxResultBytes: number;
  maxConcurrentQueries: number;
  agentName: string;
  heartbeatIntervalMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  healthPort: number;
}

/** Values parsed from the CLI (take precedence over env). */
export interface CliConfig {
  policy?: Policy;
  databaseUrl?: string;
  stage?: string;
  cloudUrl?: string;
  connectionId?: string;
  apiKey?: string;
  anonToken?: string;
  agentToken?: string;
  name?: string;
  statementTimeoutMs?: number;
  maxResultRows?: number;
  maxResultBytes?: number;
  maxConcurrentQueries?: number;
}

/** Resolve the cloud websocket URL from the stage, same convention as the
 *  dashboard/server, so one agent build points at QA or production by flag. */
function resolveCloudUrl(stage: Stage): string {
  switch (stage) {
    case 'production':
      return 'wss://api.datamcp.app';
    case 'qa':
      return 'wss://api-qa.datamcp.app';
    case 'staging':
      return 'wss://staging-api.datamcp.app';
    case 'development':
    default:
      return 'ws://localhost:7834';
  }
}

function normalizeStage(raw: string | undefined): Stage {
  const s = (raw || process.env.NODE_ENV || 'development').toLowerCase();
  return (
    ['production', 'qa', 'staging', 'development'].includes(s)
      ? s
      : 'development'
  ) as Stage;
}

/** Accept shorthand DB URLs (`localhost/db`, `localhost:///mydb`) by defaulting
 *  the postgres scheme. */
export function normalizeDbUrl(raw: string): string {
  const t = raw.trim();
  if (/^[a-z]+:\/\//i.test(t)) return t;
  return `postgres://${t.replace(/^\/+/, '')}`;
}

function toInt(value: string | number | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function resolveConfig(cli: CliConfig = {}): AgentConfig {
  const policy = cli.policy ?? parsePolicy(process.env.DATAMCP_POLICY);
  if (!policy) throw new Error('Missing access policy (ro | rwd | fa).');

  const rawDb = cli.databaseUrl ?? process.env.DATABASE_URL;
  if (!rawDb) throw new Error('Missing database URL.');

  const stage = normalizeStage(cli.stage ?? process.env.DATAMCP_STAGE);
  const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

  return {
    policy,
    stage,
    cloudUrl:
      cli.cloudUrl || process.env.DATAMCP_CLOUD_URL || resolveCloudUrl(stage),
    connectionId:
      cli.connectionId || process.env.DATAMCP_CONNECTION_ID || null,
    apiKey: cli.apiKey || process.env.DATAMCP_API_KEY || null,
    anonToken: cli.anonToken || process.env.DATAMCP_ANON_TOKEN || null,
    agentToken: cli.agentToken || process.env.DATAMCP_AGENT_TOKEN || null,
    databaseUrl: normalizeDbUrl(rawDb),
    statementTimeoutMs: toInt(
      cli.statementTimeoutMs ?? process.env.AGENT_STATEMENT_TIMEOUT_MS,
      30_000,
    ),
    maxResultRows: toInt(
      cli.maxResultRows ?? process.env.AGENT_MAX_RESULT_ROWS,
      1_000,
    ),
    maxResultBytes: toInt(
      cli.maxResultBytes ?? process.env.AGENT_MAX_RESULT_BYTES,
      1_000_000,
    ),
    maxConcurrentQueries: toInt(
      cli.maxConcurrentQueries ?? process.env.AGENT_MAX_CONCURRENT_QUERIES,
      4,
    ),
    agentName: cli.name || process.env.AGENT_NAME || 'datamcp-agent',
    heartbeatIntervalMs: toInt(process.env.HEARTBEAT_INTERVAL_MS, 30_000),
    logLevel: (
      ['debug', 'info', 'warn', 'error'].includes(logLevel)
        ? logLevel
        : 'info'
    ) as AgentConfig['logLevel'],
    healthPort: toInt(process.env.HEALTH_PORT, 3000),
  };
}
