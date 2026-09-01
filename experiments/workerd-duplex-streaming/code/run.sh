#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/git-workerd-streaming.XXXXXX")
UPSTREAM_PORT=${UPSTREAM_PORT:-$((22000 + $$ % 6000))}
PROXY_PORT=${PROXY_PORT:-$((UPSTREAM_PORT + 1))}
SIZES_MIB=${SIZES_MIB:-"8 32 96"}
REQUEST_STREAM_MODE=${REQUEST_STREAM_MODE:-tee}
CLIENT_AUTH='Bearer client-only'
UPSTREAM_AUTH='Bearer upstream-only'
PIDS=()
WORKERD_PID=''
SAMPLER_PID=''
GENERATED_CONFIG=''

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]:-}"; do wait "$pid" 2>/dev/null || true; done
  if [[ -n $GENERATED_CONFIG ]]; then unlink "$GENERATED_CONFIG" 2>/dev/null || true; fi
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

start_workerd() {
  "$SCRIPT_DIR/node_modules/.bin/workerd" serve "$GENERATED_CONFIG" \
    >>"$WORK/workerd.log" 2>&1 &
  WORKERD_PID=$!
  PIDS+=("$WORKERD_PID")
  wait_port 127.0.0.1 "$PROXY_PORT"
}

start_sampler() {
  local label=$1 size_mib=$2 direction=$3
  local ready_file="$WORK/sampler.ready"
  unlink "$ready_file" 2>/dev/null || true
  node "$SCRIPT_DIR/rss-sampler.js" "$WORKERD_PID" "$label" "$size_mib" \
    "$direction" "$STATS_FILE" "$ready_file" &
  SAMPLER_PID=$!
  PIDS+=("$SAMPLER_PID")
  for _ in $(seq 1 100); do
    [[ -f $ready_file ]] && return 0
    kill -0 "$SAMPLER_PID" 2>/dev/null || return 1
    sleep 0.01
  done
  printf 'RSS sampler did not become ready\n' >&2
  return 1
}

stop_workerd() {
  if [[ -n $SAMPLER_PID ]]; then
    kill "$SAMPLER_PID" 2>/dev/null || true
    wait "$SAMPLER_PID" 2>/dev/null || true
    SAMPLER_PID=''
  fi
  if [[ -n $WORKERD_PID ]]; then
    kill "$WORKERD_PID" 2>/dev/null || true
    wait "$WORKERD_PID" 2>/dev/null || true
    WORKERD_PID=''
    wait_stopped 127.0.0.1 "$PROXY_PORT"
  fi
}

git_with_auth() {
  git -c "http.extraHeader=Authorization: $CLIENT_AUTH" "$@"
}

for command in git node npm dd; do
  command -v "$command" >/dev/null || { printf 'required command missing: %s\n' "$command" >&2; exit 1; }
done
[[ -r /proc/self/status ]] || { printf 'this RSS harness requires Linux /proc\n' >&2; exit 1; }
[[ $REQUEST_STREAM_MODE == tee || $REQUEST_STREAM_MODE == reconstruct ]] || {
  printf 'REQUEST_STREAM_MODE must be tee or reconstruct\n' >&2
  exit 1
}

if [[ ! -x $SCRIPT_DIR/node_modules/.bin/workerd ]]; then
  heading 'SETUP: install the pinned workerd binary'
  npm ci --prefix "$SCRIPT_DIR" --no-audit --no-fund
fi

STATS_FILE="$WORK/measurements.jsonl"
AUDIT_FILE="$WORK/upstream-audit.jsonl"
BARE_ROOT="$WORK/bare"
mkdir -p "$BARE_ROOT" "$WORK/logs"
: >"$STATS_FILE"
: >"$AUDIT_FILE"
: >"$WORK/workerd.log"

heading 'UNIT: Worker-compatible pkt-line policy parser'
node --test "$SCRIPT_DIR/policy.test.js"

GENERATED_CONFIG=$(mktemp "$SCRIPT_DIR/workerd.generated.XXXXXX.capnp")
sed -e "s|__UPSTREAM_PORT__|$UPSTREAM_PORT|g" \
  -e "s|__PROXY_PORT__|$PROXY_PORT|g" \
  -e "s|__REQUEST_STREAM_MODE__|$REQUEST_STREAM_MODE|g" \
  "$SCRIPT_DIR/workerd.capnp.template" >"$GENERATED_CONFIG"

