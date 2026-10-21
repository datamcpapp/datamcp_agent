/**
 * Agent configuration loaded at startup. Database creds live in `databaseUrl`
 * and never leave this process — server only ever sends a connectionId.
 */
export interface AgentConfig {
  apiKey: string | null;
  agentToken: string | null;
  connectionId: string;
  databaseUrl: string; // postgresql://... — local-only credential
  cloudUrl: string;
  agentName: string;
  heartbeatInterval: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  port: number;
  readOnlyCeiling: boolean;
}

/**
 * Cloud → agent: execute a query against the local pg.
 * The agent already has the database configuration locally.
 */
export interface QueryRequest {
  queryId: string;
  sql: string;
  params: unknown[];
  timeoutMs: number;
  readOnly?: boolean;
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
