# DataMCP Agent

Self-hosted agent for **safe access to databases inside private networks**.

The agent runs inside your network, holds your database credentials **locally**, and
connects **outbound** to the DataMCP cloud over a websocket. Your database is never
exposed to the internet, and no inbound firewall rules are required. The cloud sends
SQL, the agent runs it locally, and returns the rows.

## Security model

Every query the agent runs is, by default, enforced read-only in **two layers** —
the same defense used on the cloud's direct path:

1. **Text guard** (`src/security/read-only-guard.ts`) — blocks writes, DDL,
   multi-statements, and dangerous functions (including quoted-identifier evasions
   like `"dblink_exec"(...)` and outbound `dblink*` calls that would escape the
   transaction).
2. **`BEGIN TRANSACTION READ ONLY`** — a hard, database-level backstop: PostgreSQL
   rejects every write path regardless of what the text guard caught.

`SET LOCAL statement_timeout` caps runaway/DoS queries. Set `AGENT_READ_ONLY=false`
only for an explicitly read-write connection.

## Quick start

```bash
npm install
cp .env.example .env      # fill in connection id, api key, DATABASE_URL
npm run build
npm start
```

Point at the QA cloud while testing (mirrors the server/dashboard stage convention):

```bash
DATAMCP_STAGE=qa npm run dev
```

### Docker

```bash
docker build -t datamcp-agent .
docker run -d --name datamcp-agent --env-file .env --restart unless-stopped datamcp-agent
```

## Configuration

See [`.env.example`](./.env.example). Key vars: `DATAMCP_STAGE` (production | qa |
staging | development), `DATAMCP_CONNECTION_ID`, `DATAMCP_API_KEY` (or
`DATAMCP_ANON_TOKEN`), `DATABASE_URL`, `AGENT_READ_ONLY`.

## Tests

```bash
npm run test:guard    # asserts the read-only guard blocks known bypasses
npm run typecheck
```

## Protocol

Talks to the server `agent-tunnel` module on the `/agents` websocket namespace.
Wire types live in `src/tunnel/protocol.ts` and must stay in sync with
`nestjs-app/src/modules/agent-tunnel/types.ts`.
