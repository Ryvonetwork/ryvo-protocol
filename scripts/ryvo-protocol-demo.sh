#!/bin/bash

set -euo pipefail

bootstrap_tooling_path() {
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    source "$HOME/.cargo/env"
  fi

  local candidate
  for candidate in \
    "$HOME/.local/share/agave-v4-beta/active_release/bin" \
    "$HOME/.local/share/solana/install/active_release/bin" \
    "$HOME/.local/share/solana/install/releases/"*/solana-release/bin
  do
    if [[ -d "$candidate" && ":$PATH:" != *":$candidate:"* ]]; then
      PATH="$candidate:$PATH"
    fi
  done

  if ! command -v node >/dev/null 2>&1; then
    local latest_node
    latest_node=$(find "$HOME/.nvm/versions/node" -maxdepth 3 -type f -name node 2>/dev/null | sort -V | tail -1 || true)
    if [[ -n "$latest_node" ]]; then
      PATH="$(dirname "$latest_node"):$PATH"
    fi
  fi

  export PATH
}

bootstrap_tooling_path

NETWORK="devnet"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/lib/rpc-env.sh"
load_project_rpc_env "$REPO_ROOT"
CONFIG_FILE="${RYVO_DEMO_CONFIG_FILE:-$REPO_ROOT/config/ryvo-protocol-demo.env}"
LOG_DIR="$REPO_ROOT/config"
LOG_FILE="$LOG_DIR/ryvo-protocol-demo-last-run.log"
NODE_BIN="$(command -v node || true)"

mkdir -p "$LOG_DIR"

declare -A PRESERVED_DEMO_ENV=()
while IFS= read -r var_name; do
  PRESERVED_DEMO_ENV["$var_name"]="${!var_name}"
done < <(compgen -A variable RYVO_DEMO_ || true)

if [[ -f "$CONFIG_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
  for var_name in "${!PRESERVED_DEMO_ENV[@]}"; do
    export "$var_name=${PRESERVED_DEMO_ENV[$var_name]}"
  done
fi

RPC_URL="$(resolve_project_rpc_url "$NETWORK")"

TOKEN_ID="${RYVO_DEMO_TOKEN_ID:-1}"
TOKEN_MINT="${RYVO_DEMO_MINT:-Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr}"
TOKEN_SYMBOL="${RYVO_DEMO_SYMBOL:-USDC}"
WALLET_COUNT="${RYVO_DEMO_WALLET_COUNT:-32}"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is required but was not found in PATH."
  exit 1
fi

export RYVO_ALLOWLIST_TOKENS="[{\"id\":$TOKEN_ID,\"mint\":\"$TOKEN_MINT\",\"symbol\":\"$TOKEN_SYMBOL\"}]"
export RYVO_DEPLOY_WITH_SOLANA_CLI="${RYVO_DEPLOY_WITH_SOLANA_CLI:-1}"

cd "$REPO_ROOT"

{
  echo "[$(date -Iseconds)] Starting Ryvo Network demo on $NETWORK"
  echo "[$(date -Iseconds)] RPC URL: $RPC_URL"
  echo "[$(date -Iseconds)] Config file: $CONFIG_FILE"
  echo "[$(date -Iseconds)] Allowlisted token: $TOKEN_SYMBOL ($TOKEN_ID) $TOKEN_MINT"
  echo "[$(date -Iseconds)] Wallet count: $WALLET_COUNT"
  if [[ "${RYVO_DEMO_SKIP_DEPLOY:-0}" == "1" ]]; then
    echo "[$(date -Iseconds)] Skipping deploy and reusing current on-chain program state"
  else
    DEPLOY_ENV=("RYVO_ALLOWLIST_TOKENS=$RYVO_ALLOWLIST_TOKENS")
    DEPLOY_ENV+=("RYVO_DEPLOY_WITH_SOLANA_CLI=$RYVO_DEPLOY_WITH_SOLANA_CLI")
    DEPLOY_ENV+=("RYVO_RPC_URL=$RPC_URL")
    DEPLOY_ARGS=(--network="$NETWORK")
    if [[ "${RYVO_DEMO_FRESH_PROGRAM_ID:-0}" == "1" ]]; then
      DEPLOY_ARGS+=(--fresh-program-id)
    fi
    if [[ -n "${RYVO_FEE_RECIPIENT:-}" ]]; then
      DEPLOY_ENV+=("RYVO_FEE_RECIPIENT=$RYVO_FEE_RECIPIENT")
    fi
    env "${DEPLOY_ENV[@]}" bash ./scripts/deploy.sh "${DEPLOY_ARGS[@]}"
  fi

  export ANCHOR_PROVIDER_URL="$RPC_URL"
  export ANCHOR_WALLET="$REPO_ROOT/keys/${NETWORK}-deployer.json"
  export RYVO_FORCE_BIGINT_BUFFER_BROWSER=1
  export NODE_OPTIONS="--require $REPO_ROOT/scripts/test-runtime-setup.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}"

  "$NODE_BIN" node_modules/ts-node/dist/bin.js scripts/ryvo-protocol-demo.ts \
    --config-file "$CONFIG_FILE" \
    --wallet-count "$WALLET_COUNT" \
    --token-id "$TOKEN_ID" \
    --mint "$TOKEN_MINT" \
    --symbol "$TOKEN_SYMBOL"
} 2>&1 | tee "$LOG_FILE"