heading "SETUP: workerd request mode=$REQUEST_STREAM_MODE; git upstream port $UPSTREAM_PORT"
PORT=$UPSTREAM_PORT GIT_PROJECT_ROOT="$BARE_ROOT" \
  CLIENT_AUTH="$CLIENT_AUTH" UPSTREAM_AUTH="$UPSTREAM_AUTH" AUDIT_FILE="$AUDIT_FILE" \
  node "$SCRIPT_DIR/git-upstream.cjs" >"$WORK/logs/upstream.log" 2>&1 &
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
  remote="http://127.0.0.1:$PROXY_PORT/repo-$size_mib.git"

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

  heading "$size_mib MiB: PUSH request streams through workerd"
  start_workerd
  GIT_TERMINAL_PROMPT=0 git_with_auth ls-remote "$remote" >/dev/null
  start_sampler "push-$size_mib" "$size_mib" push
  GIT_TERMINAL_PROMPT=0 git_with_auth -C "$source_repo" push "$remote" main >/dev/null
  stop_workerd
  git -C "$bare_repo" rev-parse --verify refs/heads/main >/dev/null

  heading "$size_mib MiB: CLONE response streams through workerd"
  start_workerd
  GIT_TERMINAL_PROMPT=0 git_with_auth ls-remote "$remote" >/dev/null
  start_sampler "clone-$size_mib" "$size_mib" clone
  GIT_TERMINAL_PROMPT=0 git_with_auth clone -q --no-checkout "$remote" "$clone_repo"
  stop_workerd
  test "$(git -C "$clone_repo" cat-file -s refs/remotes/origin/main:payload.bin)" \
    -eq "$((size_mib * 1048576))"

  if (( size_mib > largest_size )); then
    largest_size=$size_mib
    largest_source=$source_repo
    largest_bare=$bare_repo
  fi
done

heading 'POLICY CONTROL: protected receive-pack is stopped inside the Worker'
start_workerd
protected_remote="http://127.0.0.1:$PROXY_PORT/repo-$largest_size.git"
receive_posts_before=$(grep -c "\"method\":\"POST\",\"path\":\"/repo-$largest_size.git/git-receive-pack\"" \
  "$AUDIT_FILE" || true)
if GIT_TERMINAL_PROMPT=0 git_with_auth -C "$largest_source" \
    push "$protected_remote" HEAD:refs/heads/protected >"$WORK/logs/protected-push.log" 2>&1; then
  printf 'protected ref unexpectedly passed policy\n' >&2
  exit 1
fi
stop_workerd
receive_posts_after=$(grep -c "\"method\":\"POST\",\"path\":\"/repo-$largest_size.git/git-receive-pack\"" \
  "$AUDIT_FILE" || true)
if [[ $receive_posts_after != "$receive_posts_before" ]]; then
  printf 'protected receive-pack reached upstream\n' >&2
  exit 1
fi
if git -C "$largest_bare" show-ref --verify --quiet refs/heads/protected; then
  printf 'protected ref reached upstream repository\n' >&2
  exit 1
fi

heading 'AUTH CONTROL: Worker replaces valid auth and stops missing auth locally'
start_workerd
audit_lines_before=$(wc -l <"$AUDIT_FILE")
if GIT_TERMINAL_PROMPT=0 git ls-remote "$protected_remote" >"$WORK/logs/unauthenticated.log" 2>&1; then
  printf 'unauthenticated discovery unexpectedly succeeded\n' >&2
  exit 1
fi
audit_lines_after=$(wc -l <"$AUDIT_FILE")
if [[ $audit_lines_after != "$audit_lines_before" ]]; then
  printf 'unauthenticated request reached upstream\n' >&2
  exit 1
fi
GIT_TERMINAL_PROMPT=0 git_with_auth ls-remote "$protected_remote" >/dev/null
stop_workerd

heading 'RESULTS: enforce workerd memory, auth, and policy budgets'
SIZES_MIB="$SIZES_MIB" REQUEST_STREAM_MODE="$REQUEST_STREAM_MODE" \
  node "$SCRIPT_DIR/assert-results.js" \
  "$STATS_FILE" "$AUDIT_FILE" "$WORK/workerd.log"

heading 'RAW WORKERD RSS MEASUREMENTS'
sed 's/^/  /' "$STATS_FILE"

heading 'DONE'
printf 'All real Git pushes and clones completed through workerd Web Streams.\n'
printf 'Set KEEP=1 to retain measurements and logs under the temporary workspace.\n'
