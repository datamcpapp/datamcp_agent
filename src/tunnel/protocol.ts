/**
 * Wire protocol shared with the server `agent-tunnel` module (namespace `/agents`).
 * Keep in sync with nestjs-app/src/modules/agent-tunnel/types.ts.
 *
 * Server → agent events: `connected`, `execute_query`, `error`.
 * Agent → server events: `heartbeat`, `query_result`.
 */

export interface AgentExecuteQueryRequest {
  queryId: string;
  sql: string;
  params: unknown[];
  timeoutMs: number;
}

export interface AgentExecuteQueryResult {
  queryId: string;
  success: boolean;
  rows?: unknown[];
  fields?: { name: string }[];
  rowCount?: number;
  error?: string;
  duration: number;
}

export interface AgentExtractSchemaRequest {
  requestId: string;
}

export interface AgentExtractSchemaResult {
  requestId: string;
  success: boolean;
  schema?: unknown;
  error?: string;
  duration: number;
}

export interface AgentHealthCheckRequest {
  requestId: string;
}

export interface AgentHealthCheckResult {
  requestId: string;
  success: boolean;
  error?: string;
  duration: number;
}

export interface AgentHeartbeat {
  version: string;
  metadata?: {
    hostname?: string;
    platform?: string;
    nodeVersion?: string;
    uptime?: number;
  };
}

export interface ConnectedEvent {
  connectionId: string;
  agentId: string;
}
