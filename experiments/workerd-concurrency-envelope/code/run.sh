#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/git-workerd-envelope.XXXXXX")
UPSTREAM_PORT=${UPSTREAM_PORT:-$((22000 + $$ % 5000))}
WORKERD_PORT=${WORKERD_PORT:-$((UPSTREAM_PORT + 1))}
SHAPER_PORT=${SHAPER_PORT:-$((UPSTREAM_PORT + 2))}
CONCURRENCIES=${CONCURRENCIES:-"1 2 4 8 16"}
SIZES_MIB=${SIZES_MIB:-"8 32 96"}
CURVE_SIZE_MIB=${CURVE_SIZE_MIB:-8}
SIZE_CONCURRENCY=${SIZE_CONCURRENCY:-8}
LONGEVITY_SIZE_MIB=${LONGEVITY_SIZE_MIB:-8}
LONGEVITY_CONCURRENCY=${LONGEVITY_CONCURRENCY:-8}
WAVES=${WAVES:-8}
CANCEL_SIZE_MIB=${CANCEL_SIZE_MIB:-32}
CANCEL_CONCURRENCY=${CANCEL_CONCURRENCY:-8}
RATE_MIB_PER_SECOND=${RATE_MIB_PER_SECOND:-4}
SETTLE_SECONDS=${SETTLE_SECONDS:-1}
CANCEL_AFTER_MIB=${CANCEL_AFTER_MIB:-2}
CLIENT_AUTH='Bearer client-only'
UPSTREAM_AUTH='Bearer upstream-only'
WORKERD_PID=''
SAMPLER_PID=''
UPSTREAM_PID=''
SHAPER_PID=''
GENERATED_CONFIG=''

cleanup() {
  for pid in "$SAMPLER_PID" "$WORKERD_PID" "$SHAPER_PID" "$UPSTREAM_PID"; do
    if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$SAMPLER_PID" "$WORKERD_PID" "$SHAPER_PID" "$UPSTREAM_PID"; do
    if [[ -n $pid ]]; then wait "$pid" 2>/dev/null || true; fi
  done
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
  for _ in $(seq 1 200); do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
      exec 3>&- 3<&-
      return 0
    fi
    sleep 0.05
  done
  printf 'timed out waiting for %s:%s\n' "$host" "$port" >&2
  return 1
}

git_case() {
  local case_name=$1
  shift
  git -c http.version=HTTP/1.1 \
    -c "http.extraHeader=Authorization: $CLIENT_AUTH" \
    -c "http.extraHeader=X-Experiment-Case: $case_name" "$@"
}

git_abort_case() {
  local case_name=$1 abort_bytes=$2
  shift 2
  git -c http.version=HTTP/1.1 \
    -c "http.extraHeader=Authorization: $CLIENT_AUTH" \
    -c "http.extraHeader=X-Experiment-Case: $case_name" \
    -c "http.extraHeader=X-Experiment-Abort-After: $abort_bytes" "$@"
}

wait_active_starts() {
  local case_name=$1 kind=$2 expected=$3
  for _ in $(seq 1 400); do
    local actual
    actual=$(grep -c "\"recordType\":\"active-start\".*\"case\":\"$case_name\".*\"kind\":\"$kind\"" \
      "$AUDIT_FILE" || true)
    (( actual >= expected )) && return 0
    sleep 0.05
  done
  printf '%s: timed out waiting for %s %s streams to become active\n' \
    "$case_name" "$expected" "$kind" >&2
  return 1
}

start_workerd() {
  "$SCRIPT_DIR/node_modules/.bin/workerd" serve "$GENERATED_CONFIG" \
    >>"$WORK/workerd.log" 2>&1 &
  WORKERD_PID=$!
  wait_port 127.0.0.1 "$WORKERD_PORT"
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
  fi
}

