#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/authoritative-primary-replay.XXXXXX")
WORKER_PORT=${WORKER_PORT:-$((29000 + $$ % 1500))}
OUTAGE_PORT=${OUTAGE_PORT:-$((WORKER_PORT + 1))}
REPO_NAME=${ARTIFACTS_REPO:-outage-replay-gate-20260901}
NAMESPACE='workers-github-proxy-experiments'
WRANGLER_PID=''
OUTAGE_PID=''
SAMPLER_PID=''

cleanup() {
  if [[ -n $SAMPLER_PID ]]; then kill "$SAMPLER_PID" 2>/dev/null || true; fi
  if [[ -n $OUTAGE_PID ]]; then kill "$OUTAGE_PID" 2>/dev/null || true; fi
  if [[ -n $WRANGLER_PID ]]; then kill "$WRANGLER_PID" 2>/dev/null || true; fi
  if [[ -n $SAMPLER_PID ]]; then wait "$SAMPLER_PID" 2>/dev/null || true; fi
  if [[ -n $OUTAGE_PID ]]; then wait "$OUTAGE_PID" 2>/dev/null || true; fi
  if [[ -n $WRANGLER_PID ]]; then wait "$WRANGLER_PID" 2>/dev/null || true; fi
  if [[ ${KEEP:-0} == 1 ]]; then
    printf 'kept replay workspace: %s\n' "$RUN_DIR"
  else
    rm -rf "$RUN_DIR"
  fi
}
trap cleanup EXIT INT TERM

heading() { printf '\n########## %s ##########\n' "$1"; }
now_ns() { date +%s%N; }

for required_var in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID GH_TOKEN GITHUB_TEST_REPO; do
  [[ -n ${!required_var:-} ]] || {
    printf 'required environment variable is missing: %s\n' "$required_var" >&2
    exit 1
  }
done

for command_name in base64 cmp curl git gh jq node npm; do
  command -v "$command_name" >/dev/null || {
    printf 'required command is missing: %s\n' "$command_name" >&2
    exit 1
  }
done

