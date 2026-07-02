import { Pool, PoolClient } from 'pg';

import { AgentConfig } from '../config';
import { Logger } from '../logger';
import { checkReadOnly } from '../security/read-only-guard';
import {
  AgentExecuteQueryRequest,
  AgentExecuteQueryResult,
} from '../tunnel/protocol';

/**
 * Runs SQL against the local (private) database on behalf of the cloud.
 *
 * Read-only enforcement is layered exactly like the cloud path:
 *   1. text guard (checkReadOnly) — cheap, blocks obvious writes & escapes
 *   2. `BEGIN TRANSACTION READ ONLY` — hard, database-level backstop that
 *      rejects EVERY write (writable CTE, SELECT INTO, unparseable DML, ...)
 *      regardless of what the text guard did or did not catch.
 * `SET LOCAL statement_timeout` caps runaway/DoS queries.
 */
export class DbExecutor {
  private readonly pool: Pool;

  constructor(
    private readonly config: AgentConfig,
    private readonly logger: Logger,
  ) {
    const url = new URL(config.databaseUrl);
    // Accept self-signed certs the way the cloud executor does; still encrypt.
    const sslmode = url.searchParams.get('sslmode');
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      ssl:
        sslmode === 'disable'
          ? undefined
          : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }

  async verifyConnectivity(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const r = await client.query('SELECT current_user, current_database()');
      this.logger.info(
        `DB reachable as ${r.rows[0].current_user}/${r.rows[0].current_database}`,
      );
    } finally {
      client.release();
    }
  }

  async execute(
    req: AgentExecuteQueryRequest,
  ): Promise<AgentExecuteQueryResult> {
    const started = Date.now();

    if (this.config.readOnly) {
      const guard = checkReadOnly(req.sql);
      if (!guard.allowed) {
        this.logger.warn(`Blocked by read-only guard: ${guard.reason}`);
        return {
          queryId: req.queryId,
          success: false,
          error: `Rejected by agent read-only guard: ${guard.reason}`,
          duration: Date.now() - started,
        };
      }
    }

    const client = await this.pool.connect();
    const timeoutMs = clampTimeout(req.timeoutMs, this.config.statementTimeoutMs);
    let inReadOnlyTx = false;

    try {
      if (this.config.readOnly) {
        await client.query('BEGIN TRANSACTION READ ONLY');
        inReadOnlyTx = true;
        await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      } else {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
      }

      const result = await client.query({
        text: req.sql,
        values: req.params ?? [],
      });

      if (inReadOnlyTx) {
        await client.query('COMMIT');
        inReadOnlyTx = false;
      }

      return {
        queryId: req.queryId,
        success: true,
        rows: result.rows,
        fields: (result.fields ?? []).map((f) => ({ name: f.name })),
        rowCount: result.rowCount ?? 0,
        duration: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.warn(`Query failed: ${message}`);
      return {
        queryId: req.queryId,
        success: false,
        error: message,
        duration: Date.now() - started,
      };
    } finally {
      if (inReadOnlyTx) {
        await client.query('ROLLBACK').catch(() => undefined);
      } else if (!this.config.readOnly) {
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
  return Math.max(1_000, Math.min(600_000, Math.floor(n)));
}
