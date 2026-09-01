#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/dual-gitea-replication.XXXXXX")
BASE_PORT=${BASE_PORT:-$((24000 + $$ % 3000))}
GITEA_A_PORT=${GITEA_A_PORT:-$BASE_PORT}
GITEA_B_PORT=${GITEA_B_PORT:-$((BASE_PORT + 1))}
GATEWAY_A_PORT=${GATEWAY_A_PORT:-$((BASE_PORT + 2))}
GATEWAY_B_PORT=${GATEWAY_B_PORT:-$((BASE_PORT + 3))}
RECORDER_PORT=${RECORDER_PORT:-$((BASE_PORT + 4))}
WORKERD_PORT=${WORKERD_PORT:-$((BASE_PORT + 5))}
GITEA_VERSION=1.27.3
CLIENT_AUTH='Bearer client-only'
UPSTREAM_USER='replication-proxy'
UPSTREAM_PASSWORD='local-experiment-password'
SLOW_SIZES_MIB=${SLOW_SIZES_MIB:-"8 32"}
SLOW_DELAY_MS=${SLOW_DELAY_MS:-4}
DISCONNECT_SIZE_MIB=${DISCONNECT_SIZE_MIB:-8}
PIDS=()
WORKERD_PID=''
SAMPLER_PID=''
GENERATED_CONFIG=''

cleanup() {
  if [[ -n $SAMPLER_PID ]]; then kill "$SAMPLER_PID" 2>/dev/null || true; fi
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  if [[ -n $SAMPLER_PID ]]; then wait "$SAMPLER_PID" 2>/dev/null || true; fi
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
  for _ in $(seq 1 240); do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
      exec 3>&- 3<&-
      return 0
    fi
    sleep 0.05
  done
  printf 'timed out waiting for %s:%s\n' "$host" "$port" >&2
  return 1
}

wait_http() {
  local url=$1
  for _ in $(seq 1 240); do
    if curl --silent --fail --output /dev/null "$url"; then return 0; fi
    sleep 0.05
  done
  printf 'timed out waiting for %s\n' "$url" >&2
  return 1
}

download_gitea() {
  if [[ -n ${GITEA_BIN:-} ]]; then
    [[ -x $GITEA_BIN ]] || { printf 'GITEA_BIN is not executable: %s\n' "$GITEA_BIN" >&2; return 1; }
    printf '%s\n' "$GITEA_BIN"
    return
  fi

  local architecture checksum binary temporary
  case $(uname -m) in
    x86_64)
      architecture=amd64
      checksum=4da93c2c10b6980c359bcb86d5573ebfd7770e2e151756534edee24c8c12d971
      ;;
    aarch64|arm64)
      architecture=arm64
      checksum=04c086d36dba793546e331484a9da34571763efdfa77dc526cc98e0f10917e7b
      ;;
    *)
      printf 'no pinned Gitea binary for architecture %s; set GITEA_BIN\n' "$(uname -m)" >&2
      return 1
      ;;
  esac

  mkdir -p "$SCRIPT_DIR/.cache"
  binary="$SCRIPT_DIR/.cache/gitea-$GITEA_VERSION-linux-$architecture"
  if [[ ! -f $binary ]]; then
    temporary="$binary.download.$$"
    curl --fail --location --output "$temporary" \
      "https://github.com/go-gitea/gitea/releases/download/v$GITEA_VERSION/gitea-$GITEA_VERSION-linux-$architecture"
    printf '%s  %s\n' "$checksum" "$temporary" | sha256sum --check --status
    chmod +x "$temporary"
    mv "$temporary" "$binary"
  fi
  printf '%s  %s\n' "$checksum" "$binary" | sha256sum --check --status
  printf '%s\n' "$binary"
}

