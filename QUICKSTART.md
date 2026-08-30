# DataMCP Agent Quickstart

## Fastest path

```bash
npx @datamcp/agent --db postgresql://user:password@localhost:5432/app
```

The agent will:

1. Check that the local database is reachable.
2. Create an outbound tunnel to DataMCP Cloud.
3. Print an MCP URL for AI tools.
4. Print a one-time claim URL to save the tunnel in your dashboard.

## Permanent dashboard connection

Create a tunnel connection in DataMCP Dashboard and run the generated command:

```bash
datamcp-agent \
  --db "$DATABASE_URL" \
  --api-key "$DATAMCP_API_KEY" \
  --connection-id "$DATAMCP_CONNECTION_ID"
```

## Install options

```bash
npm install -g @datamcp/agent
```

or:

```bash
brew tap datamcpapp/tap
brew install datamcp-agent
```

## Verify

```bash
datamcp-agent --version
datamcp-agent --help
curl http://localhost:3000/ready
```
