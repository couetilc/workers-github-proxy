#!/usr/bin/env bash
# End-to-end reproduction: can a git remote proxy terminate the client's TLS,
# then RE-ENCRYPT and pass the request on to the proxied service?
#
# Topology (all on loopback, disposable repos + a throwaway PKI in a temp dir):
#
#   git client --TLS/proxy-ca--> [ re-encrypt proxy :8443 ] --TLS/upstream-ca--> [ upstream git :9443 ]
#
# The script proves the positive case AND runs three negative controls showing
# both TLS legs genuinely authenticate (so the positive case isn't verification
# being switched off):
#   MAIN      push+fetch complete through the proxy; proxy sees + carves plaintext.
#   CONTROL A client does NOT trust proxy-ca               -> refused (client leg verified).
#   CONTROL B client hits the proxy by a name not in its SAN -> refused (cert must match host).
#   CONTROL C proxy is given the WRONG upstream CA          -> 502 (re-encrypt leg verified).
#
# Env: KEEP=1 keeps the temp workdir. UPSTREAM_PORT / PROXY_PORT override ports.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/git-tls.XXXXXX")"
UPSTREAM_PORT=${UPSTREAM_PORT:-9443}
PROXY_PORT=${PROXY_PORT:-8443}
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  if [ "${KEEP:-0}" = "1" ]; then echo "[kept workdir: $WORK]"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

wait_port() { for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && { exec 3>&- 3<&-; return 0; }; sleep 0.1; done; echo "timed out waiting for $1:$2" >&2; return 1; }
hr() { printf '\n########## %s ##########\n' "$1"; }

# --- PKI: two independent CAs (see gen-certs.sh) -------------------------------
hr "SETUP: mint a throwaway PKI (proxy-ca + upstream-ca)"
CERTS="$WORK/certs"
"$SCRIPT_DIR/gen-certs.sh" "$CERTS"

# --- source repo with an identifiable (fake) payload --------------------------
hr "SETUP: source repo with a payload we can watch cross the DECRYPTED wire"
SRC="$WORK/source-repo"
mkdir -p "$SRC"; ( cd "$SRC"
  git init -q -b main
  git config core.hooksPath /dev/null   # hermetic: ignore any host-global git hooks
  git config user.email exp@localhost
  git config user.name Experimenter
  git config commit.gpgsign false
  printf 'the-scent-of-discovery\nAPI_TOKEN=hunter2-not-real\n' > payload.txt
  git add payload.txt && git commit -q --no-verify -m "seed: payload"
)
echo "source HEAD: $(git -C "$SRC" rev-parse --short HEAD)"

# --- upstream bare repo (fresh + empty => initial push sends a COMPLETE pack) --
BARE_ROOT="$WORK/bare-repos"; DUMP_DIR="$WORK/dump"
mkdir -p "$BARE_ROOT"
git init -q --bare "$BARE_ROOT/hello-world.git"
git -C "$BARE_ROOT/hello-world.git" config http.receivepack true

# --- start the UPSTREAM HTTPS git server --------------------------------------
hr "SETUP: start upstream HTTPS git server on https://localhost:$UPSTREAM_PORT"
TLS_CERT="$CERTS/upstream.crt" TLS_KEY="$CERTS/upstream.key" \
  GIT_PROJECT_ROOT="$BARE_ROOT" PORT=$UPSTREAM_PORT \
  node "$SCRIPT_DIR/upstream-server.js" >"$WORK/upstream.log" 2>&1 &
PIDS+=($!); wait_port 127.0.0.1 "$UPSTREAM_PORT"

# --- start the RE-ENCRYPT PROXY (correct upstream CA) -------------------------
hr "SETUP: start TLS-terminating re-encrypt proxy on https://127.0.0.1:$PROXY_PORT"
start_proxy() { # upstream_ca_file  logfile
  TLS_CERT="$CERTS/proxy.crt" TLS_KEY="$CERTS/proxy.key" \
    UPSTREAM_ORIGIN="https://localhost:$UPSTREAM_PORT" \
    UPSTREAM_CA="$1" UPSTREAM_SERVERNAME=localhost \
    DUMP_DIR="$DUMP_DIR" PORT=$PROXY_PORT \
    node "$SCRIPT_DIR/tls-reencrypt-proxy.js" >"$2" 2>&1 &
  PROXY_PID=$!; PIDS+=($PROXY_PID); wait_port 127.0.0.1 "$PROXY_PORT"
}
start_proxy "$CERTS/upstream-ca.crt" "$WORK/proxy.log"

