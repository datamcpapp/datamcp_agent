const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { Client } = require("pg");
const {
  HealthDatabaseExecutor,
} = require("../dist/services/health-database-executor");
const url = process.env.HEALTH_FIXTURE_DATABASE_URL;
if (!url) throw new Error("HEALTH_FIXTURE_DATABASE_URL is required");
const executor = new HealthDatabaseExecutor(url);
const admin = new Client({ connectionString: url });
after(async () => {
  await executor.close();
  await admin.end();
});
function request(sql, extra = {}) {
  const now = Date.now();
  return {
    queryId: crypto.randomUUID(),
    sql,
    params: [],
    readOnly: true,
    timeoutMs: 1000,
    maxRows: 20,
    executionContext: "postgres-health",
    issuedAt: now,
    deadlineAt: now + 30000,
    ...extra,
  };
}

test("request read-only rejects a SELECT function that writes even for a superuser", async () => {
  await admin.connect();
  await admin.query(
    "create table if not exists public.health_write_probe(id integer)",
  );
  await admin.query(
    "create or replace function public.health_write_probe_fn() returns integer language plpgsql as $$ begin insert into public.health_write_probe values (1); return 1; end $$",
  );
  const result = await executor.execute(
    request("select public.health_write_probe_fn()"),
  );
  assert.equal(result.success, false);
  assert.equal(result.error, "collector_unavailable");
  assert.equal(
    (
      await admin.query(
        "select count(*)::int as count from public.health_write_probe",
      )
    ).rows[0].count,
    0,
  );
});

test("caps results at the request ceiling and leaves the connection usable", async () => {
  const result = await executor.execute(
    request("select n from pg_catalog.generate_series(1,100) n", {
      maxRows: 2,
    }),
  );
  assert.equal(result.success, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(
    (await executor.execute(request("select 1 as ok"))).success,
    true,
  );
});

test("cancels active SQL, acknowledges only after rollback, and accepts the next request", async () => {
  const req = request("select pg_catalog.pg_sleep(20)", { timeoutMs: 5000 });
  const running = executor.execute(req);
  let active = false;
  for (let n = 0; n < 40; n++) {
    const observed = await admin.query(
      "select count(*)::int as count from pg_catalog.pg_stat_activity where application_name='datamcp-postgres-health' and state='active' and wait_event='PgSleep'",
    );
    if (observed.rows[0].count > 0) {
      active = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    active,
    true,
    "The fixture must be executing SQL before cancellation",
  );
  const cancelStarted = Date.now();
  executor.cancel(req.queryId);
  const terminal = await running;
  assert.equal(
    Date.now() - cancelStarted < 2000,
    true,
    "Cancellation must reach PostgreSQL before the statement timeout",
  );
  assert.equal(terminal.terminalState, "cancelled");
  assert.equal(terminal.success, false);
  assert.equal(
    (await executor.execute(request("select 1 as ok"))).success,
    true,
  );
  const current = await admin.query(
    "select count(*)::int as count from pg_catalog.pg_stat_activity where application_name='datamcp-postgres-health' and state='idle in transaction'",
  );
  assert.equal(current.rows[0].count, 0);
});

test("does not expose a secret provider error", async () => {
  const result = await executor.execute(
    request('select "HEALTH_SECRET_MARKER"'),
  );
  assert.equal(result.success, false);
  assert.equal(JSON.stringify(result).includes("HEALTH_SECRET_MARKER"), false);
});

test("lost SQL connection stays uncertain until database release is confirmed", async () => {
  const running = executor.execute(
    request("select pg_catalog.pg_sleep(20)", { timeoutMs: 5000 }),
  );
  let pid;
  for (let n = 0; n < 40; n++) {
    const observed = await admin.query(
      "select pid from pg_catalog.pg_stat_activity where application_name='datamcp-postgres-health' and state='active' and wait_event='PgSleep'",
    );
    if (observed.rows[0]) {
      pid = observed.rows[0].pid;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(pid);
  await admin.query("select pg_catalog.pg_terminate_backend($1)", [pid]);
  const uncertain = await running;
  assert.equal(uncertain.terminalState, "uncertain");
  assert.equal(
    (await executor.execute(request("select 1"))).terminalState,
    "busy",
  );
  const released = await executor.reconcileUncertain();
  assert.equal(released.length, 1);
  assert.equal(released[0].terminalState, "cancelled");
  assert.equal((await executor.execute(request("select 1"))).success, true);
});
test("a silent TCP blackhole returns uncertain and keeps overlap blocked within a bounded time", async () => {
  const net = require("node:net");
  const target = new URL(url);
  const sockets = new Set();
  let blackhole = false;
  const server = net.createServer((downstream) => {
    const upstream = net.connect({
      host: target.hostname,
      port: Number(target.port || 5432),
    });
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.on("data", (data) => upstream.write(data));
    upstream.on("data", (data) => {
      if (!blackhole) downstream.write(data);
    });
    for (const socket of [downstream, upstream])
      socket.on("error", () => undefined);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxyUrl = new URL(url);
  proxyUrl.hostname = "127.0.0.1";
  proxyUrl.port = String(server.address().port);
  const isolated = new HealthDatabaseExecutor(proxyUrl.toString());
  let running;
  try {
    running = isolated.execute(
      request("select pg_catalog.pg_sleep(20)", { timeoutMs: 5000 }),
    );
    let active = false;
    for (let n = 0; n < 40; n++) {
      const observed = await admin.query(
        "select count(*)::int as count from pg_catalog.pg_stat_activity where application_name='datamcp-postgres-health' and state='active' and wait_event='PgSleep'",
      );
      if (observed.rows[0].count > 0) {
        active = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(active, true);
    blackhole = true;
    let timer;
    const terminal = await Promise.race([
      running,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 16000);
      }),
    ]);
    clearTimeout(timer);
    assert.ok(
      terminal,
      "The agent must resolve an unknown execution without waiting for a TCP error",
    );
    assert.equal(terminal.terminalState, "uncertain");
    assert.equal(
      (await isolated.execute(request("select 1"))).terminalState,
      "busy",
    );
    const started = Date.now();
    await isolated.reconcileUncertain();
    assert.ok(Date.now() - started < 4000);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (running) await running;
    await isolated.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
