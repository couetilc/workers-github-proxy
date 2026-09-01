#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/gitea-proxy-compatibility.XXXXXX")
GITEA_PORT=${GITEA_PORT:-$((23000 + $$ % 4000))}
AUDIT_PORT=${AUDIT_PORT:-$((GITEA_PORT + 1))}
WORKERD_PORT=${WORKERD_PORT:-$((GITEA_PORT + 2))}
GITEA_VERSION=1.27.3
CLIENT_AUTH='Bearer client-only'
INVALID_CLIENT_AUTH='Bearer invalid-client'
UPSTREAM_USER='upstream-proxy'
UPSTREAM_PASSWORD='not-a-secret-for-local-experiment'
INVALID_UPSTREAM_AUTH='Basic deliberately-invalid-replacement'
PIDS=()
WORKERD_PID=''
GENERATED_CONFIGS=()
LAST_GENERATED_CONFIG=''

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]:-}"; do wait "$pid" 2>/dev/null || true; done
  for config in "${GENERATED_CONFIGS[@]:-}"; do unlink "$config" 2>/dev/null || true; done
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

wait_http() {
  local url=$1
  for _ in $(seq 1 200); do
    if curl --silent --fail --output /dev/null "$url"; then return 0; fi
    sleep 0.05
  done
  printf 'timed out waiting for %s\n' "$url" >&2
  return 1
}

wait_stopped() {
  local host=$1 port=$2
  for _ in $(seq 1 200); do
    if ! (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then return 0; fi
    exec 3>&- 3<&-
    sleep 0.05
  done
  printf 'timed out waiting for %s:%s to stop\n' "$host" "$port" >&2
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

generate_workerd_config() {
  local upstream_auth=$1
  LAST_GENERATED_CONFIG=$(mktemp "$SCRIPT_DIR/workerd.generated.XXXXXX.capnp")
  GENERATED_CONFIGS+=("$LAST_GENERATED_CONFIG")
  sed -e "s|__AUDIT_PORT__|$AUDIT_PORT|g" \
    -e "s|__WORKERD_PORT__|$WORKERD_PORT|g" \
    -e "s|__UPSTREAM_AUTH__|$upstream_auth|g" \
    "$SCRIPT_DIR/workerd.capnp.template" >"$LAST_GENERATED_CONFIG"
}

start_workerd() {
  local config=$1
  "$SCRIPT_DIR/node_modules/.bin/workerd" serve "$config" >>"$WORK/workerd.log" 2>&1 &
  WORKERD_PID=$!
  PIDS+=("$WORKERD_PID")
  wait_port 127.0.0.1 "$WORKERD_PORT"
}

stop_workerd() {
  if [[ -n $WORKERD_PID ]]; then
    kill "$WORKERD_PID" 2>/dev/null || true
    wait "$WORKERD_PID" 2>/dev/null || true
    WORKERD_PID=''
    wait_stopped 127.0.0.1 "$WORKERD_PORT"
  fi
}

git_direct() {
  local experiment_case=$1
  shift
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git -c "http.extraHeader=Authorization: $UPSTREAM_AUTH" \
    -c "http.extraHeader=X-Experiment-Case: $experiment_case" "$@"
}

git_proxy() {
  local experiment_case=$1
  shift
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git -c "http.extraHeader=Authorization: $CLIENT_AUTH" \
    -c "http.extraHeader=X-Experiment-Case: $experiment_case" "$@"
}

remote_ref() {
  local route=$1 experiment_case=$2 url=$3 ref=$4 output
  if [[ $route == direct ]]; then
    output=$(git_direct "$experiment_case" ls-remote "$url" "$ref")
  else
    output=$(git_proxy "$experiment_case" ls-remote "$url" "$ref")
  fi
  awk -v target="$ref" '$2 == target { print $1 }' <<<"$output"
}

assert_matching_ref() {
  local ref=$1 direct_oid proxy_oid
  direct_oid=$(remote_ref direct state-direct "$DIRECT_URL" "$ref")
  proxy_oid=$(remote_ref proxy state-proxy "$PROXY_URL" "$ref")
  [[ -n $direct_oid && $direct_oid == "$proxy_oid" ]] || {
    printf 'ref mismatch for %s: direct=%s proxy=%s\n' "$ref" "$direct_oid" "$proxy_oid" >&2
    return 1
  }
}

for command in curl git node npm sha256sum; do
  command -v "$command" >/dev/null || { printf 'required command missing: %s\n' "$command" >&2; exit 1; }
done
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/false

heading 'SETUP: install pinned workerd and Gitea binaries when absent'
if [[ ! -x $SCRIPT_DIR/node_modules/.bin/workerd ]]; then
  npm ci --prefix "$SCRIPT_DIR" --no-audit --no-fund
fi
GITEA_BIN=$(download_gitea)
UPSTREAM_AUTH="Basic $(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64"))' \
  "$UPSTREAM_USER:$UPSTREAM_PASSWORD")"