start_sampler() {
  local phase=$1 case_name=$2 workload=$3 concurrency=$4 size_mib=$5 wave=$6
  local ready_file="$WORK/sampler.ready"
  unlink "$ready_file" 2>/dev/null || true
  node "$SCRIPT_DIR/rss-sampler.js" "$WORKERD_PID" "$STATS_FILE" "$phase" \
    "$case_name" "$workload" "$concurrency" "$size_mib" "$wave" "$ready_file" &
  SAMPLER_PID=$!
  for _ in $(seq 1 100); do
    [[ -f $ready_file ]] && return 0
    kill -0 "$SAMPLER_PID" 2>/dev/null || return 1
    sleep 0.01
  done
  printf 'RSS sampler did not become ready\n' >&2
  return 1
}

ensure_source() {
  local size_mib=$1
  local source_repo="$WORK/source-$size_mib"
  local origin_repo="$BARE_ROOT/origin-$size_mib.git"
  [[ -d $source_repo ]] && return 0

  heading "SETUP: create incompressible $size_mib MiB Git source"
  git init -q -b main "$source_repo"
  git -C "$source_repo" config user.name Experimenter
  git -C "$source_repo" config user.email exp@localhost
  git -C "$source_repo" config commit.gpgsign false
  git -C "$source_repo" config core.hooksPath /dev/null
  git -C "$source_repo" config pack.threads 1
  dd if=/dev/urandom of="$source_repo/payload.bin" bs=1048576 count="$size_mib" status=none
  git -C "$source_repo" add payload.bin
  git -C "$source_repo" commit -q --no-verify -m "seed $size_mib MiB payload"
  git clone -q --bare "$source_repo" "$origin_repo"
  git -C "$origin_repo" config pack.threads 1
}

run_case() {
  local phase=$1 case_name=$2 workload=$3 concurrency=$4 size_mib=$5 wave=$6 fresh=$7
  local case_root="$WORK/cases/$case_name"
  local remote_base="http://127.0.0.1:$SHAPER_PORT"
  local push_count=0 clone_count=0 abort_count=0
  local -a job_pids=()

  case "$workload" in
    push) push_count=$concurrency ;;
    clone) clone_count=$concurrency ;;
    mixed)
      push_count=$((concurrency / 2))
      clone_count=$((concurrency - push_count))
      ;;
    cancel)
      push_count=$((concurrency / 2))
      abort_count=1
      clone_count=$((concurrency - push_count - abort_count))
      ;;
    *) printf 'unknown workload: %s\n' "$workload" >&2; return 1 ;;
  esac

  mkdir -p "$case_root"
  for index in $(seq 1 "$push_count"); do
    git init -q --bare "$BARE_ROOT/push-$case_name-$index.git"
    git -C "$BARE_ROOT/push-$case_name-$index.git" config http.receivepack true
    git -C "$BARE_ROOT/push-$case_name-$index.git" config pack.threads 1
  done

  if [[ $fresh == 1 ]]; then start_workerd; fi
  GIT_TERMINAL_PROMPT=0 git_case "warm-$case_name" \
    ls-remote "$remote_base/origin-$size_mib.git" >/dev/null
  start_sampler "$phase" "$case_name" "$workload" "$concurrency" "$size_mib" "$wave"

  for index in $(seq 1 "$push_count"); do
    GIT_TERMINAL_PROMPT=0 git_case "$case_name" -C "$WORK/source-$size_mib" \
      push "$remote_base/push-$case_name-$index.git" main >/dev/null &
    job_pids+=("$!")
  done
  if (( push_count > 0 && (clone_count > 0 || abort_count > 0) )); then
    wait_active_starts "$case_name" push "$push_count"
  fi
  for index in $(seq 1 "$clone_count"); do
    GIT_TERMINAL_PROMPT=0 git_case "$case_name" clone -q --no-checkout \
      "$remote_base/origin-$size_mib.git" "$case_root/clone-$index" &
    job_pids+=("$!")
  done
  if (( abort_count == 1 )); then
    (
      if GIT_TERMINAL_PROMPT=0 git_abort_case "$case_name" \
        "$((CANCEL_AFTER_MIB * 1048576))" clone -q --no-checkout \
        "$remote_base/origin-$size_mib.git" "$case_root/aborted-clone"; then
        printf 'injected-abort clone unexpectedly succeeded\n' >&2
        exit 1
      fi
    ) &
    job_pids+=("$!")
  fi

  local failed=0
  for pid in "${job_pids[@]}"; do
    if ! wait "$pid"; then failed=1; fi
  done
  if (( failed )); then
    printf '%s: one or more Git operations failed\n' "$case_name" >&2
    return 1
  fi

  sleep "$SETTLE_SECONDS"
  kill -0 "$WORKERD_PID"
  GIT_TERMINAL_PROMPT=0 git_case "$case_name" \
    ls-remote "$remote_base/origin-$size_mib.git" >/dev/null
  kill "$SAMPLER_PID" 2>/dev/null || true
  wait "$SAMPLER_PID" 2>/dev/null || true
  SAMPLER_PID=''

  for index in $(seq 1 "$push_count"); do
    git -C "$BARE_ROOT/push-$case_name-$index.git" rev-parse --verify refs/heads/main >/dev/null
  done
  for index in $(seq 1 "$clone_count"); do
    test "$(git -C "$case_root/clone-$index" cat-file -s refs/remotes/origin/main:payload.bin)" \
      -eq "$((size_mib * 1048576))"
  done
  if (( abort_count == 1 )) && [[ -d $case_root/aborted-clone ]]; then
    if git -C "$case_root/aborted-clone" rev-parse --verify refs/remotes/origin/main >/dev/null 2>&1; then
      printf 'aborted clone unexpectedly has a complete remote ref\n' >&2
      return 1
    fi
  fi

  if [[ $fresh == 1 ]]; then stop_workerd; fi
  rm -rf "$case_root"
  for index in $(seq 1 "$push_count"); do
    rm -rf "$BARE_ROOT/push-$case_name-$index.git"
  done
}