git_proxy() {
  local case_name=$1 fault=$2 advertisement=$3
  shift 3
  local config=(
    -c "http.extraHeader=Authorization: $CLIENT_AUTH"
    -c "http.extraHeader=X-Experiment-Case: $case_name"
  )
  if [[ $fault != none ]]; then
    config+=(-c "http.extraHeader=X-Replica-B-Fault: $fault")
  fi
  if [[ $advertisement != none ]]; then
    config+=(-c "http.extraHeader=X-Write-Advertisement: $advertisement")
  fi
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git "${config[@]}" "$@"
}

git_direct() {
  local case_name=$1
  shift
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git -c "http.extraHeader=Authorization: $UPSTREAM_AUTH" \
    -c "http.extraHeader=X-Experiment-Case: $case_name" "$@"
}

ref_oid() {
  local repository=$1 ref=$2
  git -C "$repository" rev-parse --verify "$ref" 2>/dev/null || true
}

assert_replicas_equal() {
  local label=$1 refs_a refs_b objects_a objects_b
  refs_a="$WORK/$label.refs-a"
  refs_b="$WORK/$label.refs-b"
  objects_a="$WORK/$label.objects-a"
  objects_b="$WORK/$label.objects-b"
  git -C "$BARE_A" for-each-ref --format='%(refname) %(objectname)' | sort >"$refs_a"
  git -C "$BARE_B" for-each-ref --format='%(refname) %(objectname)' | sort >"$refs_b"
  git -C "$BARE_A" rev-list --objects --all | awk '{print $1}' | sort -u >"$objects_a"
  git -C "$BARE_B" rev-list --objects --all | awk '{print $1}' | sort -u >"$objects_b"
  cmp "$refs_a" "$refs_b" || { printf '%s: replica refs differ\n' "$label" >&2; return 1; }
  cmp "$objects_a" "$objects_b" || { printf '%s: reachable object graphs differ\n' "$label" >&2; return 1; }
  git -C "$BARE_A" fsck --strict --no-progress >/dev/null
  git -C "$BARE_B" fsck --strict --no-progress >/dev/null
}

measure_state() {
  local label=$1 client_result=$2
  node -e '
    const { appendFileSync } = require("fs");
    const { execFileSync } = require("child_process");
    const [output, label, clientResult, repoA, repoB] = process.argv.slice(1);
    function state(repository) {
      const refs = {};
      const text = execFileSync("git", ["-C", repository, "for-each-ref",
        "--format=%(refname) %(objectname)"], { encoding: "utf8" });
      for (const line of text.trim().split("\n").filter(Boolean)) {
        const separator = line.indexOf(" ");
        refs[line.slice(0, separator)] = line.slice(separator + 1);
      }
      const objects = execFileSync("git", ["-C", repository, "rev-list", "--objects", "--all"],
        { encoding: "utf8" }).trim().split("\n").filter(Boolean)
        .map((line) => line.split(" ", 1)[0]).sort();
      return { refs, reachableObjectCount: new Set(objects).size };
    }
    appendFileSync(output, `${JSON.stringify({ label, clientResult,
      replicas: { A: state(repoA), B: state(repoB) } })}\n`);
  ' "$STATE_FILE" "$label" "$client_result" "$BARE_A" "$BARE_B"
}

commit_text_update() {
  local message=$1 line=$2
  printf '%s\n' "$line" >>"$SOURCE/payload.txt"
  git -C "$SOURCE" add payload.txt
  git -C "$SOURCE" commit -q --no-verify -m "$message"
}

push_ok() {
  local case_name=$1 fault=$2 advertisement=$3
  shift 3
  git_proxy "$case_name" "$fault" "$advertisement" -C "$SOURCE" push -q "$PROXY_URL" "$@"
}

push_fails() {
  local case_name=$1 fault=$2 advertisement=$3
  shift 3
  if git_proxy "$case_name" "$fault" "$advertisement" -C "$SOURCE" push "$PROXY_URL" "$@" \
      >"$WORK/logs/$case_name.log" 2>&1; then
    printf '%s unexpectedly reported push success\n' "$case_name" >&2
    return 1
  fi
}

