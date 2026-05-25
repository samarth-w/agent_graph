#!/usr/bin/env bash
# Smoke-test all cgraph CLI commands against a temp project.
# Inspired by codegraph's agent-eval probes.
#
# Usage:
#   ./scripts/smoke-test.sh
#   ./scripts/smoke-test.sh --verbose

set -euo pipefail

VERBOSE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CGRAPH="node $ROOT/bin/cgraph.js"
PASSED=0
FAILED=0
ERRORS=()

run_test() {
  local name="$1"
  local args="$2"
  local expect="${3:-}"

  local output
  output=$(eval "$CGRAPH $args" 2>&1) || true

  if [ -n "$expect" ] && ! echo "$output" | grep -q "$expect"; then
    FAILED=$((FAILED + 1))
    ERRORS+=("$name: expected '$expect'")
    printf "  \033[31mFAIL\033[0m  %s\n" "$name"
    [ "$VERBOSE" = "--verbose" ] && echo "$output"
    return
  fi

  PASSED=$((PASSED + 1))
  printf "  \033[32mPASS\033[0m  %s\n" "$name"
  [ "$VERBOSE" = "--verbose" ] && echo "$output"
}

# --- Setup: create temp project ---
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/app.ts" <<'EOF'
export function greet(name: string): string {
  return formatMessage("Hello", name);
}

function formatMessage(prefix: string, name: string): string {
  return prefix + " " + name;
}

export class UserService {
  getUser(id: number) { return this.findById(id); }
  private findById(id: number) { return { id }; }
}
EOF

cat > "$TMPDIR/index.ts" <<'EOF'
import { greet, UserService } from './app';

export function main() {
  const msg = greet("world");
  console.log(msg);
  const svc = new UserService();
  const user = svc.getUser(1);
  return user;
}

export function healthCheck() {
  return { status: "ok" };
}
EOF

cat > "$TMPDIR/server.py" <<'EOF'
from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/health')
def health():
    return jsonify(status="ok")

@app.get('/users')
def list_users():
    return jsonify(get_all_users())

def get_all_users():
    return [{"id": 1, "name": "Alice"}]

class DataStore:
    def connect(self):
        pass
    def query(self, sql):
        return self.connect()
EOF

cd "$TMPDIR"

echo
echo "cgraph Smoke Test"
echo "================="
echo "Temp project: $TMPDIR"
echo

# --- Tests ---
echo "--- Indexing ---"
run_test "index" "index" '"files_scanned":3'

echo "--- Status ---"
run_test "status" "status" '"files_count":3'

echo "--- Files ---"
run_test "files" "files" '"total":3'

echo "--- Search ---"
run_test "search greet" "search greet" '"name":"greet"'
run_test "search kind:class" "search Service --kind class" '"kind":"class"'
run_test "search kind:route" "search route --kind route" '"kind":"route"'

echo "--- Callers ---"
run_test "callers formatMessage" "callers formatMessage" '"name":"greet"'

echo "--- Callees ---"
run_test "callees greet" "callees greet" '"name":"formatMessage"'
run_test "callees main" "callees main" '"name":"greet"'

echo "--- Impact ---"
run_test "impact formatMessage" "impact formatMessage" 'impacted'

echo "--- Trace ---"
run_test "trace main->formatMessage" "trace main formatMessage" '"found":true'
run_test "trace no-path" "trace healthCheck formatMessage" '"found":false'

echo "--- Node ---"
run_test "node greet" "node greet" '"trail"'
run_test "node UserService" "node UserService" '"kind":"class"'

echo "--- Explore ---"
run_test "explore greet" "explore greet" '"source"'

echo "--- Context ---"
run_test "context task" 'context "how does greeting work"' '"estimated_tokens"'

echo "--- Sync ---"
run_test "sync no-op" "sync" '"files_changed":0'

echo "--- Python ---"
run_test "search Flask route" "search health --kind route" '"route"'
run_test "python class" "search DataStore --kind class" '"DataStore"'

# --- Summary ---
echo
echo "=================="
printf "\033[32mPassed: %d\033[0m\n" "$PASSED"
if [ "$FAILED" -gt 0 ]; then
  printf "\033[31mFailed: %d\033[0m\n" "$FAILED"
  for e in "${ERRORS[@]}"; do
    printf "\033[31m  - %s\033[0m\n" "$e"
  done
  exit 1
else
  printf "Failed: 0\n"
  printf "\033[32mAll smoke tests passed!\033[0m\n"
fi
