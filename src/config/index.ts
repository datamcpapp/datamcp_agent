import * as dotenv from 'dotenv';

dotenv.config();

export type Stage = 'production' | 'qa' | 'staging' | 'development';

export interface AgentConfig {
  stage: Stage;
  /** Base websocket URL of the DataMCP cloud (namespace `/agents` is appended). */
  cloudUrl: string;
  connectionId: string;
  /** Registered flow. Exactly one of apiKey / anonToken is set. */
  apiKey: string | null;
  /** Anonymous bootstrap flow (claim later from the dashboard). */
  anonToken: string | null;
  /** Local database this agent reaches — credentials never leave this host. */
  databaseUrl: string;
  /** Enforce read-only at the database level (READ ONLY tx + dangerous-fn block). */
  readOnly: boolean;
  statementTimeoutMs: number;
  agentName: string;
  heartbeatIntervalMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  healthPort: number;
}

/**
 * Resolve the cloud websocket URL from the stage — the same environment
 * convention used by the dashboard (`getApiBaseUrl`) and server, so one agent
 * build points at QA or production just by flipping DATAMCP_STAGE.
 * `qa` exists specifically so the tunnel can be exercised end-to-end against the
 * QA cloud before touching production.
 */
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
  if (s === 'production' || s === 'qa' || s === 'staging' || s === 'development') {
    return s;
  }
  return 'development';
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadConfig(): AgentConfig {
  const stage = normalizeStage(process.env.DATAMCP_STAGE);

  const apiKey = process.env.DATAMCP_API_KEY?.trim() || null;
  const anonToken = process.env.DATAMCP_ANON_TOKEN?.trim() || null;
  if (!apiKey && !anonToken) {
    throw new Error(
      'Provide DATAMCP_API_KEY (registered) or DATAMCP_ANON_TOKEN (anonymous).',
    );
  }

  const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

  return {
    stage,
    cloudUrl: process.env.DATAMCP_CLOUD_URL?.trim() || resolveCloudUrl(stage),
    connectionId: required('DATAMCP_CONNECTION_ID', process.env.DATAMCP_CONNECTION_ID),
    apiKey,
    anonToken,
    databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),
    // Read-only is the default and must be explicitly disabled.
    readOnly: (process.env.AGENT_READ_ONLY || 'true').toLowerCase() !== 'false',
    statementTimeoutMs: toInt(process.env.AGENT_STATEMENT_TIMEOUT_MS, 30_000),
    agentName: process.env.AGENT_NAME?.trim() || 'datamcp-agent',
    heartbeatIntervalMs: toInt(process.env.HEARTBEAT_INTERVAL_MS, 30_000),
    logLevel: (['debug', 'info', 'warn', 'error'].includes(logLevel)
      ? logLevel
      : 'info') as AgentConfig['logLevel'],
    healthPort: toInt(process.env.HEALTH_PORT, 3000),
  };
}
