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

      if (inReadOnlyTx) { await client.query('COMMIT'); inReadOnlyTx = false; }

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
  return Math.max(1_000, Math.min(600_000, Math.floor(n)));
}