GITEA_ROOT="$WORK/gitea"
REPOSITORY_ROOT="$GITEA_ROOT/repositories"
GITEA_CONFIG="$GITEA_ROOT/app.ini"
AUDIT_FILE="$WORK/proxy-upstream-audit.jsonl"
mkdir -p "$GITEA_ROOT" "$REPOSITORY_ROOT" "$WORK/logs"
: >"$AUDIT_FILE"
: >"$WORK/workerd.log"
sed -e "s|__RUN_USER__|$(id -un)|g" \
  -e "s|__GITEA_ROOT__|$GITEA_ROOT|g" \
  -e "s|__REPOSITORY_ROOT__|$REPOSITORY_ROOT|g" \
  -e "s|__GITEA_PORT__|$GITEA_PORT|g" \
  "$SCRIPT_DIR/gitea.app.ini.template" >"$GITEA_CONFIG"

heading "SETUP: initialize Gitea $GITEA_VERSION with a private upstream account"
GITEA_WORK_DIR="$GITEA_ROOT" "$GITEA_BIN" migrate --config "$GITEA_CONFIG" \
  >"$WORK/logs/gitea-setup.log" 2>&1
GITEA_WORK_DIR="$GITEA_ROOT" "$GITEA_BIN" admin user create \
  --config "$GITEA_CONFIG" \
  --username "$UPSTREAM_USER" \
  --password "$UPSTREAM_PASSWORD" \
  --email proxy@localhost \
  --must-change-password=false \
  >>"$WORK/logs/gitea-setup.log" 2>&1
GITEA_WORK_DIR="$GITEA_ROOT" "$GITEA_BIN" web --config "$GITEA_CONFIG" \
  >"$WORK/logs/gitea.log" 2>&1 &
GITEA_PID=$!
PIDS+=("$GITEA_PID")
wait_http "http://127.0.0.1:$GITEA_PORT/api/healthz"

for repository in direct proxied; do
  curl --silent --show-error --fail \
    --user "$UPSTREAM_USER:$UPSTREAM_PASSWORD" \
    --header 'Content-Type: application/json' \
    --data "{\"name\":\"$repository\",\"private\":true,\"auto_init\":false}" \
    --output /dev/null \
    "http://127.0.0.1:$GITEA_PORT/api/v1/user/repos"
done

heading 'SETUP: start credential-classifying audit gateway and workerd proxy'
PORT=$AUDIT_PORT GITEA_PORT=$GITEA_PORT AUDIT_FILE="$AUDIT_FILE" \
  CLIENT_AUTH="$CLIENT_AUTH" UPSTREAM_AUTH="$UPSTREAM_AUTH" \
  node "$SCRIPT_DIR/audit-gateway.cjs" >"$WORK/logs/audit-gateway.log" 2>&1 &
