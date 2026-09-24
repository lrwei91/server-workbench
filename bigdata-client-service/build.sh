#!/usr/bin/env bash
set -euo pipefail
: "${CLIENT_CLASSPATH:?Set CLIENT_CLASSPATH to the exact cluster Hadoop/HBase client classpath}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$ROOT/build/classes"
mkdir -p "$ROOT/build/classes"
find "$ROOT/src/main/java" -name '*.java' -print0 | xargs -0 javac -encoding UTF-8 -cp "$CLIENT_CLASSPATH" -d "$ROOT/build/classes"
jar cf "$ROOT/build/server-workbench-bigdata-client.jar" -C "$ROOT/build/classes" .
echo "Built: $ROOT/build/server-workbench-bigdata-client.jar"
