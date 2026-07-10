/**
 * Agent configuration loaded at startup. Database creds live in `databaseUrl`
 * and never leave this process — server only ever sends a connectionId.
 */
export interface AgentConfig {
  apiKey: string | null; // sk_live_* — registered flow
  anonToken: string | null; // 32B base64url — anonymous flow, replaced on claim
  agentToken: string | null; // 32B base64url — set after claim (post-rotation)
  connectionId: string | null; // null for anonymous bootstrap, set after
  databaseUrl: string; // postgresql://... — local-only credential
  cloudUrl: string;
  agentName: string;
  heartbeatInterval: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  port: number;
}

/**
 * Cloud → agent: execute a query against the local pg.
 * NB: no DatabaseConfig — agent already has it locally (see plan §4.3).
 */
export interface QueryRequest {
  queryId: string;
  sql: string;
  params: unknown[];
  timeoutMs: number;
}

export interface QueryResult {
  queryId: string;
  success: boolean;
  rows?: unknown[];
  fields?: { name: string }[];
  rowCount?: number;
  error?: string;
  duration: number;
}

export interface SchemaRequest {
  requestId: string;
}

export interface SchemaResult {
  requestId: string;
  success: boolean;
  schema?: SchemaData;
  error?: string;
  duration: number;
}

export interface SchemaData {
  tables: TableSchema[];
  extractedAt: string;
}

export interface TableSchema {
  name: string;
  schema: string;
  columns: ColumnSchema[];
  primaryKey?: string[];
  foreignKeys?: ForeignKeySchema[];
  indexes?: IndexSchema[];
}

export interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  comment?: string;
}

export interface ForeignKeySchema {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface HealthCheckRequest {
  requestId: string;
}

export interface HealthCheckResult {
  requestId: string;
  success: boolean;
  latency?: number;
  error?: string;
}

export interface HeartbeatData {
  version: string;
  metadata: {
    hostname: string;
    platform: string;
    nodeVersion: string;
    uptime: number;
  };
}
