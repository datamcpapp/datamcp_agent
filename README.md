# DataMCP Agent

Self-hosted agent for connecting private PostgreSQL databases to DataMCP Cloud.

## Overview

The DataMCP Agent runs in your private network and establishes a secure WebSocket connection to DataMCP Cloud. It enables you to:

- Connect databases behind firewalls or in private networks
- Execute queries securely without exposing your database to the internet
- Extract database schemas automatically
- Monitor database health in real-time

> **Note:** If you see TypeScript errors in your IDE, this is normal before installing dependencies. See [TYPESCRIPT_ERRORS.md](TYPESCRIPT_ERRORS.md) for details.

## Architecture

```
┌─────────────────┐         WebSocket (WSS)         ┌──────────────────┐
│  DataMCP Cloud  │ ◄──────────────────────────────► │  DataMCP Agent   │
│  (Public)       │                                  │  (Your Network)  │
└─────────────────┘                                  └────────┬─────────┘
                                                              │
                                                              │ PostgreSQL
                                                              │ Protocol
                                                              ▼
                                                     ┌──────────────────┐
                                                     │  Your Database   │
                                                     │  (Private)       │
                                                     └──────────────────┘
```

## Prerequisites

- Node.js 18+ (for local development)
- Docker (for containerized deployment)
- PostgreSQL database to connect to

## Quick Start

### 1. Get Your API Key

1. Go to [DataMCP Dashboard](https://datamcp.com/agents)
2. Click "Create Agent"
3. Copy your API key (starts with `agent_`)
4. Download the credentials JSON file

### 2. Deploy with Docker Compose (Recommended)

```bash
# Create .env file
cat > .env << EOF
DATAMCP_API_KEY=agent_your_api_key_here
DATAMCP_CLOUD_URL=wss://api.datamcp.com
AGENT_NAME=My Production Agent
LOG_LEVEL=info
EOF

# Start the agent
docker-compose up -d

# Check logs
docker-compose logs -f
```

### 3. Deploy with Docker

```bash
docker run -d \
  --name datamcp-agent \
  --restart unless-stopped \
  -e DATAMCP_API_KEY=agent_your_api_key_here \
  -e DATAMCP_CLOUD_URL=wss://api.datamcp.com \
  -e AGENT_NAME="My Agent" \
  -e LOG_LEVEL=info \
  -p 3000:3000 \
  datamcp/agent:latest
```

### 4. Deploy with Kubernetes

```bash
# Create secret with API key
kubectl create secret generic datamcp-agent \
  --from-literal=api-key=agent_your_api_key_here

# Apply deployment
kubectl apply -f k8s/deployment.yaml

# Check status
kubectl get pods -l app=datamcp-agent
kubectl logs -l app=datamcp-agent -f
```

### 5. Run with Node.js

**Important:** First install dependencies!

```bash
# Navigate to agent directory
cd datamcp_agent

# Install dependencies (REQUIRED)
npm install

# Build
npm run build

# Create .env file
cp .env.example .env
# Edit .env with your API key

# Start
npm start
```

**Note:** TypeScript errors in your IDE will disappear after running `npm install`.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATAMCP_API_KEY` | ✅ Yes | - | Agent API key from DataMCP dashboard |
| `DATAMCP_CLOUD_URL` | No | `wss://api.datamcp.com` | DataMCP cloud WebSocket URL |
| `AGENT_NAME` | No | Hostname | Friendly name for the agent |
| `HEARTBEAT_INTERVAL` | No | `30000` | Heartbeat interval in milliseconds (5000-300000) |
| `LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `PORT` | No | `3000` | HTTP port for health checks |

### Example .env File

```bash
# Required
DATAMCP_API_KEY=agent_abc123xyz789

# Optional
DATAMCP_CLOUD_URL=wss://api.datamcp.com
AGENT_NAME=Production Database Agent
HEARTBEAT_INTERVAL=30000
LOG_LEVEL=info
PORT=3000
```

## Health Checks

The agent exposes HTTP endpoints for health monitoring:

### Liveness Probe
```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-22T10:30:00.000Z",
  "uptime": 3600,
  "memory": {...},
  "version": "1.0.0"
}
```

### Readiness Probe
```bash
curl http://localhost:3000/ready
```

Response when connected:
```json
{
  "status": "ready",
  "connected": true,
  "agentId": "agent_abc123",
  "timestamp": "2024-01-22T10:30:00.000Z"
}
```

## Monitoring

### Docker Compose

```bash
# View logs
docker-compose logs -f datamcp-agent

# Check status
docker-compose ps

# Restart agent
docker-compose restart datamcp-agent
```

### Kubernetes

```bash
# View logs
kubectl logs -l app=datamcp-agent -f

# Check status
kubectl get pods -l app=datamcp-agent

# Describe pod
kubectl describe pod -l app=datamcp-agent

# Restart
kubectl rollout restart deployment/datamcp-agent
```

### Docker

```bash
# View logs
docker logs -f datamcp-agent

# Check status
docker ps | grep datamcp-agent

# Restart
docker restart datamcp-agent
```

## Security

### Network Security

- Agent initiates outbound WebSocket connection to cloud (no inbound ports required)
- Uses WSS (WebSocket Secure) with TLS encryption
- Database credentials never leave your network
- Agent authenticates with API key

### Best Practices

1. **API Key Security**
   - Store API key in secrets management (Kubernetes Secrets, AWS Secrets Manager, etc.)
   - Never commit API keys to version control
   - Rotate API keys periodically

2. **Network Isolation**
   - Run agent in same network as database
   - Use firewall rules to restrict agent access
   - Consider using VPC/private networks

3. **Resource Limits**
   - Set CPU and memory limits in production
   - Monitor resource usage
   - Scale horizontally if needed

4. **Logging**
   - Use `info` or `warn` log level in production
   - Forward logs to centralized logging system
   - Monitor for connection errors

## Troubleshooting

### Agent Won't Connect

1. Check API key is correct and starts with `agent_`
2. Verify network connectivity to DataMCP cloud
3. Check firewall allows outbound WSS connections
4. Review logs for connection errors

```bash
# Docker Compose
docker-compose logs datamcp-agent

# Kubernetes
kubectl logs -l app=datamcp-agent

# Docker
docker logs datamcp-agent
```

### Connection Keeps Dropping

1. Check network stability
2. Verify heartbeat interval is appropriate
3. Review cloud status page
4. Check resource limits (CPU/memory)

### Database Connection Fails

1. Verify database is accessible from agent network
2. Check database credentials
3. Ensure PostgreSQL accepts connections
4. Review database firewall rules

### High Memory Usage

1. Check number of active database connections
2. Review connection pool settings
3. Monitor query complexity
4. Consider increasing memory limits

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run with auto-reload
npm run dev:watch

# Build
npm run build

# Run tests (if available)
npm test
```

### Building Docker Image

```bash
# Build image
docker build -t datamcp/agent:latest .

# Test locally
docker run --rm \
  -e DATAMCP_API_KEY=agent_test_key \
  datamcp/agent:latest
```

### Publishing to Docker Hub

```bash
# Login to Docker Hub
docker login

# Tag image
docker tag datamcp/agent:latest datamcp/agent:1.0.0
docker tag datamcp/agent:latest datamcp/agent:latest

# Push to Docker Hub
docker push datamcp/agent:1.0.0
docker push datamcp/agent:latest
```

## Support

- Documentation: https://docs.datamcp.com
- Issues: https://github.com/datamcp/agent/issues
- Email: support@datamcp.com

## License

MIT License - see LICENSE file for details
