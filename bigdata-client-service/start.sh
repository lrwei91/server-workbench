#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/run/service.pid"
LOG_FILE="$ROOT/logs/service.log"

mkdir -p "$ROOT/run" "$ROOT/logs"
if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "Service already running (pid=$old_pid)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

: "${JAVA_HOME:=/opt/jdk1.8.0_202}"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
: "${CLIENT_CLASSPATH:=$(hadoop classpath):$(hbase classpath)}"
export CLIENT_CLASSPATH

set -a
. "$ROOT/service.env"
set +a

nohup "$JAVA_HOME/bin/java" \
  -cp "$ROOT/build/server-workbench-bigdata-client.jar:$CLIENT_CLASSPATH" \
  com.serverworkbench.bigdata.BigdataClientService \
  >>"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" >"$PID_FILE"

for _ in {1..30}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Service exited during startup; inspect $LOG_FILE" >&2
    exit 1
  fi
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)17880$'; then
    echo "Service started (pid=$pid)"
    exit 0
  fi
  sleep 1
done

echo "Service is still starting (pid=$pid); inspect $LOG_FILE"
