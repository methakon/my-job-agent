#!/bin/bash
# my-job-agent launcher — builds if needed, starts service on :3010
cd "$(dirname "$0")"
if [ ! -d dist ] || [ src/app.module.ts -nt dist/main.js ]; then
  echo "Building..."
  npm run build || exit 1
fi
mkdir -p logs
node dist/main.js >> logs/agent.log 2>&1 &
echo $! > agent.pid
echo "my-job-agent started (PID $(cat agent.pid)) -> http://localhost:3010/"