for command in git node npm dd; do
  command -v "$command" >/dev/null || {
    printf 'required command missing: %s\n' "$command" >&2
    exit 1
  }
done
[[ -r /proc/self/status ]] || {
  printf 'this RSS harness requires Linux /proc\n' >&2
  exit 1
}

if [[ ! -x $SCRIPT_DIR/node_modules/.bin/workerd ]]; then
  heading 'SETUP: install the pinned workerd binary'
  npm ci --prefix "$SCRIPT_DIR" --no-audit --no-fund
fi

STATS_FILE="$WORK/measurements.jsonl"
AUDIT_FILE="$WORK/upstream-audit.jsonl"
SHAPER_AUDIT_FILE="$WORK/shaper-audit.jsonl"
BARE_ROOT="$WORK/bare"
mkdir -p "$BARE_ROOT" "$WORK/cases" "$WORK/logs"
: >"$STATS_FILE"
: >"$AUDIT_FILE"
: >"$SHAPER_AUDIT_FILE"
: >"$WORK/workerd.log"

heading 'UNIT: stream shaper and shared Worker policy'
node --test "$SCRIPT_DIR/throttle.test.cjs" \
  "$SCRIPT_DIR/../../workerd-duplex-streaming/code/policy.test.js"

GENERATED_CONFIG=$(mktemp "$SCRIPT_DIR/workerd.generated.XXXXXX.capnp")
sed -e "s|__UPSTREAM_PORT__|$UPSTREAM_PORT|g" \
  -e "s|__WORKERD_PORT__|$WORKERD_PORT|g" \
  "$SCRIPT_DIR/workerd.capnp.template" >"$GENERATED_CONFIG"

