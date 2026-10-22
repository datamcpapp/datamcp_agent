# DataMCP Agent

DataMCP Agent connects a private PostgreSQL database to DataMCP without opening inbound network access.

The agent runs inside your network, connects outbound to DataMCP Cloud over WebSocket, and executes database operations requested through your DataMCP MCP link.

## Install

Install the agent with npm, npx, or Homebrew. Create a Local Agent connection in the dashboard before running it; the dashboard supplies the connection ID and a one-time agent token.

### npx

```bash
DATAMCP_AGENT_TOKEN="$YOUR_DATAMCP_AGENT_TOKEN" npx @datamcp/agent ro \
  "$DATABASE_URL" --stage qa --connection-id "$DATAMCP_CONNECTION_ID"
```

### npm global

```bash
npm install -g @datamcp/agent
DATAMCP_AGENT_TOKEN="$YOUR_DATAMCP_AGENT_TOKEN" datamcp-agent ro \
  "$DATABASE_URL" --stage qa --connection-id "$DATAMCP_CONNECTION_ID"
```

### Homebrew

Homebrew uses the same official npm package under the hood:

```bash
brew tap datamcpapp/tap
brew install datamcp-agent
```

Homebrew 7 may ask you to trust a third-party formula first. Trust only this formula with `brew trust --formula datamcpapp/tap/datamcp-agent`, then run the install command again.

### Docker

Build an image from the published npm package; no repository checkout or GitHub authentication is required:

```bash
docker build -t datamcp-agent:latest - <<'DOCKERFILE'
FROM node:22-alpine
RUN npm install -g @datamcp/agent@latest
USER node
ENTRYPOINT ["datamcp-agent"]
DOCKERFILE

docker run --rm --network host --env-file .env.agent datamcp-agent:latest
```

On Linux, `--network host` lets the container reach a database bound to `127.0.0.1`. On Docker Desktop, omit `--network host` and use `host.docker.internal` in `DATAMCP_DB_URL`.

## Quick start

### Registered tunnel

Use this for a dashboard-created connection:

```bash
DATAMCP_AGENT_TOKEN="$YOUR_DATAMCP_AGENT_TOKEN" datamcp-agent \
  ro "$DATABASE_URL" \
  --stage qa \
  --connection-id "$DATAMCP_CONNECTION_ID"
```

The dashboard generates the complete command. `ro` is a local read-only ceiling; use a read-only PostgreSQL role as well. For writes, omit `ro`, set `DATAMCP_READ_ONLY=false`, use a narrowly privileged PostgreSQL role, and select a read-write or full-access MCP link. All three layers must permit the operation.

The anonymous, account-free flow is not supported end to end yet. Create a Local Agent connection in the dashboard first.

On QA, the backend requires `ENABLE_AGENT_DEPLOYMENT=true` and the dashboard requires `NEXT_PUBLIC_ENABLE_AGENT_DEPLOYMENT=true`. Keep both disabled in production until QA validation is complete.

### Use from n8n

1. Create an MCP link for the Local Agent connection in DataMCP and choose a read-only scope.
2. In n8n, add **MCP Client** for a normal workflow step or **MCP Client Tool** under an AI Agent. Select **Streamable HTTP** transport.
3. Set the MCP endpoint to the link URL and configure a Bearer Auth credential with a DataMCP API key. The agent token only authenticates the outbound tunnel; do not use it as the n8n Bearer credential.
4. Test schema discovery and a small `SELECT` before enabling a scheduled workflow.

The database password stays with the agent, but SQL and query results travel through DataMCP and can also appear in n8n execution history.

## Configuration

CLI flags win over environment variables.

| Flag | Env | Required | Description |
| --- | --- | --- | --- |
| `--db` or `ro <url>` | `DATAMCP_DB_URL` | Yes | PostgreSQL URL. Stays local to the agent. `ro` also applies a local read-only ceiling. |
| `--agent-token` | `DATAMCP_AGENT_TOKEN` | Recommended | Connection-scoped token shown once during Local Agent setup. |
| `--api-key` | `DATAMCP_API_KEY` | Legacy only | Account API key for older tunnel connections. |
| `--connection-id` | `DATAMCP_CONNECTION_ID` | Yes | DataMCP connection id. |
| `--stage` | `DATAMCP_STAGE` | No | `production`, `qa`, or `development`; defaults to production. |
| `ro` | `DATAMCP_READ_ONLY=true` | Recommended | Local read-only ceiling. Enabled in the Docker and Kubernetes examples. |
| `--cloud-url` | `DATAMCP_CLOUD_URL` | No | DataMCP cloud URL. Default: `wss://api.datamcp.app`. |
| `--agent-name` | `AGENT_NAME` | No | Friendly name shown in DataMCP. |
| `--log-level` | `LOG_LEVEL` | No | `debug`, `info`, `warn`, or `error`. |
| `--port` | `PORT` | No | Local health server port. Default: `3000`. |

## Health checks

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

`/health` confirms the local process is alive.

`/ready` confirms the agent is connected to DataMCP Cloud.

## Security model

- Database credentials stay on the machine running the agent.
- The cloud sends SQL requests over an outbound WebSocket; it does not receive the DB URL.
- The database user should still be least-privilege. Read-only MCP links should use a read-only DB role. `ro` prevents write requests from the cloud, but is not a substitute for database privileges.
- Do not paste agent tokens, API keys, claim tokens, or database URLs into logs or support tickets.
- The dashboard's generated command uses `ro`. For stronger isolation, use a database role with only the SQL privileges the workflow needs.

## Release process

1. Update the version in `package.json` and `package-lock.json`. The CLI reads it from `package.json`.
2. Run:

```bash
./scripts/release-check.sh
```

3. Create a Git tag:

```bash
git tag "v$(node -p 'require("./package.json").version')"
git push origin "v$(node -p 'require("./package.json").version')"
```

4. GitHub Actions publishes:
   - npm package: `@datamcp/agent`
   - Docker image: `ghcr.io/datamcpapp/agent` (currently private to the organization; use the npm-based Docker build above for public installs)

5. The [Homebrew tap](https://github.com/datamcpapp/homebrew-tap) checks npm `latest` every six hours and updates its formula automatically. Run its `Update agent formula` workflow manually to make a new release available immediately.

## License

MIT
