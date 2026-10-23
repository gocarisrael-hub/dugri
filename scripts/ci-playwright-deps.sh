#!/usr/bin/env bash
# CI only (.github/workflows/ci.yml, E2E job): install the system libraries
# Playwright's Chromium and WebKit need, without letting one slow apt mirror
# eat the job's 20-minute cap.
#
# The libraries are ~180 packages, ~119 MB, from the runner's apt mirror
# (azure.archive.ubuntu.com). Healthy, this takes about 30 seconds. On #737 one
# shard drew a mirror serving ~45 KB/s on three runs in a row; install-deps sat
# there until the job cap cancelled it, before a single test had run. The
# browser cache does not help: it holds the browsers, not these libraries.
#
# So:
#  1. The .debs go to a runner-owned directory that ci.yml caches between runs.
#     On a cache hit apt only fetches its index and installs from disk.
#  2. Each attempt is capped, and a stalled first attempt is retried once with
#     the Azure mirror swapped for archive.ubuntu.com.
#  3. Two failed attempts fail the step with an error saying so, at about
#     eight minutes rather than twenty, so the job cap still bounds the tests.
#
# The knobs are environment variables so tests/unit/ci-playwright-deps.test.js
# can drive the retry path with stub commands.
set -uo pipefail

ATTEMPT_SECS="${PW_DEPS_ATTEMPT_SECS:-240}"
FIRST_ATTEMPT_SECS="${PW_DEPS_FIRST_ATTEMPT_SECS:-$ATTEMPT_SECS}"
MIRRORS="${APT_MIRRORS_FILE:-/etc/apt/apt-mirrors.txt}"
APT_CONF="${APT_CONF_FILE:-/etc/apt/apt.conf.d/90-playwright-debs}"
DEBS="${APT_DEBS_DIR:-$HOME/apt-debs}"

mkdir -p "$DEBS/partial"
printf 'Dir::Cache::Archives "%s/";\nAPT::Keep-Downloaded-Packages "true";\n' "$DEBS" |
  sudo tee "$APT_CONF" >/dev/null
echo "Cached .debs before install: $(find "$DEBS" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' ')"

# As root, so `timeout` can stop apt-get itself (it signals its whole process
# group; a runner-user timeout could not signal root's apt). PATH is passed
# through because sudo's secure_path does not have setup-node's npx.
attempt() {
  sudo env "PATH=$PATH" timeout -k 15 "$1" npx playwright install-deps chromium webkit
}

started=$SECONDS
if ! attempt "$FIRST_ATTEMPT_SECS"; then
  echo "::warning::playwright install-deps attempt 1 failed after $((SECONDS - started))s; retrying once on archive.ubuntu.com"
  if [ -f "$MIRRORS" ]; then
    sudo sed -i.bak 's/azure\.archive\.ubuntu\.com/archive.ubuntu.com/g' "$MIRRORS"
    cat "$MIRRORS"
  fi
  # A kill during unpacking leaves dpkg half-configured, and the retry would
  # refuse to start until it is repaired.
  sudo dpkg --configure -a || true
  started=$SECONDS
  if ! attempt "$ATTEMPT_SECS"; then
    echo "::error::playwright install-deps failed twice (second attempt $((SECONDS - started))s); the apt mirrors are slow or down. Re-run the job."
    exit 1
  fi
fi

# Drop .debs no mirror offers any more, then hand the directory to the runner
# user: apt leaves root-only files in it (its lock) that actions/cache could not
# read when it saves.
sudo apt-get -qq autoclean || true
sudo chown -R "$(id -u):$(id -g)" "$DEBS"
echo "Cached .debs after install: $(find "$DEBS" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' ')"
