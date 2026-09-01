#!/usr/bin/env bash
# Generate the PKI for the TLS-terminate-and-re-encrypt experiment.
#
# We model TWO INDEPENDENT trust domains, exactly as production would have them:
#
#   * proxy-ca  -> signs the PROXY's leaf cert. This is the CA a git client
#                  trusts for the swapped remote host (in prod: whoever issues
#                  git.cloud's cert). The client verifies the *client leg*
#                  (git -> proxy) against this CA.
#   * upstream-ca -> signs the UPSTREAM's leaf cert. This is the CA the PROXY
#                  trusts for the real service (in prod: the public CA behind
#                  github.com). The proxy verifies the *upstream leg*
#                  (proxy -> upstream) against this CA when it re-encrypts.
#
# The two legs authenticate against different roots on purpose: it shows the
# proxy re-establishes a fresh, independently verified TLS session upstream
# rather than tunnelling the client's.
#
# SANs are chosen so the experiment can also run NEGATIVE controls without root
# or /etc/hosts edits:
#   proxy leaf  SAN = IP:127.0.0.1, DNS:proxy.git.local   (NOTE: no "localhost")
#   upstream leaf SAN = DNS:localhost, IP:127.0.0.1
# Because "localhost" is absent from the proxy SAN but still resolves to
# 127.0.0.1, connecting to the proxy as https://localhost:PORT yields a genuine
# hostname-mismatch failure -> the "cert must match the swapped domain" control.
#
# Usage: gen-certs.sh <out-dir>
set -euo pipefail

OUT="${1:?usage: gen-certs.sh <out-dir>}"
mkdir -p "$OUT"
cd "$OUT"

DAYS=3650
KEYALG="-newkey ec -pkeyopt ec_paramgen_curve:prime256v1"

make_ca() { # name  common-name
  local name="$1" cn="$2"
  openssl req -x509 -nodes -days "$DAYS" $KEYALG \
    -keyout "${name}.key" -out "${name}.crt" \
    -subj "/CN=${cn}" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
}

make_leaf() { # name  ca  common-name  san
  local name="$1" ca="$2" cn="$3" san="$4"
  openssl req -nodes $KEYALG -keyout "${name}.key" -out "${name}.csr" \
    -subj "/CN=${cn}" >/dev/null 2>&1
  openssl x509 -req -days "$DAYS" \
    -in "${name}.csr" \
    -CA "${ca}.crt" -CAkey "${ca}.key" -CAcreateserial \
    -extfile <(printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$san") \
    -out "${name}.crt" >/dev/null 2>&1
  rm -f "${name}.csr"
}

make_ca   proxy-ca    "Proxy Local Root CA"
make_ca   upstream-ca "Upstream Local Root CA"

make_leaf proxy    proxy-ca    "proxy.git.local" "IP:127.0.0.1,DNS:proxy.git.local"
make_leaf upstream upstream-ca "localhost"       "DNS:localhost,IP:127.0.0.1"

echo "PKI written to $OUT:"
for f in proxy-ca.crt upstream-ca.crt proxy.crt proxy.key upstream.crt upstream.key; do
  printf '  %s\n' "$f"
done
