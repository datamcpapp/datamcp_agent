import { Pool } from 'pg';

import { AgentConfig } from '../config';
import { Logger } from '../logger';
import { decide } from '../policy';
import {
  AgentExecuteQueryRequest,
  AgentExecuteQueryResult,
} from '../tunnel/protocol';

/**
 * Runs SQL against the local (private) database, enforcing the agent's policy.
 *
 * The policy decides per-statement whether it is allowed and whether it runs
 * inside `BEGIN TRANSACTION READ ONLY`. The read-only transaction is the hard,
 * database-level control: PostgreSQL rejects every write path inside it —
 * writable CTEs, SELECT INTO, unparseable DML, or a write attempted by a
 * function called from a SELECT. `SET LOCAL statement_timeout` caps DoS.
 */
export class DbExecutor {
  private readonly pool: Pool;

  constructor(
    private readonly config: AgentConfig,
    private readonly logger: Logger,
  ) {
    const url = new URL(config.databaseUrl);
    const sslmode = url.searchParams.get('sslmode');
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: sslmode === 'disable' ? undefined : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }

  async verifyConnectivity(): Promise<{ user: string; database: string }> {
    const client = await this.pool.connect();
    try {
      const r = await client.query('SELECT current_user, current_database()');
      return { user: r.rows[0].current_user, database: r.rows[0].current_database };
    } finally {
      client.release();
    }
  }

  async extractSchema(): Promise<unknown> {
    const client = await this.pool.connect();
    try {
      const tables = await client.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name
      `);
      const columns = await client.query(`
        SELECT
          table_schema,
          table_name,
          column_name,
          data_type,
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name, ordinal_position
      `);
      const primaryKeys = await client.query(`
        SELECT
          tc.table_schema,
          tc.table_name,
          kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position
      `);

      const primaryKeyMap = new Map<string, string[]>();
      for (const row of primaryKeys.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        primaryKeyMap.set(key, [...(primaryKeyMap.get(key) ?? []), row.column_name]);
      }

      return {
        tables: tables.rows.map((table) => {
          const key = `${table.table_schema}.${table.table_name}`;
          return {
            schema: table.table_schema,
            name: table.table_name,
            columns: columns.rows
              .filter(
                (column) =>
                  column.table_schema === table.table_schema &&
                  column.table_name === table.table_name,
              )
              .map((column) => ({
                name: column.column_name,
                type: column.data_type,
                nullable: column.is_nullable === 'YES',
                default: column.column_default,
                comment: null,
              })),
            primary_keys: primaryKeyMap.get(key) ?? [],
            foreign_keys: [],
            indexes: [],
            constraints: [],
          };
        }),
        metadata: {
          extracted_at: new Date().toISOString(),
          database_type: 'postgresql',
          total_tables: tables.rows.length,
          total_columns: columns.rows.length,
        },
      };
    } finally {
      client.release();
    }
  }

  async execute(req: AgentExecuteQueryRequest): Promise<AgentExecuteQueryResult> {
    const started = Date.now();
    const decision = decide(this.config.policy, req.sql);

    if (!decision.allow) {
      this.logger.warn(`Blocked by policy (${this.config.policy}): ${decision.reason}`);
      return {
        queryId: req.queryId,
        success: false,
        error: `Rejected by agent policy "${this.config.policy}": ${decision.reason}`,
        duration: Date.now() - started,
      };
    }

    const client = await this.pool.connect();
    const timeoutMs = clampTimeout(req.timeoutMs, this.config.statementTimeoutMs);
    let inReadOnlyTx = false;
    try {
      if (decision.readOnlyTx) {
        await client.query('BEGIN TRANSACTION READ ONLY');
        inReadOnlyTx = true;
        await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      } else {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
      }

      const result = await client.query({ text: req.sql, values: req.params ?? [] });
      const cappedRows = capRowsBySize(
        result.rows,
        this.config.maxResultRows,
        this.config.maxResultBytes,
      );

      if (inReadOnlyTx) { await client.query('COMMIT'); inReadOnlyTx = false; }

      return {
        queryId: req.queryId,
        success: true,
        rows: cappedRows.rows,
        fields: (result.fields ?? []).map((f) => ({ name: f.name })),
        rowCount: cappedRows.truncated
          ? cappedRows.rows.length
          : result.rowCount ?? cappedRows.rows.length,
        truncated: cappedRows.truncated,
        duration: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.warn(`Query failed: ${message}`);
      return { queryId: req.queryId, success: false, error: message, duration: Date.now() - started };
    } finally {
      if (inReadOnlyTx) {
        await client.query('ROLLBACK').catch(() => undefined);
      } else if (!decision.readOnlyTx) {
        await client.query('RESET statement_timeout').catch(() => undefined);
      }
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function clampTimeout(requested: number, fallback: number): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1_000, Math.min(fallback, 60_000, Math.floor(n)));
}

function capRowsBySize(
  rows: unknown[],
  maxRows: number,
  maxBytes: number,
): { rows: unknown[]; truncated: boolean } {
  const capped: unknown[] = [];
  let bytes = 2;

  for (const row of rows) {
    if (capped.length >= maxRows) {
      return { rows: capped, truncated: true };
    }

    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (bytes + rowBytes > maxBytes) {
      return { rows: capped, truncated: true };
    }

    capped.push(row);
    bytes += rowBytes;
  }

  return { rows: capped, truncated: capped.length < rows.length };
}