AUDIT_PID=$!
PIDS+=("$AUDIT_PID")
wait_port 127.0.0.1 "$AUDIT_PORT"
generate_workerd_config "$UPSTREAM_AUTH"
VALID_CONFIG=$LAST_GENERATED_CONFIG
start_workerd "$VALID_CONFIG"

DIRECT_URL="http://127.0.0.1:$GITEA_PORT/$UPSTREAM_USER/direct.git"
PROXY_URL="http://127.0.0.1:$WORKERD_PORT/$UPSTREAM_USER/proxied.git"
SOURCE="$WORK/source"
git init -q -b main "$SOURCE"
git -C "$SOURCE" config user.name Experimenter
git -C "$SOURCE" config user.email exp@localhost
git -C "$SOURCE" config commit.gpgsign false
git -C "$SOURCE" config core.hooksPath /dev/null
printf 'seed through real Gitea\n' >"$SOURCE/payload.txt"
git -C "$SOURCE" add payload.txt
git -C "$SOURCE" commit -q --no-verify -m 'seed Gitea compatibility fixture'
git -C "$SOURCE" tag -a v1 -m 'compatibility fixture v1'

heading 'CONTROL + PROXY: initial push and matching refs'
git_direct initial-direct -C "$SOURCE" push -q "$DIRECT_URL" main refs/tags/v1
git_proxy initial-push -C "$SOURCE" push -q "$PROXY_URL" main refs/tags/v1
assert_matching_ref refs/heads/main
assert_matching_ref refs/tags/v1

heading 'CONTROL + PROXY: protocol v0 and requested-v2 clones'
for version in 0 2; do
  direct_clone="$WORK/direct-clone-v$version"
  proxy_clone="$WORK/proxy-clone-v$version"
  git_direct "clone-direct-v$version" -c "protocol.version=$version" \
    clone -q --no-checkout "$DIRECT_URL" "$direct_clone"
  git_proxy "clone-v$version" -c "protocol.version=$version" \
    clone -q --no-checkout "$PROXY_URL" "$proxy_clone"
  direct_oid=$(git -C "$direct_clone" rev-parse refs/remotes/origin/main)
  proxy_oid=$(git -C "$proxy_clone" rev-parse refs/remotes/origin/main)
  [[ $direct_oid == "$proxy_oid" ]]
  [[ $(git -C "$direct_clone" show refs/remotes/origin/main:payload.txt) == \
    "$(git -C "$proxy_clone" show refs/remotes/origin/main:payload.txt)" ]]
done

heading 'CONTROL + PROXY: incremental push and fetch'
printf 'incremental update\n' >>"$SOURCE/payload.txt"
git -C "$SOURCE" add payload.txt
git -C "$SOURCE" commit -q --no-verify -m 'incremental Gitea update'
git_direct incremental-direct -C "$SOURCE" push -q "$DIRECT_URL" main
git_proxy incremental-push -C "$SOURCE" push -q "$PROXY_URL" main
assert_matching_ref refs/heads/main
git_direct incremental-fetch-direct -C "$WORK/direct-clone-v2" fetch -q \
  "$DIRECT_URL" refs/heads/main:refs/remotes/origin/main
git_proxy incremental-fetch -C "$WORK/proxy-clone-v2" fetch -q \
  "$PROXY_URL" refs/heads/main:refs/remotes/origin/main
[[ $(git -C "$WORK/direct-clone-v2" rev-parse refs/remotes/origin/main) == \
  "$(git -C "$WORK/proxy-clone-v2" rev-parse refs/remotes/origin/main)" ]]

