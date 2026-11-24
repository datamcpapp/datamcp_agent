# PostgreSQL Health transport — 0.1.10

This patch extends the shipped main/0.1.9 agent with an optional Health execution contract. The agent develop branch predates that shipped implementation, so the PR targets main. Backend and dashboard PRs target their separate develop branches. Publishing this patch is a separate owner action; no package/image has been published by the implementation task.

Health requires both `readOnlyRequestV1` and `healthExecutionV1`. Registration/heartbeats advertise a clock reading, active Health query id and SHA256 target fingerprint derived from node-postgres's resolved host, port, database and user. Passwords are excluded; credential changes remain fenced by the backend Source generation. Older agents continue ordinary query/schema behavior but cannot provide Health.

Health packets carry `executionContext=postgres-health`, query id, issued time, absolute deadline, timeout, readOnly, maxRows, SQL and parameters. The cloud Health collector owns the fixed SELECT catalog; the user-facing Health API cannot submit SQL. The authenticated tunnel contract enforces a read-only transaction even when the configured database role is a superuser. A separate max1-client pool protects overlap with Health work, with server statement/idle-in-transaction limits and bounded client read/acquire timeouts. At most20 rows/64KB are returned, without exposing provider error text.

Execution states distinguish completed, failed, cancelled, busy and uncertain. Repeated ids return their recorded result; pre-arrival cancellation has a bounded tombstone. Deadline/cancel acknowledgement waits for bounded cleanup. Cancellation checks PID and exact backend_start before signalling PostgreSQL. Losing a response is not evidence that SQL stopped: an uncertain id remains active and blocks another Health query until database state confirms release. A silent TCP blackhole resolves as uncertain within the client budget rather than leaving an unresolved promise indefinitely. Reconciliation and cancellation connections also have read/connect limits. Heartbeat reconciliation can report a subsequently confirmed terminal state.

Ordinary request-level readonly and bounded streaming from main remain intact. Health credentials stay in the local agent configuration; the cloud receives bounded statistics, capability/target metadata and results. SQL statistics do not supply host CPU/RAM/free disk, and one agent/Source represents one database.

## Validation

```sh
npm ci
npm run build
DATAMCP_TEST_DATABASE_URL=postgresql://postgres:health_fixture_only@127.0.0.1:56516/health_fixture DATAMCP_TEST_WRITE=1 npm test
HEALTH_FIXTURE_DATABASE_URL=postgresql://postgres:health_fixture_only@127.0.0.1:56516/health_fixture node --test test/health-database.live.js
```

These addresses and the clearly disposable password belong to backend `scripts/postgres-health/compose.yaml`, not customer configuration. The backend's `health:agent-tests` command repeats the live Health suite on PostgreSQL15–18. The test account deliberately has no business-table grants for the Health onboarding scenario; separate superuser fixture cases prove DB-level readonly against a writing SELECT function. The full ordinary suite includes auth rejection, reconnect/replay and read/write regressions.

Observed:34 ordinary/unit/live checks passed with no skips;6 additional Health database cases passed on each of15,16,17,18, including cancellation/rollback/reuse, row bounds, provider-error redaction, connection loss and a proxy that silently discards responses. Backend HTTP/browser runs also exercised real tunnel onboarding, two offline scheduled checks with no SQL dispatch, new-session reconnect and recovery. These fixtures do not certify arbitrary network latency, PostgreSQL19 or absolute exactly-once execution.

Release: backend additive protocol support with flags off → publish compatible agent patch/image → dashboard rollout → explicit pilot enablement. An agent update is mandatory for private Health; direct Health has no agent dependency. Do not enable Health on a version string alone—use capabilities and current session/fingerprint metadata.

The pre-existing `npm run lint` script has no ESLint config in this repository and cannot run. The repository CI uses build, test and pack dry-run; those commands passed. This is a tooling limitation, not a zero-warning lint claim.