start_sampler() {
  local label=$1 size_mib=$2 ready="$WORK/sampler.ready"
  unlink "$ready" 2>/dev/null || true
  node "$SCRIPT_DIR/rss-sampler.js" "$WORKERD_PID" "$label" "$size_mib" \
    "$MEMORY_FILE" "$ready" &
  SAMPLER_PID=$!
  for _ in $(seq 1 100); do
    [[ -f $ready ]] && return 0
    kill -0 "$SAMPLER_PID" 2>/dev/null || return 1
    sleep 0.01
  done
  printf 'RSS sampler did not become ready\n' >&2
  return 1
}

stop_sampler() {
  kill "$SAMPLER_PID" 2>/dev/null || true
  wait "$SAMPLER_PID" 2>/dev/null || true
  SAMPLER_PID=''
}

for command in curl dd git node npm sha256sum; do
  command -v "$command" >/dev/null || { printf 'required command missing: %s\n' "$command" >&2; exit 1; }
done
[[ -r /proc/self/status ]] || { printf 'this RSS harness requires Linux /proc\n' >&2; exit 1; }
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/false

heading 'SETUP: install pinned workerd and Gitea binaries when absent'
if [[ ! -x $SCRIPT_DIR/node_modules/.bin/workerd ]]; then
  npm ci --prefix "$SCRIPT_DIR" --no-audit --no-fund
fi
GITEA_BIN=$(download_gitea)
UPSTREAM_AUTH="Basic $(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64"))' \
  "$UPSTREAM_USER:$UPSTREAM_PASSWORD")"

mkdir -p "$WORK/logs"
AUDIT_FILE="$WORK/gateway-audit.jsonl"
RECONCILIATION_FILE="$WORK/reconciliation.jsonl"
STATE_FILE="$WORK/repository-states.jsonl"
MEMORY_FILE="$WORK/memory.jsonl"
: >"$AUDIT_FILE"
: >"$RECONCILIATION_FILE"
: >"$STATE_FILE"
: >"$MEMORY_FILE"
: >"$WORK/workerd.log"

heading "SETUP: initialize two independent Gitea $GITEA_VERSION instances"
for replica in A B; do
  if [[ $replica == A ]]; then port=$GITEA_A_PORT; else port=$GITEA_B_PORT; fi
  root="$WORK/gitea-$replica"
  repository_root="$root/repositories"
  config="$root/app.ini"
  mkdir -p "$root" "$repository_root"
  sed -e "s|__REPLICA__|$replica|g" \
    -e "s|__RUN_USER__|$(id -un)|g" \
    -e "s|__GITEA_ROOT__|$root|g" \
    -e "s|__REPOSITORY_ROOT__|$repository_root|g" \
    -e "s|__GITEA_PORT__|$port|g" \
    "$SCRIPT_DIR/gitea.app.ini.template" >"$config"
  GITEA_WORK_DIR="$root" "$GITEA_BIN" migrate --config "$config" \
    >"$WORK/logs/gitea-$replica-setup.log" 2>&1
  GITEA_WORK_DIR="$root" "$GITEA_BIN" admin user create --config "$config" \
    --username "$UPSTREAM_USER" --password "$UPSTREAM_PASSWORD" \
    --email "proxy-$replica@localhost" --must-change-password=false \
    >>"$WORK/logs/gitea-$replica-setup.log" 2>&1
  GITEA_WORK_DIR="$root" "$GITEA_BIN" web --config "$config" \
    >"$WORK/logs/gitea-$replica.log" 2>&1 &
  PIDS+=("$!")
  wait_http "http://127.0.0.1:$port/api/healthz"
  curl --silent --show-error --fail --user "$UPSTREAM_USER:$UPSTREAM_PASSWORD" \
    --header 'Content-Type: application/json' \
    --data '{"name":"replicated","private":true,"auto_init":false}' \
    --output /dev/null "http://127.0.0.1:$port/api/v1/user/repos"
done