rate_bytes=$((RATE_MIB_PER_SECOND * 1048576))
heading "SETUP: ${RATE_MIB_PER_SECOND} MiB/s push and clone backpressure"
PORT=$UPSTREAM_PORT GIT_PROJECT_ROOT="$BARE_ROOT" CLIENT_AUTH="$CLIENT_AUTH" \
  UPSTREAM_AUTH="$UPSTREAM_AUTH" AUDIT_FILE="$AUDIT_FILE" \
  REQUEST_BYTES_PER_SECOND=$rate_bytes RESPONSE_BYTES_PER_SECOND=$rate_bytes \
  ACTIVE_THRESHOLD_BYTES=1048576 \
  node "$SCRIPT_DIR/git-upstream.cjs" >"$WORK/logs/upstream.log" 2>&1 &
UPSTREAM_PID=$!
wait_port 127.0.0.1 "$UPSTREAM_PORT"

PORT=$SHAPER_PORT TARGET_PORT=$WORKERD_PORT SHAPER_AUDIT_FILE="$SHAPER_AUDIT_FILE" \
  RESPONSE_BYTES_PER_SECOND=$rate_bytes \
  node "$SCRIPT_DIR/client-shaper.cjs" >"$WORK/logs/shaper.log" 2>&1 &
SHAPER_PID=$!
wait_port 127.0.0.1 "$SHAPER_PORT"

for size_mib in $CURVE_SIZE_MIB $SIZES_MIB $LONGEVITY_SIZE_MIB $CANCEL_SIZE_MIB; do
  ensure_source "$size_mib"
done

heading "CONCURRENCY CURVE: $CURVE_SIZE_MIB MiB per stream"
for workload in push clone; do
  for concurrency in $CONCURRENCIES; do
    case_name="concurrency-$workload-c$concurrency-s$CURVE_SIZE_MIB"
    heading "$case_name"
    run_case concurrency "$case_name" "$workload" "$concurrency" \
      "$CURVE_SIZE_MIB" 0 1
  done
done
for concurrency in $CONCURRENCIES; do
  (( concurrency < 2 )) && continue
  case_name="concurrency-mixed-c$concurrency-s$CURVE_SIZE_MIB"
  heading "$case_name"
  run_case concurrency "$case_name" mixed "$concurrency" "$CURVE_SIZE_MIB" 0 1
done

heading "PACK-SIZE CURVE: concurrency $SIZE_CONCURRENCY"
for size_mib in $SIZES_MIB; do
  case_name="size-mixed-c$SIZE_CONCURRENCY-s$size_mib"
  heading "$case_name"
  run_case size "$case_name" mixed "$SIZE_CONCURRENCY" "$size_mib" 0 1
done

heading "LONGEVITY: $WAVES waves in one warmed workerd process"
start_workerd
for wave in $(seq 1 "$WAVES"); do
  case_name="longevity-mixed-w$wave-c$LONGEVITY_CONCURRENCY-s$LONGEVITY_SIZE_MIB"
  heading "$case_name"
  run_case longevity "$case_name" mixed "$LONGEVITY_CONCURRENCY" \
    "$LONGEVITY_SIZE_MIB" "$wave" 0
done
stop_workerd

heading 'CANCELLATION: one slow clone aborts while siblings complete'
case_name="cancel-mixed-c$CANCEL_CONCURRENCY-s$CANCEL_SIZE_MIB"
run_case cancel "$case_name" cancel "$CANCEL_CONCURRENCY" "$CANCEL_SIZE_MIB" 0 1

heading 'RESULTS: assert overlap, memory envelope, longevity, and cancellation'
CONCURRENCIES="$CONCURRENCIES" SIZES_MIB="$SIZES_MIB" WAVES="$WAVES" \
  SIZE_CONCURRENCY="$SIZE_CONCURRENCY" \
  node "$SCRIPT_DIR/assert-results.js" "$STATS_FILE" "$AUDIT_FILE" \
  "$SHAPER_AUDIT_FILE" "$WORK/workerd.log"

heading 'RAW WORKERD RSS MEASUREMENTS'
sed 's/^/  /' "$STATS_FILE"

heading 'DONE'
printf 'All concurrent Git workloads completed through one Worker service.\n'
printf 'Set KEEP=1 to retain measurements and logs under the temporary workspace.\n'
