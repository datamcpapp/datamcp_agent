# DataMCP Agent

DataMCP Agent connects a private PostgreSQL database to DataMCP without opening inbound network access.

The agent runs inside your network, connects outbound to DataMCP Cloud over WebSocket, and executes database operations requested through your DataMCP MCP link.

## Install

### npx

```bash
npx @datamcp/agent --db postgresql://user:password@localhost:5432/app
```

### npm global

```bash
npm install -g @datamcp/agent
datamcp-agent --db postgresql://user:password@localhost:5432/app
```

### Homebrew

Homebrew uses the same official npm package under the hood:

```bash
brew tap datamcpapp/tap
brew install datamcp-agent
```

### Docker

```bash
docker run --rm \
  -e DATAMCP_DB_URL='postgresql://user:password@host.docker.internal:5432/app' \
  ghcr.io/datamcpapp/agent:latest
```

## Quick start

### Anonymous tunnel

Use this when you want to try DataMCP before creating a permanent dashboard connection:

```bash
npx @datamcp/agent --db postgresql://user:password@localhost:5432/app
```

The agent prints:

```text
MCP URL: https://api.datamcp.app/api/mcp/anon/...
Claim URL: https://dashboard.datamcp.app/claim?token=...
```

Anonymous tunnels are read-only and expire.

### Registered tunnel

Use this for a dashboard-created connection:

```bash
datamcp-agent \
  --db "$DATABASE_URL" \
  --api-key "$DATAMCP_API_KEY" \
  --connection-id "$DATAMCP_CONNECTION_ID"
```

The dashboard can generate this command for the user.

## Configuration

CLI flags win over environment variables.

| Flag | Env | Required | Description |
| --- | --- | --- | --- |
| `--db` | `DATAMCP_DB_URL` | Yes | PostgreSQL URL. Stays local to the agent. |
| `--api-key` | `DATAMCP_API_KEY` | Registered only | DataMCP API key for account-bound tunnel auth. |
| `--connection-id` | `DATAMCP_CONNECTION_ID` | Registered only | DataMCP connection id. |
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
- The database user should still be least-privilege. Read-only MCP links should use a read-only DB role.
- Do not paste agent tokens, API keys, claim tokens, or database URLs into logs or support tickets.
- Anonymous claim URLs are bearer secrets. Treat them as temporary one-time secrets.

## Release process

1. Update `package.json` and `src/version.ts` to the new version.
2. Run:

```bash
./scripts/release-check.sh
```

3. Create a Git tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

4. GitHub Actions publishes:
   - npm package: `@datamcp/agent`
   - Docker image: `ghcr.io/datamcpapp/agent`

5. Update the Homebrew formula tarball SHA in `datamcpapp/homebrew-tap`.

## License

MIT
