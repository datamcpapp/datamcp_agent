#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run build
npm run test:package
node dist/index.js --version
node dist/index.js --help >/dev/null
