# DataMCP Agent

## Project

Self-hosted agent (npm package `@datamcp/agent`, bin `datamcp`) for **safe access
to databases inside private networks**. Runs inside the customer's network, holds
DB credentials **locally**, connects **outbound** over a websocket to the DataMCP
cloud (`/agents` namespace). The database is never exposed to the internet.

Part of the DataMCP system: dashboard (`datamcp_g/datamcp`), server
(`datamcp_common/nestjs-app`), marketing (`datamcp_marketing_nextjs`). The cloud
sends SQL; the agent runs it locally under a policy and returns rows.

## Stack

- Node 18+, TypeScript (strict, commonjs). Intentionally lean.
- `socket.io-client` (tunnel), `pg` (database), `dotenv`, `uuid`. No framework.

## CLI

```
npx datamcp <policy> <database-url> [options]
```

`policy` is the agent's **local enforcement ceiling** (aliases in parens):

- `ro` (`read-only`) — reads only; every statement in `BEGIN TRANSACTION READ ONLY`.
- `rwd` (`read-write-delete`) — reads + INSERT/UPDATE/DELETE; DDL, multi-statement,
  SELECT INTO, and dangerous/dblink functions blocked. SELECT/other run read-only.
- `fa` (`full-access`) — unrestricted; the database role is the only limit.

Effective access = **intersection** of this ceiling and the cloud MCP link preset,
so the agent can never exceed its ceiling. Options: `--name`, `--stage`,
`--connection-id`, `--api-key`, `--anon-token`, `--cloud-url`,
`--statement-timeout`, `--selftest`, `--help`, `--version`. Env fallbacks in
`.env.example`; CLI flags win.

## Architecture

```
src/
  index.ts            # entrypoint: parse args, --selftest, verify DB, start tunnel
  cli.ts              # arg parser + help/version text
  config/index.ts     # resolveConfig(cli): policy + db url + stage/cloud + creds
  policy.ts           # CORE: Policy type, parsePolicy, classify(), decide()
  db/executor.ts      # runs SQL per decide(): read-only tx + statement_timeout
  security/read-only-guard.ts  # thin re-export of policy (back-compat)
  tunnel/
    client.ts         # socket.io: handshake auth, heartbeat, execute_query→query_result
    protocol.ts       # wire types (keep in sync with server agent-tunnel/types.ts)
  selftest.ts         # --selftest: prove the policy on a throwaway table, then exit
  health.ts           # HTTP /health for liveness probes
  logger.ts
```

`policy.ts::decide(policy, sql)` returns `{ allow, readOnlyTx, reason }` — the
single source of truth for enforcement. The **read-only transaction is the hard
control** (PostgreSQL rejects writes inside it, even ones a function called from a
SELECT attempts); the text checks fail fast and block escapes a transaction can't
(dblink opens a separate connection). This mirrors the server's read-only + preset
security work.

## Commands

```bash
npm run build          # -> dist/
npm run dev            # ts-node src/index.ts
npm run test:policy    # unit tests for decide() across ro/rwd/fa
npm run typecheck
node dist/index.js ro postgres://…/app --selftest   # live proof on a real DB
```

## Conventions

- Keep the dependency set minimal; no framework, no test runner (assertion scripts).
- `protocol.ts` must stay in sync with `nestjs-app/src/modules/agent-tunnel/types.ts`.
- Never log or commit credentials; `.env` is gitignored (agent holds DB creds locally).

## Status

v1 CLI + policy engine + executor + `--selftest` are complete and verified live.
The tunnel client is ready but **end-to-end (agent ↔ cloud) needs the server
`agent-tunnel` module merged** from `feature/local_tunnel` into `develop`, then a
Direct-vs-Tunnel driver switch wired into the server's `QueryExecutionService`.