heading 'CONTROL + PROXY: branch creation and deletion'
git -C "$SOURCE" branch feature main
git_direct feature-direct -C "$SOURCE" push -q "$DIRECT_URL" refs/heads/feature
git_proxy feature-create -C "$SOURCE" push -q "$PROXY_URL" refs/heads/feature
assert_matching_ref refs/heads/feature
git_direct feature-delete-direct -C "$SOURCE" push -q "$DIRECT_URL" :refs/heads/feature
git_proxy feature-delete -C "$SOURCE" push -q "$PROXY_URL" :refs/heads/feature
[[ -z $(remote_ref direct feature-state-direct "$DIRECT_URL" refs/heads/feature) ]]
[[ -z $(remote_ref proxy feature-state-proxy "$PROXY_URL" refs/heads/feature) ]]

heading 'GITEA FAILURE: preserve an application-layer non-fast-forward rejection'
for repository in direct proxied; do
  git -C "$REPOSITORY_ROOT/$UPSTREAM_USER/$repository.git" config receive.denyNonFastForwards true
done
git -C "$SOURCE" switch -q -c rejection main
printf 'accepted rejection-control tip\n' >"$SOURCE/rejection.txt"
git -C "$SOURCE" add rejection.txt
git -C "$SOURCE" commit -q --no-verify -m 'accepted rejection-control tip'
git_direct rejection-seed-direct -C "$SOURCE" push -q "$DIRECT_URL" rejection
git_proxy rejection-seed -C "$SOURCE" push -q "$PROXY_URL" rejection
accepted_rejection_oid=$(git -C "$SOURCE" rev-parse HEAD)
git -C "$SOURCE" reset -q --hard main
if git_direct gitea-rejected-direct -C "$SOURCE" push --force "$DIRECT_URL" rejection \
    >"$WORK/logs/direct-rejection.log" 2>&1; then
  printf 'direct Gitea unexpectedly accepted a non-fast-forward push\n' >&2
  exit 1
fi
if git_proxy gitea-rejected -C "$SOURCE" push --force "$PROXY_URL" rejection \
    >"$WORK/logs/proxy-rejection.log" 2>&1; then
  printf 'proxied Gitea unexpectedly accepted a non-fast-forward push\n' >&2
  exit 1
fi
[[ $(remote_ref direct rejection-state-direct "$DIRECT_URL" refs/heads/rejection) == \
  "$accepted_rejection_oid" ]]
[[ $(remote_ref proxy rejection-state-proxy "$PROXY_URL" refs/heads/rejection) == \
  "$accepted_rejection_oid" ]]
git -C "$SOURCE" switch -q main

heading 'POLICY FAILURE: protected ref stops before Gitea receive-pack'
if git_proxy protected-policy -C "$SOURCE" push "$PROXY_URL" HEAD:refs/heads/protected \
    >"$WORK/logs/protected-policy.log" 2>&1; then
  printf 'protected ref unexpectedly passed local policy\n' >&2
  exit 1
fi
[[ -z $(remote_ref proxy protected-state "$PROXY_URL" refs/heads/protected) ]]

heading 'HTTP FAILURE: missing repository stays an error'
MISSING_DIRECT="http://127.0.0.1:$GITEA_PORT/$UPSTREAM_USER/missing.git"
MISSING_PROXY="http://127.0.0.1:$WORKERD_PORT/$UPSTREAM_USER/missing.git"
if git_direct missing-repository-direct ls-remote "$MISSING_DIRECT" \
    >"$WORK/logs/missing-direct.log" 2>&1; then
  printf 'direct Gitea unexpectedly found the missing repository\n' >&2
  exit 1
fi
if git_proxy missing-repository ls-remote "$MISSING_PROXY" \
    >"$WORK/logs/missing-proxy.log" 2>&1; then
  printf 'proxied Gitea unexpectedly found the missing repository\n' >&2
  exit 1
fi

heading 'CLIENT AUTH: absent and invalid credentials stop locally'
missing_client_status=$(curl --silent --output "$WORK/logs/missing-client-auth.response" \
  --dump-header "$WORK/logs/missing-client-auth.headers" \
  --write-out '%{http_code}' \
  --header 'X-Experiment-Case: missing-client-auth' \
  "$PROXY_URL/info/refs?service=git-upload-pack")
