const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  HealthExecutionManager,
} = require("../dist/services/health-execution-manager");

function request(queryId = "health-1") {
  const now = Date.now();
  return {
    queryId,
    sql: "select 1",
    params: [],
    timeoutMs: 1000,
    readOnly: true,
    maxRows: 20,
    executionContext: "postgres-health",
    issuedAt: now,
    deadlineAt: now + 30000,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("blocks overlap until cancelled SQL has actually completed cleanup", async () => {
  const manager = new HealthExecutionManager();
  const cleanup = deferred();
  let aborted = false;
  const pending = manager.execute(request(), async (signal) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    await cleanup.promise;
    return { rows: [{ value: 1 }], fields: [], rowCount: 1 };
  });
  manager.cancel("health-1");
  assert.equal(aborted, true);
  const busy = await manager.execute(request("health-2"), async () => {
    throw new Error("must not dispatch");
  });
  assert.equal(busy.error, "health_busy");
  cleanup.resolve();
  const terminal = await pending;
  assert.equal(terminal.terminalState, "cancelled");
  assert.equal(terminal.success, false);
  assert.equal(terminal.rows, undefined);
});

test("cancel before execute prevents SQL and duplicate packets reuse terminal state", async () => {
  const manager = new HealthExecutionManager();
  manager.cancel("health-late");
  const execute = () =>
    manager.execute(request("health-late"), async () => {
      throw new Error("must not execute");
    });
  assert.equal((await execute()).terminalState, "cancelled");
  assert.equal((await execute()).terminalState, "cancelled");
});

test("rejects skewed or expired deadline before dispatch", async () => {
  const manager = new HealthExecutionManager();
  for (const changes of [
    { issuedAt: Date.now() - 60000 },
    { deadlineAt: Date.now() - 1 },
  ]) {
    const result = await manager.execute(
      { ...request(), ...changes },
      async () => {
        throw new Error("must not execute");
      },
    );
    assert.equal(result.success, false);
    assert.match(result.error, /clock_skew|deadline_exceeded/);
  }
});

test("redacts provider errors before they leave the health execution boundary", async () => {
  const manager = new HealthExecutionManager();
  const result = await manager.execute(request(), async () => {
    const error = new Error("HEALTH_SECRET_MARKER");
    error.code = "42501";
    throw error;
  });
  assert.equal(result.error, "permission_required");
  assert.equal(JSON.stringify(result).includes("HEALTH_SECRET_MARKER"), false);
});

test("coalesces duplicate in-flight packets and does not execute twice", async () => {
  const manager = new HealthExecutionManager();
  const complete = deferred();
  let executions = 0;
  const req = request();
  const operation = async () => {
    executions++;
    await complete.promise;
    return { rows: [], fields: [], rowCount: 0 };
  };
  const a = manager.execute(req, operation);
  const b = manager.execute(req, operation);
  complete.resolve();
  assert.deepEqual(await a, await b);
  assert.equal(executions, 1);
  assert.deepEqual(await manager.execute(req, operation), await a);
  assert.equal(executions, 1);
});

test("keeps an uncertain execution busy until the database confirms release", async () => {
  const manager = new HealthExecutionManager();
  const result = await manager.execute(request("uncertain"), async () => {
    throw Object.assign(new Error("HEALTH_SECRET_MARKER"), {
      code: "HEALTH_EXECUTION_UNCERTAIN",
    });
  });
  assert.equal(result.terminalState, "uncertain");
  assert.equal(manager.activeQueryId, "uncertain");
  assert.equal(
    (
      await manager.execute(request("next"), async () => {
        throw new Error("must not dispatch");
      })
    ).error,
    "health_busy",
  );
  const confirmed = manager.confirmReleased("uncertain");
  assert.equal(confirmed.terminalState, "cancelled");
  assert.equal(manager.activeQueryId, null);
  assert.equal(
    (
      await manager.execute(request("after-confirmation"), async () => ({
        rows: [],
        fields: [],
        rowCount: 0,
      }))
    ).success,
    true,
  );
});

test("a rejected busy request remains terminal when a late duplicate arrives", async () => {
  const manager = new HealthExecutionManager();
  const cleanup = deferred();
  const running = manager.execute(request("active-before-busy"), async () => {
    await cleanup.promise;
    return { rows: [], fields: [], rowCount: 0 };
  });
  const blocked = request("busy-late");
  assert.equal(
    (
      await manager.execute(blocked, async () => {
        throw new Error("must not execute");
      })
    ).terminalState,
    "busy",
  );
  cleanup.resolve();
  await running;
  const late = await manager.execute(blocked, async () => ({
    rows: [{ unsafe: 1 }],
    fields: [],
    rowCount: 1,
  }));
  assert.equal(late.terminalState, "busy");
  assert.equal(late.rows, undefined);
});

test("an uncertain execution can be reconciled after the replay retention window", async () => {
  const manager = new HealthExecutionManager();
  await manager.execute(request("old-uncertain"), async () => {
    throw Object.assign(new Error("lost"), {
      code: "HEALTH_EXECUTION_UNCERTAIN",
    });
  });
  manager.completed.get("old-uncertain").at = -Infinity;
  assert.equal(
    (
      await manager.execute(request("while-uncertain"), async () => ({
        rows: [],
        fields: [],
        rowCount: 0,
      }))
    ).terminalState,
    "busy",
  );
  manager.confirmReleased("old-uncertain");
  assert.equal(manager.activeQueryId, null);
});
