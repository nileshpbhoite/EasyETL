#!/usr/bin/env bash
# Run EasyETL locally: API on :8000, web app on :3000.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

( cd "$ROOT/backend" && pip install -q -r requirements.txt && python -m uvicorn app.main:app --reload --port 8000 ) &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT

cd "$ROOT/frontend"
[ -d node_modules ] || npm install --no-audit --no-fund
npm run dev