[[ $missing_client_status == 401 ]]
invalid_client_status=$(curl --silent --output "$WORK/logs/invalid-client-auth.response" \
  --dump-header "$WORK/logs/invalid-client-auth.headers" \
  --write-out '%{http_code}' \
  --header "Authorization: $INVALID_CLIENT_AUTH" \
  --header 'X-Experiment-Case: invalid-client-auth' \
  "$PROXY_URL/info/refs?service=git-upload-pack")
[[ $invalid_client_status == 401 ]]
if GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git -c 'http.extraHeader=X-Experiment-Case: missing-client-auth' \
    ls-remote "$PROXY_URL" >"$WORK/logs/missing-client-auth.log" 2>&1; then
  printf 'missing client credential unexpectedly succeeded\n' >&2
  exit 1
fi
if GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git -c "http.extraHeader=Authorization: $INVALID_CLIENT_AUTH" \
    -c 'http.extraHeader=X-Experiment-Case: invalid-client-auth' \
    ls-remote "$PROXY_URL" >"$WORK/logs/invalid-client-auth.log" 2>&1; then
  printf 'invalid client credential unexpectedly succeeded\n' >&2
  exit 1
fi

heading 'UPSTREAM AUTH: invalid replacement is preserved as a Gitea failure'
stop_workerd
generate_workerd_config "$INVALID_UPSTREAM_AUTH"
INVALID_CONFIG=$LAST_GENERATED_CONFIG
start_workerd "$INVALID_CONFIG"
upstream_auth_status=$(curl --silent --output "$WORK/logs/upstream-auth-challenge.response" \
  --dump-header "$WORK/logs/upstream-auth-challenge.headers" \
  --write-out '%{http_code}' \
  --header "Authorization: $CLIENT_AUTH" \
  --header 'X-Experiment-Case: upstream-auth-challenge' \
  "$PROXY_URL/info/refs?service=git-upload-pack")
[[ $upstream_auth_status == 401 ]]
grep --quiet --ignore-case '^www-authenticate: Basic' \
  "$WORK/logs/upstream-auth-challenge.headers"
if git_proxy upstream-auth-failure ls-remote "$PROXY_URL" \
    >"$WORK/logs/upstream-auth-failure.log" 2>&1; then
  printf 'invalid upstream credential unexpectedly succeeded\n' >&2
  exit 1
fi
stop_workerd

heading 'RESULTS: semantic, authentication, and protocol assertions'
CLIENT_AUTH="$CLIENT_AUTH" UPSTREAM_AUTH="$UPSTREAM_AUTH" \
  UPSTREAM_PASSWORD="$UPSTREAM_PASSWORD" \
  node "$SCRIPT_DIR/assert-results.cjs" \
  "$AUDIT_FILE" "$WORK/workerd.log" "$WORK/logs/audit-gateway.log" "$WORK/logs/gitea.log"
git -C "$REPOSITORY_ROOT/$UPSTREAM_USER/direct.git" fsck --strict --no-progress >/dev/null
git -C "$REPOSITORY_ROOT/$UPSTREAM_USER/proxied.git" fsck --strict --no-progress >/dev/null

heading 'AUDIT SUMMARY'
node -e '
  const fs = require("fs");
  const records = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
  const summary = new Map();
  for (const record of records) {
    const key = `${record.experimentCase} ${record.method} ${record.responseStatus}`;
    summary.set(key, (summary.get(key) || 0) + 1);
  }
  for (const [key, count] of summary) console.log(`  ${count}  ${key}`);
' "$AUDIT_FILE"

heading 'DONE'
printf 'Direct and proxied Gitea repositories have matching refs and valid object graphs.\n'
printf 'Set KEEP=1 to retain repositories, audits, and logs under the temporary workspace.\n'
