#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/run/service.pid"
if [[ ! -f "$PID_FILE" ]]; then
  echo "Service is not running"
  exit 0
fi

pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "Service is not running"
  exit 0
fi

kill "$pid"
for _ in {1..15}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Service stopped"
    exit 0
  fi
  sleep 1
done

kill -KILL "$pid" 2>/dev/null || true
rm -f "$PID_FILE"
echo "Service stopped"