# The remote points at the proxy (the swapped host). git trusts proxy-ca; TLS
# verification stays ON throughout -- no -k, no http.sslVerify=false anywhere.
REMOTE="https://127.0.0.1:$PROXY_PORT/hello-world.git"
CA="-c http.sslCAInfo=$CERTS/proxy-ca.crt"
git -C "$SRC" remote add origin "$REMOTE"

# ============================ MAIN =============================================
hr "MAIN: push through the proxy (TLS terminated -> re-encrypted -> upstream)"
echo "-- push for real (should succeed) --"
GIT_TERMINAL_PROMPT=0 git $CA -C "$SRC" push origin main 2>&1 | sed 's/^/   git: /'
echo "-- fetch/ls-remote back through the proxy --"
GIT_TERMINAL_PROMPT=0 git $CA -C "$SRC" ls-remote origin 2>&1 | sed 's/^/   git: /'
echo "-- upstream bare repo now holds the push: --"
git -C "$BARE_ROOT/hello-world.git" cat-file -p main:payload.txt 2>&1 | sed 's/^/   upstream> /'
echo "-- what the proxy saw in PLAINTEXT (decrypted between the two TLS legs): --"
sed 's/^/   /' "$WORK/proxy.log"

hr "MAIN: reconstruct the payload from the PLAINTEXT packfile the proxy carved"
REC="$WORK/reconstruct"
git init -q "$REC"
cp "$DUMP_DIR/intercepted-plaintext.pack" "$REC/.git/objects/pack/intercepted-plaintext.pack"
( cd "$REC" && git index-pack .git/objects/pack/intercepted-plaintext.pack >/dev/null 2>&1 )
echo "-- objects recovered from the decrypted stream alone: --"
git -C "$REC" cat-file --batch-all-objects --batch-check 2>/dev/null | sed 's/^/   /'
echo "-- payload.txt reconstructed from the decrypted bytes: --"
for B in $(git -C "$REC" cat-file --batch-all-objects --batch-check 2>/dev/null | awk '$2=="blob"{print $1}'); do
  git -C "$REC" cat-file -p "$B" | sed 's/^/   > /'
done

# ======================= NEGATIVE CONTROLS ====================================
hr "CONTROL A: client does NOT trust proxy-ca  (expect: refused before any push)"
echo "-- fetch with the system trust store only (no proxy-ca) --"
if GIT_TERMINAL_PROMPT=0 git -C "$SRC" ls-remote origin 2>&1 | sed 's/^/   git: /'; then
  echo "   !! UNEXPECTED: connection succeeded without trusting proxy-ca"
else
  echo "   => refused, as expected: the client leg is genuinely verified."
fi

hr "CONTROL B: reach the proxy by a name absent from its cert SAN (expect: refused)"
# proxy leaf SAN = IP:127.0.0.1, DNS:proxy.git.local -- 'localhost' is NOT in it,
# though it resolves to 127.0.0.1 and reaches the same proxy.
BADHOST="https://localhost:$PROXY_PORT/hello-world.git"
echo "-- ls-remote $BADHOST while trusting proxy-ca --"
if GIT_TERMINAL_PROMPT=0 git $CA -C "$SRC" ls-remote "$BADHOST" 2>&1 | sed 's/^/   git: /'; then
  echo "   !! UNEXPECTED: hostname mismatch was accepted"
else
  echo "   => refused, as expected: the cert must match the swapped host."
fi

hr "CONTROL C: proxy given the WRONG upstream CA (expect: 502, re-encrypt refused)"
kill "$PROXY_PID" 2>/dev/null || true
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null && { exec 3>&- 3<&-; sleep 0.1; } || break; done
start_proxy "$CERTS/proxy-ca.crt" "$WORK/proxy-badca.log"   # proxy-ca cannot verify the upstream leaf
echo "-- push again; proxy should fail to trust the upstream and 502 --"
if GIT_TERMINAL_PROMPT=0 git $CA -C "$SRC" push origin main --force 2>&1 | sed 's/^/   git: /'; then
  echo "   !! UNEXPECTED: push succeeded despite unverifiable upstream"
else
  echo "   => refused, as expected: the re-encrypt leg verifies the upstream too."
fi
echo "-- proxy log for the failed upstream leg: --"
sed 's/^/   /' "$WORK/proxy-badca.log"

hr "DONE"
