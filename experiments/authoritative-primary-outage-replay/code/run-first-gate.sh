#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/authoritative-primary-gate.XXXXXX")
PORT=${PORT:-$((26000 + $$ % 3000))}
REPO_NAME=${ARTIFACTS_REPO:-"outage-replay-$(date -u +%Y%m%d-%H%M%S)-$$"}
NAMESPACE='workers-github-proxy-experiments'
WRANGLER_PID=''

cleanup() {
  if [[ -n $WRANGLER_PID ]]; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  if [[ ${KEEP:-0} == 1 ]]; then
    printf 'kept local gate workspace: %s\n' "$RUN_DIR"
  else
    rm -rf "$RUN_DIR"
  fi
}
trap cleanup EXIT INT TERM

heading() { printf '\n########## %s ##########\n' "$1"; }

for required_var in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [[ -n ${!required_var:-} ]] || {
    printf 'required environment variable is missing: %s\n' "$required_var" >&2
    exit 1
  }
done

for command_name in curl git jq node npm; do
  command -v "$command_name" >/dev/null || {
    printf 'required command is missing: %s\n' "$command_name" >&2
    exit 1
  }
done

[[ $REPO_NAME =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  printf 'invalid ARTIFACTS_REPO: %s\n' "$REPO_NAME" >&2
  exit 1
}

if [[ ! -x $SCRIPT_DIR/node_modules/.bin/wrangler ]]; then
  npm ci --prefix "$SCRIPT_DIR" --no-audit --no-fund
fi

export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/false

heading 'START: experiment Worker with remote Artifacts binding'
"$SCRIPT_DIR/node_modules/.bin/wrangler" dev \
  --config "$SCRIPT_DIR/wrangler.jsonc" \
  --ip 127.0.0.1 \
  --port "$PORT" \
  >"$RUN_DIR/wrangler.log" 2>&1 &
WRANGLER_PID=$!

for _ in $(seq 1 240); do
  if curl --silent --fail --output /dev/null "http://127.0.0.1:$PORT/health"; then
    break
  fi
  kill -0 "$WRANGLER_PID" 2>/dev/null || {
    sed -E 's/art_v[[:digit:]]+_[^"[:space:]]+/[redacted-artifacts-token]/g' \
      "$RUN_DIR/wrangler.log" >&2
    exit 1
  }
  sleep 0.25
done
curl --silent --fail --output /dev/null "http://127.0.0.1:$PORT/health" || {
  printf 'Wrangler did not become ready\n' >&2
  exit 1
}

heading 'CREATE: repository through env.ARTIFACTS'
if [[ ${REUSE_EXISTING:-0} == 1 ]]; then
  curl --silent --show-error --fail-with-body \
    --header 'Content-Type: application/json' \
    --data '{"scope":"write","ttl":3600}' \
    --output "$RUN_DIR/token.json" \
    "http://127.0.0.1:$PORT/repos/$REPO_NAME/tokens"
  chmod 600 "$RUN_DIR/token.json"
  REMOTE="https://$CLOUDFLARE_ACCOUNT_ID.artifacts.cloudflare.net/git/$NAMESPACE/$REPO_NAME.git"
  TOKEN=$(jq -er '.token' "$RUN_DIR/token.json")
  DEFAULT_BRANCH=main
  printf 'reused repository: %s (default branch: %s)\n' "$REPO_NAME" "$DEFAULT_BRANCH"
else
  curl --silent --show-error --fail-with-body \
    --header 'Content-Type: application/json' \
    --data "{\"name\":\"$REPO_NAME\"}" \
    --output "$RUN_DIR/create.json" \
    "http://127.0.0.1:$PORT/repos"
  chmod 600 "$RUN_DIR/create.json"

  REMOTE=$(jq -er '.remote' "$RUN_DIR/create.json")
  TOKEN=$(jq -er '.token' "$RUN_DIR/create.json")
  DEFAULT_BRANCH=$(jq -er '.defaultBranch' "$RUN_DIR/create.json")
  printf 'created repository: %s (default branch: %s)\n' "$REPO_NAME" "$DEFAULT_BRANCH"
fi
[[ $DEFAULT_BRANCH == main ]]
[[ $TOKEN =~ ^art_v[[:digit:]]+_[^[:space:]?]+\?expires=[[:digit:]]+$ ]]
[[ $REMOTE == https://*.artifacts.cloudflare.net/git/*/"$REPO_NAME".git ]]

heading 'PUSH: initial commit through Git smart HTTP'
SOURCE="$RUN_DIR/source"
git init -q -b main "$SOURCE"
mkdir -p "$RUN_DIR/no-hooks"
git -C "$SOURCE" config core.hooksPath "$RUN_DIR/no-hooks"
git -C "$SOURCE" config user.name 'Artifacts experiment'
git -C "$SOURCE" config user.email 'artifacts-experiment@localhost'
printf '# authoritative primary gate\n\nrepository: %s\n' "$REPO_NAME" >"$SOURCE/README.md"
git -C "$SOURCE" add README.md
git -C "$SOURCE" commit -q -m 'Initial Artifacts commit'
EXPECTED_OID=$(git -C "$SOURCE" rev-parse HEAD)

push_started=$(date +%s%N)
git -c "http.extraHeader=Authorization: Bearer $TOKEN" \
  -C "$SOURCE" push --quiet "$REMOTE" HEAD:refs/heads/main
push_finished=$(date +%s%N)
push_ms=$(((push_finished - push_started) / 1000000))

heading 'CLONE: serve the accepted commit from Artifacts'
CLONE="$RUN_DIR/clone"
clone_started=$(date +%s%N)
git -c "http.extraHeader=Authorization: Bearer $TOKEN" \
  clone --quiet "$REMOTE" "$CLONE"
clone_finished=$(date +%s%N)
clone_ms=$(((clone_finished - clone_started) / 1000000))
ACTUAL_OID=$(git -C "$CLONE" rev-parse HEAD)
[[ $ACTUAL_OID == "$EXPECTED_OID" ]]
git -C "$CLONE" fsck --strict --no-progress
cmp "$SOURCE/README.md" "$CLONE/README.md"

heading 'PASS: Artifacts first gate'
printf 'repository=%s\n' "$REPO_NAME"
printf 'oid=%s\n' "$EXPECTED_OID"
printf 'push_ack_ms=%s\n' "$push_ms"
printf 'clone_ms=%s\n' "$clone_ms"
printf 'binding_create=pass smart_http_push=pass smart_http_clone=pass fsck=pass\n'
