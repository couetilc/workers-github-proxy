#!/bin/sh
# .agent/init.sh — project bootstrap, run INSIDE the container after the clone.
#
# USER-OWNED: `agent init` writes this once and never overwrites it. It runs as
# the non-root `node` user, so it CANNOT `apt install` — root/system deps belong
# in a `.agent/Dockerfile` overlay instead (see .agent/README.md). This is for
# user-space, repo-dependent setup that needs the clone to exist: installing
# dependencies, syncing tool caches, generating files.
#
# A failure here warns loudly but does NOT block the session — the agent inside
# can diagnose. This template is a no-op; uncomment or add what your repo needs.
#
# This runs on the launch critical path — every second here delays the agent
# session (issue #8). For npm: --prefer-offline trusts the shared npm cache
# volume (the lockfile pins exact versions, so a cache hit is byte-identical);
# --no-audit --no-fund skip two network round-trips. And `npm ci` already runs
# a `prepare` script if package.json has one — don't repeat its build here.
#
# Examples:
#   # (cd astro && npm ci --prefer-offline --no-audit --no-fund)
#   # npm ci --prefer-offline --no-audit --no-fund
#   # uv sync
