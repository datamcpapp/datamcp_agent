import { performance } from "node:perf_hooks";
import { QueryRequest, QueryResult } from "../types";

export interface HealthQueryRequest extends QueryRequest {
  executionContext: "postgres-health";
  issuedAt: number;
  deadlineAt: number;
}

export type HealthQueryOutput = Pick<
  QueryResult,
  "rows" | "fields" | "rowCount" | "truncated"
>;

type Execution = {
  controller: AbortController;
  promise: Promise<QueryResult>;
};

export function healthErrorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (code === "HEALTH_EXECUTION_UNCERTAIN") return "execution_uncertain";
  if (code === "42501") return "permission_required";
  if (code === "28P01" || code === "28000") return "credentials_rejected";
  if (code === "57014") return "deadline_exceeded";
  if (
    code.startsWith("08") ||
    ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "57P01"].includes(code)
  )
    return "database_unreachable";
  return "collector_unavailable";
}

export class HealthExecutionManager {
  private readonly active = new Map<string, Execution>();
  private readonly completed = new Map<
    string,
    { at: number; result: QueryResult }
  >();
  private readonly cancelled = new Map<string, number>();

  get activeQueryId(): string | null {
    return this.active.keys().next().value ?? null;
  }

  cancel(queryId: string): Promise<QueryResult> {
    if (typeof queryId !== "string" || queryId.length > 128)
      return Promise.resolve({
        queryId: "",
        success: false,
        error: "invalid_health_request",
        duration: 0,
        terminalState: "failed",
      });
    this.prune();
    const active = this.active.get(queryId);
    if (active) {
      active.controller.abort();
      return active.promise;
    }
    const completed = this.completed.get(queryId);
    if (completed) return Promise.resolve(completed.result);
    if (this.cancelled.size < 4096)
      this.cancelled.set(queryId, performance.now());
    return Promise.resolve({
      queryId,
      success: false,
      error: "cancelled",
      duration: 0,
      terminalState: "cancelled",
    });
  }

  execute(
    request: HealthQueryRequest,
    operation: (
      signal: AbortSignal,
      budgetMs: number,
    ) => Promise<HealthQueryOutput>,
  ): Promise<QueryResult> {
    this.prune();
    if (
      typeof request?.queryId !== "string" ||
      !request.queryId.length ||
      request.queryId.length > 128
    )
      return Promise.resolve({
        queryId: "",
        success: false,
        error: "invalid_health_request",
        duration: 0,
        terminalState: "failed",
      });
    const prior = this.completed.get(request.queryId);
    if (prior) return Promise.resolve(prior.result);
    const active = this.active.get(request.queryId);
    if (active) return active.promise;
    const failed = (
      error: string,
      terminalState: QueryResult["terminalState"] = "failed",
    ) => {
      const result: QueryResult = {
        queryId: request.queryId,
        success: false,
        error,
        duration: 0,
        terminalState,
      };
      if (this.completed.size < 4096)
        this.completed.set(request.queryId, { at: performance.now(), result });
      return Promise.resolve(result);
    };
    if (this.cancelled.has(request.queryId))
      return failed("cancelled", "cancelled");
    if (this.active.size) return failed("health_busy", "busy");
    if (this.completed.size >= 4096 || this.cancelled.size >= 4096)
      return failed("collector_capacity");
    if (
      request.readOnly !== true ||
      !Number.isFinite(request.issuedAt) ||
      !Number.isFinite(request.deadlineAt)
    )
      return failed("invalid_health_request");
    const now = Date.now();
    if (Math.abs(now - request.issuedAt) > 5000) return failed("clock_skew");
    const budgetMs = Math.min(
      30000,
      request.deadlineAt - request.issuedAt,
      request.deadlineAt - now,
    );
    if (budgetMs <= 0) return failed("deadline_exceeded", "cancelled");
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let resolve!: (result: QueryResult) => void;
    const promise = new Promise<QueryResult>((done) => {
      resolve = done;
    });
    this.active.set(request.queryId, { controller, promise });
    void (async () => {
      let result: QueryResult;
      try {
        const output = await operation(controller.signal, budgetMs);
        result = {
          queryId: request.queryId,
          success: true,
          ...output,
          duration: performance.now() - started,
          terminalState: "completed",
        };
      } catch (error) {
        result = {
          queryId: request.queryId,
          success: false,
          error: healthErrorCode(error),
          duration: performance.now() - started,
          terminalState:
            healthErrorCode(error) === "execution_uncertain"
              ? "uncertain"
              : "failed",
        };
      }
      clearTimeout(timer);
      if (
        result.terminalState !== "uncertain" &&
        (controller.signal.aborted || performance.now() - started >= budgetMs)
      ) {
        result = {
          queryId: request.queryId,
          success: false,
          error: "cancelled",
          duration: performance.now() - started,
          terminalState: "cancelled",
        };
      }
      if (result.terminalState !== "uncertain")
        this.active.delete(request.queryId);
      this.completed.set(request.queryId, { at: performance.now(), result });
      resolve(result);
    })();
    return promise;
  }

  confirmReleased(queryId: string): QueryResult | undefined {
    const previous = this.completed.get(queryId)?.result;
    if (previous?.terminalState !== "uncertain") return previous;
    const result: QueryResult = {
      queryId,
      success: false,
      error: "cancelled",
      duration: previous.duration,
      terminalState: "cancelled",
    };
    this.active.delete(queryId);
    this.completed.set(queryId, { at: performance.now(), result });
    return result;
  }

  private prune(): void {
    const cutoff = performance.now() - 300000;
    for (const [id, result] of this.completed)
      if (result.at < cutoff && !this.active.has(id)) this.completed.delete(id);
    for (const [id, at] of this.cancelled)
      if (at < cutoff) this.cancelled.delete(id);
  }
}
