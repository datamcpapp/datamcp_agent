# DataMCP Agent Quickstart

Install with `npx @datamcp/agent` for a one-off run or `npm install -g @datamcp/agent` for a persistent command. The Homebrew tap is not available yet.

## Fastest path

Create a Local Agent connection in the DataMCP dashboard, save its connection ID and scoped agent token, then run:

```bash
DATAMCP_AGENT_TOKEN="$YOUR_DATAMCP_AGENT_TOKEN" npx @datamcp/agent ro \
  'postgresql://user:password@localhost:5432/app' \
  --stage qa --connection-id "$DATAMCP_CONNECTION_ID"
```

The agent will:

1. Check that the local database is reachable.
2. Open an outbound tunnel to DataMCP.
3. Make the dashboard connection available to MCP links.

## Permanent dashboard connection

Create a tunnel connection in DataMCP Dashboard and run the generated command:

```bash
datamcp-agent \
  ro "$DATABASE_URL" \
  --agent-token "$DATAMCP_AGENT_TOKEN" \
  --connection-id "$DATAMCP_CONNECTION_ID" \
  --stage qa
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

For n8n, create an MCP link on the connection and use its URL in an MCP Client or MCP Client Tool node with a DataMCP Bearer credential.