[[ $REPO_NAME =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
[[ $GITHUB_TEST_REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  printf 'GITHUB_TEST_REPO must be owner/name\n' >&2
  exit 1
}

if [[ ! -x $SCRIPT_DIR/node_modules/.bin/wrangler ]]; then
  npm ci --prefix "$SCRIPT_DIR" --no-audit --no-fund
fi

export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/false
export GIT_CONFIG_NOSYSTEM=1
GITHUB_AUTH=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')
GITHUB_URL="https://github.com/$GITHUB_TEST_REPO.git"
PROXY_URL="http://127.0.0.1:$WORKER_PORT/$REPO_NAME.git"
OUTAGE_URL="http://127.0.0.1:$OUTAGE_PORT/$GITHUB_TEST_REPO.git"
EVENTS_FILE="$RUN_DIR/events.jsonl"
OUTAGE_AUDIT="$RUN_DIR/outage-audit.jsonl"
MEMORY_FILE="$RUN_DIR/memory.jsonl"
: >"$EVENTS_FILE"
: >"$OUTAGE_AUDIT"
: >"$MEMORY_FILE"

git_primary() {
  GIT_CONFIG_GLOBAL=/dev/null git "$@"
}

git_github() {
  GIT_CONFIG_GLOBAL=/dev/null git \
    -c "http.extraHeader=Authorization: Basic $GITHUB_AUTH" "$@"
}

remote_oid() {
  local remote=$1 ref=$2 mode=${3:-primary}
  if [[ $mode == github ]]; then
    git_github ls-remote --refs "$remote" "$ref" | awk 'NR == 1 { print $1 }'
  else
    git_primary ls-remote --refs "$remote" "$ref" | awk 'NR == 1 { print $1 }'
  fi
}

heading 'SAFETY: verify the dedicated GitHub target is empty'
gh repo view "$GITHUB_TEST_REPO" --json nameWithOwner,isPrivate >/dev/null
existing_github_refs=$(git_github ls-remote --heads --tags "$GITHUB_URL")
[[ -z $existing_github_refs ]] || {
  printf 'refusing to overwrite non-empty GitHub test repository: %s\n' "$GITHUB_TEST_REPO" >&2
  exit 1
}

heading 'START: local Worker proxy with remote Artifacts binding'
"$SCRIPT_DIR/node_modules/.bin/wrangler" dev \
  --config "$SCRIPT_DIR/wrangler.jsonc" \
  --ip 127.0.0.1 \
  --port "$WORKER_PORT" \
  --var "ARTIFACTS_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID" \
  >"$RUN_DIR/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 240); do
  if curl --silent --fail --output /dev/null "http://127.0.0.1:$WORKER_PORT/health"; then break; fi
  kill -0 "$WRANGLER_PID" 2>/dev/null || {
    sed -E 's/art_v[[:digit:]]+_[^"[:space:]]+/[redacted-artifacts-token]/g' \
      "$RUN_DIR/wrangler.log" >&2
    exit 1
  }
  sleep 0.25
done
curl --silent --fail --output /dev/null "http://127.0.0.1:$WORKER_PORT/health"

node "$SCRIPT_DIR/process-tree-rss.cjs" "$WRANGLER_PID" primary-proxy "$MEMORY_FILE" &
SAMPLER_PID=$!

PORT=$OUTAGE_PORT AUDIT_FILE=$OUTAGE_AUDIT node "$SCRIPT_DIR/origin-outage.cjs" \
  >"$RUN_DIR/outage-origin.log" 2>&1 &
OUTAGE_PID=$!
for _ in $(seq 1 100); do
  if curl --silent --fail --output /dev/null "http://127.0.0.1:$OUTAGE_PORT/health"; then break; fi
  kill -0 "$OUTAGE_PID" 2>/dev/null || exit 1
  sleep 0.05
done
curl --silent --fail --output /dev/null "http://127.0.0.1:$OUTAGE_PORT/health"

heading 'BASELINE: clone the first-gate commit through the Worker proxy'
SOURCE="$RUN_DIR/source"
git_primary clone --quiet "$PROXY_URL" "$SOURCE"
mkdir -p "$RUN_DIR/no-hooks"
git -C "$SOURCE" config core.hooksPath "$RUN_DIR/no-hooks"
git -C "$SOURCE" config user.name 'Artifacts outage experiment'
git -C "$SOURCE" config user.email 'artifacts-outage@localhost'
git -C "$SOURCE" fsck --strict --no-progress

EVENT_NUMBER=0
accept_primary_update() {
  local label=$1 ref=$2 refspec=$3 desired=$4 outage_attempt=${5:-yes}
  local before started finished ack_ms verify_dir clone_started clone_finished clone_ms
  local actual reachable outage_result
  EVENT_NUMBER=$((EVENT_NUMBER + 1))
  before=$(remote_oid "$PROXY_URL" "$ref")

  started=$(now_ns)
  git_primary -C "$SOURCE" push --quiet "$PROXY_URL" "$refspec"
  finished=$(now_ns)
  ack_ms=$(((finished - started) / 1000000))

  verify_dir="$RUN_DIR/verify-$EVENT_NUMBER.git"
  clone_started=$(now_ns)
  git_primary clone --quiet --mirror "$PROXY_URL" "$verify_dir"
  clone_finished=$(now_ns)
  clone_ms=$(((clone_finished - clone_started) / 1000000))
  git --git-dir="$verify_dir" fsck --strict --no-progress
  actual=$(git --git-dir="$verify_dir" rev-parse --verify "$ref" 2>/dev/null || true)
  if [[ $desired == deleted ]]; then
    [[ -z $actual ]]
    desired=''
  else
    [[ $actual == "$desired" ]]
  fi
  reachable=$(git --git-dir="$verify_dir" rev-list --objects --all | awk '{print $1}' | sort -u | wc -l)

  outage_result=not_attempted
  if [[ $outage_attempt == yes ]]; then
    if git_primary -C "$SOURCE" push "$OUTAGE_URL" "$refspec" \
        >"$RUN_DIR/outage-$EVENT_NUMBER.log" 2>&1; then
      printf 'outage sync unexpectedly succeeded for %s\n' "$label" >&2
      return 1
    fi
    outage_result=http_503
    [[ $(jq -r 'select(.responseStatus == 503) | .responseStatus' "$OUTAGE_AUDIT" | tail -1) == 503 ]]
  fi

  jq -cn \
    --arg label "$label" \
    --arg ref "$ref" \
    --arg before "$before" \
    --arg desired "$desired" \
    --arg outageResult "$outage_result" \
    --argjson clientAckMs "$ack_ms" \
    --argjson verificationCloneMs "$clone_ms" \
    --argjson reachableObjects "$reachable" \
    '{label:$label, ref:$ref,
      before:(if $before == "" then null else $before end),
      desired:(if $desired == "" then null else $desired end),
      clientAttempts:1, clientResult:"accepted", clientAckMs:$clientAckMs,
      primaryClone:"verified", verificationCloneMs:$verificationCloneMs,
      reachableObjects:$reachable, originSync:$outageResult,
      status:"pending_sync"}' >>"$EVENTS_FILE"
  printf '%-20s accepted=%4sms clone=%4sms status=pending_sync\n' "$label" "$ack_ms" "$clone_ms"
}

commit_main() {
  local message=$1 content=$2
  printf '%s\n' "$content" >>"$SOURCE/history.txt"
  git -C "$SOURCE" add history.txt
  git -C "$SOURCE" commit -q -m "$message"
}

heading 'OUTAGE: accept and serve Git changes while every origin sync gets 503'
commit_main 'Increment main during outage' 'incremental-main'
accept_primary_update incremental-main refs/heads/main HEAD:refs/heads/main "$(git -C "$SOURCE" rev-parse HEAD)"

git -C "$SOURCE" tag -a v1 -m 'Annotated outage tag v1'
accept_primary_update annotated-tag refs/tags/v1 refs/tags/v1:refs/tags/v1 "$(git -C "$SOURCE" rev-parse refs/tags/v1)"

git -C "$SOURCE" switch -q -c feature/outage
printf '%s\n' 'feature created during outage' >"$SOURCE/feature.txt"
git -C "$SOURCE" add feature.txt
git -C "$SOURCE" commit -q -m 'Create outage feature branch'
accept_primary_update branch-create refs/heads/feature/outage HEAD:refs/heads/feature/outage "$(git -C "$SOURCE" rev-parse HEAD)"
git -C "$SOURCE" switch -q main
accept_primary_update branch-delete refs/heads/feature/outage :refs/heads/feature/outage deleted

for update in 1 2 3; do
  commit_main "Same-ref outage update $update" "same-ref-$update"
  accept_primary_update "same-ref-$update" refs/heads/main HEAD:refs/heads/main "$(git -C "$SOURCE" rev-parse HEAD)"
done

kill "$SAMPLER_PID" 2>/dev/null || true
wait "$SAMPLER_PID" 2>/dev/null || true
SAMPLER_PID=''

heading 'RECOVERY: coalesce final desired refs and synchronize GitHub'
PRIMARY_MIRROR="$RUN_DIR/primary-mirror.git"
GITHUB_MIRROR="$RUN_DIR/github-mirror.git"
git_primary clone --quiet --mirror "$PROXY_URL" "$PRIMARY_MIRROR"
git --git-dir="$PRIMARY_MIRROR" remote add github "$GITHUB_URL"
recovery_started=$(now_ns)
git_github --git-dir="$PRIMARY_MIRROR" push --quiet --prune github \
  'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
gh repo edit "$GITHUB_TEST_REPO" --default-branch main >/dev/null
git_github clone --quiet --mirror "$GITHUB_URL" "$GITHUB_MIRROR"

git --git-dir="$PRIMARY_MIRROR" for-each-ref \
  --format='%(refname) %(objectname)' refs/heads refs/tags | sort >"$RUN_DIR/primary.refs"
git --git-dir="$GITHUB_MIRROR" for-each-ref \
  --format='%(refname) %(objectname)' refs/heads refs/tags | sort >"$RUN_DIR/github.refs"
cmp "$RUN_DIR/primary.refs" "$RUN_DIR/github.refs"

git --git-dir="$PRIMARY_MIRROR" rev-list --objects --all | awk '{print $1}' | sort -u >"$RUN_DIR/primary.objects"
git --git-dir="$GITHUB_MIRROR" rev-list --objects --all | awk '{print $1}' | sort -u >"$RUN_DIR/github.objects"
cmp "$RUN_DIR/primary.objects" "$RUN_DIR/github.objects"
git --git-dir="$PRIMARY_MIRROR" fsck --strict --no-progress
git --git-dir="$GITHUB_MIRROR" fsck --strict --no-progress
recovery_finished=$(now_ns)
convergence_ms=$(((recovery_finished - recovery_started) / 1000000))

event_count=$(jq -s 'length' "$EVENTS_FILE")
distinct_refs=$(jq -s '[.[].ref] | unique | length' "$EVENTS_FILE")
reachable_objects=$(wc -l <"$RUN_DIR/primary.objects")
printf 'events=%s distinct_buffered_refs=%s convergence_ms=%s reachable_objects=%s status=synced\n' \
  "$event_count" "$distinct_refs" "$convergence_ms" "$reachable_objects"

heading 'CONFLICT: inject an unrelated GitHub OID and refuse overwrite'
before_conflict=$(git -C "$SOURCE" rev-parse refs/heads/main)
GITHUB_CONFLICT="$RUN_DIR/github-conflict"
git_github clone --quiet "$GITHUB_URL" "$GITHUB_CONFLICT"
git -C "$GITHUB_CONFLICT" config core.hooksPath "$RUN_DIR/no-hooks"
git -C "$GITHUB_CONFLICT" config user.name 'GitHub conflict injector'
git -C "$GITHUB_CONFLICT" config user.email 'github-conflict@localhost'

commit_main 'Primary desired update after recovery' 'primary-desired-after-recovery'
desired_conflict=$(git -C "$SOURCE" rev-parse HEAD)
accept_primary_update conflict-primary refs/heads/main HEAD:refs/heads/main "$desired_conflict" no

printf '%s\n' 'unrelated GitHub-side update' >"$GITHUB_CONFLICT/origin-conflict.txt"
git -C "$GITHUB_CONFLICT" add origin-conflict.txt
git -C "$GITHUB_CONFLICT" commit -q -m 'Inject unrelated GitHub OID'
git_github -C "$GITHUB_CONFLICT" push --quiet origin HEAD:refs/heads/main
observed_conflict=$(remote_oid "$GITHUB_URL" refs/heads/main github)
[[ $observed_conflict != "$before_conflict" ]]
[[ $observed_conflict != "$desired_conflict" ]]

classification=$(node "$SCRIPT_DIR/classify-replay.mjs" \
  "$before_conflict" "$desired_conflict" "$observed_conflict")
[[ $classification == needs_review ]]
observed_after_policy=$(remote_oid "$GITHUB_URL" refs/heads/main github)
[[ $observed_after_policy == "$observed_conflict" ]]

jq -cn \
  --arg before "$before_conflict" \
  --arg desired "$desired_conflict" \
  --arg observed "$observed_conflict" \
  --arg classification "$classification" \
  '{ref:"refs/heads/main", before:$before, desired:$desired,
    observed:$observed, classification:$classification,
    automaticOverwrite:false}' >"$RUN_DIR/conflict.json"

memory_baseline=$(jq -r '.baselineKiB' "$MEMORY_FILE")
memory_peak=$(jq -r '.peakKiB' "$MEMORY_FILE")
memory_delta=$(jq -r '.deltaKiB' "$MEMORY_FILE")

heading 'PASS: authoritative primary outage replay'
printf 'repository=%s\n' "$REPO_NAME"
printf 'github_test_repository=%s\n' "$GITHUB_TEST_REPO"
printf 'accepted_outage_events=%s client_retries=0\n' "$event_count"
printf 'recovery_status=synced convergence_ms=%s refs_and_objects=equivalent\n' "$convergence_ms"
printf 'conflict_status=%s automatic_overwrite=false\n' "$classification"
printf 'local_worker_process_tree_rss_kib baseline=%s peak=%s delta=%s\n' \
  "$memory_baseline" "$memory_peak" "$memory_delta"

if [[ ${KEEP:-0} == 1 ]]; then
  jq -s '.' "$EVENTS_FILE" >"$RUN_DIR/events.json"
  printf 'evidence_dir=%s\n' "$RUN_DIR"
fi
