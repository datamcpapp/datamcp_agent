# DataMCP Agent

Self-hosted agent for **safe access to databases inside private networks**.

The agent runs inside your network, holds your database credentials **locally**, and
connects **outbound** to the DataMCP cloud over a websocket. Your database is never
exposed to the internet and no inbound firewall rules are required.

## Usage

```bash
npx @datamcp/agent <policy> <database-url> [options]
```

The **policy** is the agent's local enforcement ceiling:

| Policy | Aliases | Allows |
| --- | --- | --- |
| `ro`  | `read-only`         | reads only, every statement runs in a `READ ONLY` transaction |
| `rwd` | `read-write-delete` | reads + `INSERT`/`UPDATE`/`DELETE`; DDL & multi-statement blocked |
| `fa`  | `full-access`       | unrestricted, the database role is the only limit |

```bash
# read-only agent for a local database
npx @datamcp/agent ro postgres://user:pass@localhost:5432/app

# read/write/delete, named, pointed at the QA cloud
DATAMCP_STAGE=qa npx @datamcp/agent rwd localhost:5432/app --name analytics \
  --connection-id conn_… --api-key agent_…

# prove the policy holds on YOUR database, then exit (no cloud needed)
npx @datamcp/agent ro postgres://…/app --selftest
```

If you run the agent without `--connection-id`, it creates an anonymous tunnel,
prints a one-time claim token, and keeps the tunnel online. Paste that claim
token in the DataMCP dashboard to attach the tunnel to your workspace.

## Security model

The policy is enforced right at the database connection, **independent of and in
addition to** whatever the cloud MCP link permits. Effective access is the
intersection, so the agent can never exceed its ceiling. Under `ro` and `rwd`:

1. **Text guard**: blocks DDL, multi-statement, `SELECT INTO`, and dangerous
   functions (including quoted-identifier evasions like `"dblink_exec"(…)` and
   outbound `dblink*` calls that would escape the transaction).
2. **`BEGIN TRANSACTION READ ONLY`** for every read: PostgreSQL rejects any write
   inside it, including one a function called from a `SELECT` attempts. So a
   `SELECT malicious_writer()` cannot write even on a `rwd` agent.

`SET LOCAL statement_timeout` caps runaway/DoS queries.

Run `--selftest` to see all of this verified against your own database.

## Options

`--name`, `--stage`, `--connection-id`, `--api-key`, `--anon-token`, `--agent-token`, `--cloud-url`,
`--statement-timeout <ms>`, `--selftest`, `--help`, `--version`. Any of these can
also be set via env (see `.env.example`); CLI flags win.

## Development

```bash
npm install
npm run typecheck
npm run test:policy      # unit tests for the policy engine
npm run build            # -> dist/
node dist/index.js ro postgres://…/app --selftest
```

Wire protocol (`src/tunnel/protocol.ts`) matches the server `agent-tunnel` module
on the `/agents` websocket namespace.