BARE_A="$WORK/gitea-A/repositories/$UPSTREAM_USER/replicated.git"
BARE_B="$WORK/gitea-B/repositories/$UPSTREAM_USER/replicated.git"
DIRECT_A="http://127.0.0.1:$GITEA_A_PORT/$UPSTREAM_USER/replicated.git"
DIRECT_B="http://127.0.0.1:$GITEA_B_PORT/$UPSTREAM_USER/replicated.git"
PROXY_URL="http://127.0.0.1:$WORKERD_PORT/$UPSTREAM_USER/replicated.git"

heading 'SETUP: start fault gateways, durable recorder, and workerd proxy'
PORT=$GATEWAY_A_PORT GITEA_PORT=$GITEA_A_PORT REPLICA=A AUDIT_FILE="$AUDIT_FILE" \
  UPSTREAM_AUTH="$UPSTREAM_AUTH" SLOW_DELAY_MS="$SLOW_DELAY_MS" \
  node "$SCRIPT_DIR/fault-gateway.cjs" >"$WORK/logs/gateway-A.log" 2>&1 &
PIDS+=("$!")
PORT=$GATEWAY_B_PORT GITEA_PORT=$GITEA_B_PORT REPLICA=B AUDIT_FILE="$AUDIT_FILE" \
  UPSTREAM_AUTH="$UPSTREAM_AUTH" SLOW_DELAY_MS="$SLOW_DELAY_MS" \
  node "$SCRIPT_DIR/fault-gateway.cjs" >"$WORK/logs/gateway-B.log" 2>&1 &
PIDS+=("$!")
PORT=$RECORDER_PORT RECORD_FILE="$RECONCILIATION_FILE" \
  node "$SCRIPT_DIR/reconciliation-recorder.cjs" >"$WORK/logs/recorder.log" 2>&1 &
PIDS+=("$!")
wait_port 127.0.0.1 "$GATEWAY_A_PORT"
wait_port 127.0.0.1 "$GATEWAY_B_PORT"
wait_http "http://127.0.0.1:$RECORDER_PORT/healthz"

GENERATED_CONFIG=$(mktemp "$SCRIPT_DIR/workerd.generated.XXXXXX.capnp")
sed -e "s|__GATEWAY_A_PORT__|$GATEWAY_A_PORT|g" \
  -e "s|__GATEWAY_B_PORT__|$GATEWAY_B_PORT|g" \
  -e "s|__GITEA_A_PORT__|$GITEA_A_PORT|g" \
  -e "s|__GITEA_B_PORT__|$GITEA_B_PORT|g" \
  -e "s|__RECORDER_PORT__|$RECORDER_PORT|g" \
  -e "s|__WORKERD_PORT__|$WORKERD_PORT|g" \
  -e "s|__UPSTREAM_AUTH__|$UPSTREAM_AUTH|g" \
  "$SCRIPT_DIR/workerd.capnp.template" >"$GENERATED_CONFIG"
"$SCRIPT_DIR/node_modules/.bin/workerd" serve "$GENERATED_CONFIG" \
  >>"$WORK/workerd.log" 2>&1 &
WORKERD_PID=$!
PIDS+=("$WORKERD_PID")
wait_port 127.0.0.1 "$WORKERD_PORT"

SOURCE="$WORK/source"
git init -q -b main "$SOURCE"
git -C "$SOURCE" config user.name Experimenter
git -C "$SOURCE" config user.email exp@localhost
git -C "$SOURCE" config commit.gpgsign false
git -C "$SOURCE" config core.hooksPath /dev/null
git -C "$SOURCE" config pack.threads 1
printf 'seed dual replication\n' >"$SOURCE/payload.txt"
git -C "$SOURCE" add payload.txt
git -C "$SOURCE" commit -q --no-verify -m 'seed dual replication fixture'
git -C "$SOURCE" tag -a v1 -m 'dual replication fixture v1'

heading 'PHASE 1: initial, tag, incremental, branch, and deletion pushes converge'
push_ok happy-initial none A main refs/tags/v1
assert_replicas_equal happy-initial
commit_text_update 'happy incremental update' 'happy incremental update'
push_ok happy-incremental none A main
git -C "$SOURCE" branch feature main
push_ok happy-branch-create none A refs/heads/feature
push_ok happy-branch-delete none A :refs/heads/feature
assert_replicas_equal happy-updates
measure_state happy-updates success

