# Docker Publishing Guide

This guide explains how to build and publish the DataMCP Agent to Docker Hub.

## Prerequisites

1. Docker installed and running
2. Docker Hub account (create at https://hub.docker.com)
3. Agent code in this directory

## Step 1: Create Docker Hub Repository

1. Go to https://hub.docker.com
2. Click "Create Repository"
3. Repository name: `agent`
4. Namespace: `datamcp` (or your username)
5. Visibility: Public
6. Click "Create"

Your repository will be: `datamcp/agent`

## Step 2: Login to Docker Hub

```bash
docker login
```

Enter your Docker Hub username and password.

## Step 3: Build the Docker Image

```bash
# Navigate to agent directory
cd datamcp_agent

# Build the image
docker build -t datamcp/agent:latest .

# Build with version tag
docker build -t datamcp/agent:1.0.0 .
```

## Step 4: Test the Image Locally

```bash
# Test with environment variables
docker run --rm \
  -e DATAMCP_API_KEY=agent_test_key \
  -e LOG_LEVEL=debug \
  datamcp/agent:latest

# Test health endpoint
docker run -d --name test-agent \
  -e DATAMCP_API_KEY=agent_test_key \
  -p 3000:3000 \
  datamcp/agent:latest

# Check health
curl http://localhost:3000/health

# Stop and remove
docker stop test-agent
docker rm test-agent
```

## Step 5: Tag the Image

```bash
# Tag with version
docker tag datamcp/agent:latest datamcp/agent:1.0.0

# Tag with latest
docker tag datamcp/agent:latest datamcp/agent:latest
```

## Step 6: Push to Docker Hub

```bash
# Push version tag
docker push datamcp/agent:1.0.0

# Push latest tag
docker push datamcp/agent:latest
```

## Step 7: Verify Publication

1. Go to https://hub.docker.com/r/datamcp/agent
2. Check that tags are visible
3. Verify image size and layers

## Step 8: Test Pull from Docker Hub

```bash
# Remove local images
docker rmi datamcp/agent:latest
docker rmi datamcp/agent:1.0.0

# Pull from Docker Hub
docker pull datamcp/agent:latest

# Test the pulled image
docker run --rm \
  -e DATAMCP_API_KEY=agent_test_key \
  datamcp/agent:latest
```

## Automated Publishing with GitHub Actions

Create `.github/workflows/docker-publish.yml`:

```yaml
name: Publish Docker Image

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Extract version from tag
        id: version
        run: echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT

      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: ./datamcp_agent
          push: true
          tags: |
            datamcp/agent:latest
            datamcp/agent:${{ steps.version.outputs.VERSION }}
          cache-from: type=registry,ref=datamcp/agent:latest
          cache-to: type=inline
```

## Version Management

### Semantic Versioning

Use semantic versioning: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes

### Tagging Strategy

```bash
# Latest stable version
docker tag datamcp/agent:latest datamcp/agent:1.0.0

# Major version
docker tag datamcp/agent:latest datamcp/agent:1

# Minor version
docker tag datamcp/agent:latest datamcp/agent:1.0

# Specific patch
docker tag datamcp/agent:latest datamcp/agent:1.0.0
```

### Push All Tags

```bash
docker push datamcp/agent:1.0.0
docker push datamcp/agent:1.0
docker push datamcp/agent:1
docker push datamcp/agent:latest
```

## Multi-Architecture Builds

Build for multiple platforms (amd64, arm64):

```bash
# Create builder
docker buildx create --name multiarch --use

# Build and push for multiple platforms
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t datamcp/agent:latest \
  -t datamcp/agent:1.0.0 \
  --push \
  .
```

## Security Scanning

Scan image for vulnerabilities:

```bash
# Using Docker Scout
docker scout cves datamcp/agent:latest

# Using Trivy
trivy image datamcp/agent:latest
```

## Image Optimization

### Reduce Image Size

1. Use multi-stage builds (already implemented)
2. Use Alpine base image (already using node:18-alpine)
3. Remove unnecessary files
4. Combine RUN commands

### Current Image Stats

```bash
# Check image size
docker images datamcp/agent:latest

# Check layers
docker history datamcp/agent:latest
```

## Troubleshooting

### Build Fails

```bash
# Clean build cache
docker builder prune

# Build without cache
docker build --no-cache -t datamcp/agent:latest .
```

### Push Fails

```bash
# Re-login
docker logout
docker login

# Check credentials
docker info | grep Username
```

### Image Too Large

```bash
# Analyze layers
docker history datamcp/agent:latest

# Use dive tool
dive datamcp/agent:latest
```

## Customer Usage

After publishing, customers can use:

### Docker

```bash
docker pull datamcp/agent:latest

docker run -d \
  --name datamcp-agent \
  --restart unless-stopped \
  -e DATAMCP_API_KEY=agent_xxx \
  datamcp/agent:latest
```

### Docker Compose

```yaml
version: '3.8'
services:
  datamcp-agent:
    image: datamcp/agent:latest
    environment:
      - DATAMCP_API_KEY=agent_xxx
    restart: unless-stopped
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: datamcp-agent
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: agent
        image: datamcp/agent:latest
        env:
        - name: DATAMCP_API_KEY
          valueFrom:
            secretKeyRef:
              name: datamcp-agent-secret
              key: api-key
```

## Maintenance

### Regular Updates

1. Update dependencies: `npm update`
2. Rebuild image: `docker build -t datamcp/agent:latest .`
3. Test thoroughly
4. Tag with new version
5. Push to Docker Hub
6. Update documentation

### Security Updates

1. Monitor for vulnerabilities
2. Update base image regularly
3. Scan with security tools
4. Publish security patches promptly

## Support

- Docker Hub: https://hub.docker.com/r/datamcp/agent
- Documentation: https://docs.datamcp.com
- Issues: https://github.com/datamcp/agent/issues
