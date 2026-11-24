import {
  Client,
  Pool,
  PoolClient,
  Query,
  QueryConfig,
  QueryResult as PgQueryResult,
} from "pg";
import { performance } from "node:perf_hooks";
import { QueryResult } from "../types";
import { boundReadQuery } from "./query-result-policy";
import {
  HealthExecutionManager,
  HealthQueryRequest,
} from "./health-execution-manager";

export class HealthDatabaseExecutor {
  private readonly manager = new HealthExecutionManager();
  private readonly pool: Pool;
  private readonly uncertain = new Map<
    string,
    { pid: number; backendStart: string }
  >();
  private reconciling = false;

  constructor(private readonly databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 90000,
      application_name: "datamcp-postgres-health",
      query_timeout: 6000,
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: 5000,
    });
    this.pool.on("error", () => undefined);
  }

  get activeQueryId(): string | null {
    return this.manager.activeQueryId;
  }

  cancel(queryId: string): Promise<QueryResult> {
    return this.manager.cancel(queryId);
  }

  execute(request: HealthQueryRequest): Promise<QueryResult> {
    return this.manager.execute(request, async (signal, budgetMs) => {
      const started = performance.now();
      let client: PoolClient | undefined;
      let transactionOpen = false;
      let broken = false;
      let pid: number | undefined;
      let backendStart: string | undefined;
      let sent = false;
      let connectionLost = false;
      const connectionError = () => {
        connectionLost = true;
      };
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        if (pid && !cancellation)
          cancellation = this.cancelBackend(pid, backendStart!);
      };
      const check = () => {
        if (signal.aborted || performance.now() - started >= budgetMs)
          throw Object.assign(new Error("cancelled"), { code: "57014" });
      };
      try {
        client = await this.pool.connect();
        client.on("error", connectionError);
        check();
        await client.query("BEGIN TRANSACTION READ ONLY");
        transactionOpen = true;
        const timeoutMs = Math.max(
          1,
          Math.min(
            5000,
            Math.floor(Number(request.timeoutMs) || 3000),
            Math.floor(budgetMs - (performance.now() - started)),
          ),
        );
        await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
        await client.query("SET LOCAL search_path = pg_catalog");
        await client.query(
          "SET LOCAL idle_in_transaction_session_timeout = 5000",
        );
        const identity = (
          await client.query<{ pid: number; backend_start: string }>(
            "SELECT pid,backend_start::text AS backend_start FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()",
          )
        ).rows[0];
        pid = identity.pid;
        backendStart = identity.backend_start;
        signal.addEventListener("abort", cancel, { once: true });
        check();
        const maxRows =
          Number.isInteger(request.maxRows) && request.maxRows! > 0
            ? Math.min(20, request.maxRows!)
            : 20;
        const config: QueryConfig & { queryMode: "extended" } = {
          text: boundReadQuery(request.sql, maxRows),
          values: request.params ?? [],
          queryMode: "extended",
        };
        let resolveQuery!: (result: PgQueryResult) => void;
        let rejectQuery!: (error: Error) => void;
        const pending = new Promise<PgQueryResult>((resolve, reject) => {
          resolveQuery = resolve;
          rejectQuery = reject;
        });
        const query = new Query(config, (error, result) =>
          error ? rejectQuery(error) : resolveQuery(result),
        );
        const rows: Record<string, unknown>[] = [];
        let bytes = 2;
        let truncated = false;
        query.on("row", (row: Record<string, unknown>) => {
          const size = Buffer.byteLength(JSON.stringify(row)) + 1;
          if (rows.length >= maxRows || bytes + size > 64000) truncated = true;
          else {
            rows.push(row);
            bytes += size;
          }
        });
        sent = true;
        client.query(query);
        const result = await pending;
        check();
        await client.query("ROLLBACK");
        transactionOpen = false;
        check();
        return {
          rows,
          fields: result.fields.map((field) => ({ name: field.name })),
          rowCount: rows.length,
          truncated,
        };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (!code || connectionLost) broken = true;
        if (
          sent &&
          pid &&
          backendStart &&
          (connectionLost ||
            !code ||
            code.startsWith("08") ||
            ["57P01", "ECONNRESET", "EPIPE"].includes(code))
        ) {
          this.uncertain.set(request.queryId, { pid, backendStart });
          throw Object.assign(new Error("execution_uncertain"), {
            code: "HEALTH_EXECUTION_UNCERTAIN",
          });
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (cancellation) await cancellation;
        if (client) {
          if (transactionOpen && !broken) {
            try {
              await client.query("ROLLBACK");
            } catch {
              broken = true;
            }
          }
          client.release(broken || connectionLost);
          client.removeListener("error", connectionError);
        }
      }
    });
  }

  async reconcileUncertain(): Promise<QueryResult[]> {
    if (this.reconciling || !this.uncertain.size) return [];
    this.reconciling = true;
    const results: QueryResult[] = [];
    const recovery = new Client({
      connectionString: this.databaseUrl,
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
      query_timeout: 1500,
    });
    recovery.on("error", () => undefined);
    try {
      await recovery.connect();
      for (const [queryId, identity] of this.uncertain) {
        const status = await recovery.query<{
          state: string;
          xact_start: Date | null;
        }>(
          "SELECT state,xact_start FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz",
          [identity.pid, identity.backendStart],
        );
        if (
          !status.rows.length ||
          (status.rows[0].state === "idle" &&
            status.rows[0].xact_start === null)
        ) {
          const terminal = this.manager.confirmReleased(queryId);
          this.uncertain.delete(queryId);
          if (terminal) results.push(terminal);
        }
      }
    } catch {
      return results;
    } finally {
      this.reconciling = false;
      await recovery.end().catch(() => undefined);
    }
    return results;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async cancelBackend(
    pid: number,
    backendStart: string,
  ): Promise<void> {
    const cancellation = new Client({
      connectionString: this.databaseUrl,
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
      query_timeout: 1500,
      application_name: "datamcp-postgres-health-cancel",
    });
    cancellation.on("error", () => undefined);
    try {
      await cancellation.connect();
      await cancellation.query(
        "SELECT pg_catalog.pg_cancel_backend(pid) FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz",
        [pid, backendStart],
      );
    } catch {
      return;
    } finally {
      await cancellation.end().catch(() => undefined);
    }
  }
}