heading 'PHASE 1: clone sessions alternate A/B and yield equivalent repositories'
for index in 1 2; do
  git_proxy "round-robin-clone-$index" none none clone -q --no-checkout \
    "$PROXY_URL" "$WORK/clone-$index"
done
[[ $(git -C "$WORK/clone-1" rev-parse refs/remotes/origin/main) == \
  "$(git -C "$WORK/clone-2" rev-parse refs/remotes/origin/main)" ]]
[[ $(git -C "$WORK/clone-1" show refs/remotes/origin/main:payload.txt) == \
  "$(git -C "$WORK/clone-2" show refs/remotes/origin/main:payload.txt)" ]]
commit_text_update 'round-robin fetch update' 'round-robin fetch update'
push_ok happy-fetch-update none A main
for index in 1 2; do
  git_proxy "round-robin-fetch-$index" none none -C "$WORK/clone-$index" fetch -q \
    "$PROXY_URL" +refs/heads/main:refs/remotes/origin/main
done
[[ $(git -C "$WORK/clone-1" rev-parse refs/remotes/origin/main) == \
  "$(git -C "$WORK/clone-2" rev-parse refs/remotes/origin/main)" ]]
assert_replicas_equal happy-round-robin-reads

heading 'PHASE 2 + 3: replica B returns HTTP 401, then lagging-advertisement retry converges'
previous_oid=$(git -C "$SOURCE" rev-parse HEAD)
commit_text_update 'partial HTTP 401 update' 'partial HTTP 401 update'
target_oid=$(git -C "$SOURCE" rev-parse HEAD)
push_fails partial-http-401 http-401 A main
[[ $(ref_oid "$BARE_A" refs/heads/main) == "$target_oid" ]]
[[ $(ref_oid "$BARE_B" refs/heads/main) == "$previous_oid" ]]
measure_state partial-http-401 failure
push_ok recovery-http-401 none B main
assert_replicas_equal recovery-http-401
measure_state recovery-http-401 success

heading 'PHASE 2 + 3: replica B returns HTTP 404, then retry converges'
previous_oid=$(git -C "$SOURCE" rev-parse HEAD)
commit_text_update 'partial HTTP 404 update' 'partial HTTP 404 update'
target_oid=$(git -C "$SOURCE" rev-parse HEAD)
push_fails partial-http-404 http-404 A main
[[ $(ref_oid "$BARE_A" refs/heads/main) == "$target_oid" ]]
[[ $(ref_oid "$BARE_B" refs/heads/main) == "$previous_oid" ]]
measure_state partial-http-404 failure
push_ok recovery-http-404 none B main
assert_replicas_equal recovery-http-404

heading 'PHASE 2 + 3: replica B rejects receive-pack inside HTTP 200, then retry converges'
previous_oid=$(git -C "$SOURCE" rev-parse HEAD)
commit_text_update 'partial Git rejection update' 'partial Git rejection update'
target_oid=$(git -C "$SOURCE" rev-parse HEAD)
push_fails partial-git-rejection reject A main
[[ $(ref_oid "$BARE_A" refs/heads/main) == "$target_oid" ]]
[[ $(ref_oid "$BARE_B" refs/heads/main) == "$previous_oid" ]]
measure_state partial-git-rejection failure
push_ok recovery-git-rejection none B main
assert_replicas_equal recovery-git-rejection

heading 'PHASE 2 + 3: replica B disconnects mid-pack without canceling replica A'
previous_oid=$(git -C "$SOURCE" rev-parse HEAD)
dd if=/dev/urandom of="$SOURCE/disconnect.bin" bs=1048576 count="$DISCONNECT_SIZE_MIB" status=none
git -C "$SOURCE" add disconnect.bin
git -C "$SOURCE" commit -q --no-verify -m 'partial mid-pack disconnect update'
target_oid=$(git -C "$SOURCE" rev-parse HEAD)
push_fails partial-disconnect disconnect A main
[[ $(ref_oid "$BARE_A" refs/heads/main) == "$target_oid" ]]
[[ $(ref_oid "$BARE_B" refs/heads/main) == "$previous_oid" ]]
measure_state partial-disconnect failure
push_ok recovery-disconnect none B main
assert_replicas_equal recovery-disconnect

