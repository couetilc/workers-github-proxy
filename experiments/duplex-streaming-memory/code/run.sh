#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/git-duplex-streaming.XXXXXX")
UPSTREAM_PORT=${UPSTREAM_PORT:-$((21000 + $$ % 8000))}
PROXY_PORT=${PROXY_PORT:-$((UPSTREAM_PORT + 1))}
SIZES_MIB=${SIZES_MIB:-"8 32 96"}
CLIENT_AUTH='Bearer client-only'
UPSTREAM_AUTH='Bearer upstream-only'
PIDS=()
PROXY_PID=''

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]:-}"; do wait "$pid" 2>/dev/null || true; done
  if [[ ${KEEP:-0} == 1 ]]; then
    printf 'kept experiment workspace: %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT INT TERM

heading() { printf '\n########## %s ##########\n' "$1"; }

wait_port() {
  local host=$1 port=$2
  for _ in $(seq 1 100); do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
      exec 3>&- 3<&-
      return 0
    fi
    sleep 0.05
  done
  printf 'timed out waiting for %s:%s\n' "$host" "$port" >&2
  return 1
}

wait_stopped() {
  local host=$1 port=$2
  for _ in $(seq 1 100); do
    if ! (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then return 0; fi
    exec 3>&- 3<&-
    sleep 0.05
  done
  printf 'timed out waiting for %s:%s to stop\n' "$host" "$port" >&2
  return 1
}

stop_proxy() {
  if [[ -n $PROXY_PID ]]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
    PROXY_PID=''
    wait_stopped 127.0.0.1 "$PROXY_PORT"
  fi
}

start_proxy() {
  local label=$1 size_mib=$2 log_file=$3
  PORT=$PROXY_PORT \
    UPSTREAM_ORIGIN="http://127.0.0.1:$UPSTREAM_PORT" \
    CLIENT_AUTH="$CLIENT_AUTH" UPSTREAM_AUTH="$UPSTREAM_AUTH" \
    STATS_FILE="$STATS_FILE" RUN_LABEL="$label" RUN_SIZE_MIB="$size_mib" \
    node "$SCRIPT_DIR/streaming-proxy.js" >"$log_file" 2>&1 &
  PROXY_PID=$!
  PIDS+=("$PROXY_PID")
  wait_port 127.0.0.1 "$PROXY_PORT"
}

git_with_auth() {
  git -c "http.extraHeader=Authorization: $CLIENT_AUTH" "$@"
}

for command in git node dd; do
  command -v "$command" >/dev/null || { printf 'required command missing: %s\n' "$command" >&2; exit 1; }
done

STATS_FILE="$WORK/measurements.jsonl"
AUDIT_FILE="$WORK/upstream-audit.jsonl"
BARE_ROOT="$WORK/bare"
mkdir -p "$BARE_ROOT" "$WORK/logs"
: >"$STATS_FILE"
: >"$AUDIT_FILE"

heading 'UNIT: pkt-line policy parser'
node --test "$SCRIPT_DIR/policy.test.js"

heading "SETUP: streaming git-http-backend upstream on port $UPSTREAM_PORT"
PORT=$UPSTREAM_PORT GIT_PROJECT_ROOT="$BARE_ROOT" \
  CLIENT_AUTH="$CLIENT_AUTH" UPSTREAM_AUTH="$UPSTREAM_AUTH" AUDIT_FILE="$AUDIT_FILE" \
  node "$SCRIPT_DIR/streaming-upstream.js" >"$WORK/logs/upstream.log" 2>&1 &
UPSTREAM_PID=$!
PIDS+=("$UPSTREAM_PID")
wait_port 127.0.0.1 "$UPSTREAM_PORT"

largest_size=0
largest_source=''
largest_bare=''

for size_mib in $SIZES_MIB; do
  heading "$size_mib MiB: create an incompressible one-blob repository"
  source_repo="$WORK/source-$size_mib"
  bare_repo="$BARE_ROOT/repo-$size_mib.git"
  clone_repo="$WORK/clone-$size_mib"

  git init -q -b main "$source_repo"
  git -C "$source_repo" config user.name Experimenter
  git -C "$source_repo" config user.email exp@localhost
  git -C "$source_repo" config commit.gpgsign false
  git -C "$source_repo" config core.hooksPath /dev/null
  git -C "$source_repo" config pack.threads 1
  dd if=/dev/urandom of="$source_repo/payload.bin" bs=1048576 count="$size_mib" status=none
  git -C "$source_repo" add payload.bin
  git -C "$source_repo" commit -q --no-verify -m "seed $size_mib MiB payload"

  git init -q --bare "$bare_repo"
  git -C "$bare_repo" config http.receivepack true
  git -C "$bare_repo" config pack.threads 1
  remote="http://127.0.0.1:$PROXY_PORT/repo-$size_mib.git"

  heading "$size_mib MiB: PUSH pack streams in the request direction"
  start_proxy "push-$size_mib" "$size_mib" "$WORK/logs/proxy-push-$size_mib.log"
  GIT_TERMINAL_PROMPT=0 git_with_auth -C "$source_repo" push "$remote" main >/dev/null
  stop_proxy
  git -C "$bare_repo" rev-parse --verify refs/heads/main >/dev/null

  heading "$size_mib MiB: CLONE pack streams in the response direction"
  start_proxy "clone-$size_mib" "$size_mib" "$WORK/logs/proxy-clone-$size_mib.log"
  GIT_TERMINAL_PROMPT=0 git_with_auth clone -q --no-checkout "$remote" "$clone_repo"
  stop_proxy
  test "$(git -C "$clone_repo" cat-file -s refs/remotes/origin/main:payload.bin)" \
    -eq "$((size_mib * 1048576))"

  if (( size_mib > largest_size )); then
    largest_size=$size_mib
    largest_source=$source_repo
    largest_bare=$bare_repo
  fi
done

heading 'POLICY CONTROL: protected ref is rejected before an upstream request opens'
start_proxy 'policy-control' "$largest_size" "$WORK/logs/proxy-policy-control.log"
protected_remote="http://127.0.0.1:$PROXY_PORT/repo-$largest_size.git"
if GIT_TERMINAL_PROMPT=0 git_with_auth -C "$largest_source" \
    push "$protected_remote" HEAD:refs/heads/protected >"$WORK/logs/protected-push.log" 2>&1; then
  printf 'protected ref unexpectedly passed policy\n' >&2
  exit 1
fi
stop_proxy
if git -C "$largest_bare" show-ref --verify --quiet refs/heads/protected; then
  printf 'protected ref reached the upstream repository\n' >&2
  exit 1
fi

heading 'AUTH CONTROL: missing client credential stops locally; valid credential is replaced'
start_proxy 'auth-control' 0 "$WORK/logs/proxy-auth-control.log"
if GIT_TERMINAL_PROMPT=0 git ls-remote "$protected_remote" >"$WORK/logs/unauthenticated.log" 2>&1; then
  printf 'unauthenticated discovery unexpectedly succeeded\n' >&2
  exit 1
fi
GIT_TERMINAL_PROMPT=0 git_with_auth ls-remote "$protected_remote" >/dev/null
stop_proxy

heading 'RESULTS: enforce fixed memory, queue, auth, and policy budgets'
SIZES_MIB="$SIZES_MIB" node "$SCRIPT_DIR/assert-results.js" "$STATS_FILE" "$AUDIT_FILE"

heading 'RAW MEASUREMENTS'
sed 's/^/  /' "$STATS_FILE"

heading 'DONE'
printf 'All real Git pushes and clones completed through the streaming proxy.\n'
printf 'Set KEEP=1 to retain measurements and logs under the temporary workspace.\n'