heading 'PHASE 2: slow replica B backpressures A while dual writes stay bounded'
for size_mib in $SLOW_SIZES_MIB; do
  dd if=/dev/urandom of="$SOURCE/slow-$size_mib.bin" bs=1048576 count="$size_mib" status=none
  git -C "$SOURCE" add "slow-$size_mib.bin"
  git -C "$SOURCE" commit -q --no-verify -m "slow replica $size_mib MiB update"
  start_sampler "slow-$size_mib" "$size_mib"
  push_ok "slow-$size_mib" slow A main
  stop_sampler
  assert_replicas_equal "slow-$size_mib"
done
measure_state slow-consumer success

heading 'PHASE 2 + 3: pre-existing divergent advertisements and old-OID recovery'
git_direct divergence-clone clone -q "$DIRECT_B" "$WORK/divergent-b"
git -C "$WORK/divergent-b" config user.name DivergentExperimenter
git -C "$WORK/divergent-b" config user.email divergent@localhost
git -C "$WORK/divergent-b" config commit.gpgsign false
git -C "$WORK/divergent-b" config core.hooksPath /dev/null
printf 'replica B only\n' >"$WORK/divergent-b/divergent-b.txt"
git -C "$WORK/divergent-b" add divergent-b.txt
git -C "$WORK/divergent-b" commit -q --no-verify -m 'deliberately diverge replica B'
git_direct divergence-seed -C "$WORK/divergent-b" push -q "$DIRECT_B" main
divergent_b_oid=$(git -C "$WORK/divergent-b" rev-parse HEAD)
common_oid=$(git -C "$SOURCE" rev-parse HEAD)
[[ $(ref_oid "$BARE_A" refs/heads/main) == "$common_oid" ]]
[[ $(ref_oid "$BARE_B" refs/heads/main) == "$divergent_b_oid" ]]
commit_text_update 'desired update after advertised divergence' 'desired update after advertised divergence'
desired_oid=$(git -C "$SOURCE" rev-parse HEAD)
push_fails divergent-advertisements none A main
[[ $(ref_oid "$BARE_A" refs/heads/main) == "$desired_oid" ]]
[[ $(ref_oid "$BARE_B" refs/heads/main) == "$divergent_b_oid" ]]
measure_state divergent-advertisements failure
push_ok recovery-already-desired none B --force main
assert_replicas_equal recovery-already-desired
[[ $(ref_oid "$BARE_A" refs/heads/main) == "$desired_oid" ]]
measure_state recovery-already-desired success

heading 'RESULTS: enforce replication, recovery, memory, and journal assertions'
SLOW_SIZES_MIB="$SLOW_SIZES_MIB" MEMORY_BUDGET_MIB=${MEMORY_BUDGET_MIB:-24} \
  node "$SCRIPT_DIR/assert-results.cjs" \
  "$AUDIT_FILE" "$RECONCILIATION_FILE" "$STATE_FILE" "$MEMORY_FILE" "$WORK/workerd.log"

heading 'RAW WORKERD RSS MEASUREMENTS'
sed 's/^/  /' "$MEMORY_FILE"

heading 'DURABLE RECONCILIATION SUMMARY'
node -e '
  const fs = require("fs");
  const records = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const record of records) console.log(`  ${record.id}  ${record.stage}  ${record.experimentCase}`);
' "$RECONCILIATION_FILE"

heading 'DONE'
printf 'Both Gitea repositories ended with identical refs and reachable object graphs.\n'
printf 'Partial writes failed visibly and produced fsync-backed reconciliation records.\n'
printf 'Set KEEP=1 to retain the repositories, audits, measurements, and logs.\n'
