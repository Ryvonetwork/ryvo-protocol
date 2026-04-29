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

  export PATH
}

bootstrap_tooling_path

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/lib/rpc-env.sh"
load_project_rpc_env "$REPO_ROOT"
cd "$REPO_ROOT"

NETWORK="devnet"
FRESH_PROGRAM_ID="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network=*)
      NETWORK="${1#*=}"
      shift
      ;;
    --network)
      NETWORK="${2:-}"
      shift 2
      ;;
    --fresh-program-id)
      FRESH_PROGRAM_ID="1"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--network devnet|mainnet] [--fresh-program-id]"
      exit 1
      ;;
  esac
done

if [[ "$NETWORK" != "devnet" && "$NETWORK" != "mainnet" ]]; then
  echo "Unsupported network: $NETWORK"
  exit 1
fi

SOLANA_BIN="${AGON_SOLANA_BIN:-$HOME/.local/share/agave-v4-beta/active_release/bin/solana}"
SOLANA_KEYGEN_BIN="${AGON_SOLANA_KEYGEN_BIN:-$HOME/.local/share/agave-v4-beta/active_release/bin/solana-keygen}"
RPC_URL="$(resolve_project_rpc_url "$NETWORK")"

PROGRAM_SO="target/deploy/agon_protocol.so"
PROGRAM_KEYPAIR="target/deploy/agon_protocol-keypair.json"
WALLET_FILE="keys/${NETWORK}-deployer.json"
LOG_ROOT="${AGON_DEPLOY_LOG_ROOT:-$REPO_ROOT/logs/deploys}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$LOG_ROOT/${NETWORK}-${TIMESTAMP}"
RUN_LOG="$RUN_DIR/deploy.log"
SUMMARY_FILE="$RUN_DIR/summary.txt"
BUFFERS_BEFORE="$RUN_DIR/buffers-before.txt"
BUFFERS_AFTER="$RUN_DIR/buffers-after.txt"
BALANCE_BEFORE_FILE="$RUN_DIR/balance-before.txt"
BALANCE_AFTER_FILE="$RUN_DIR/balance-after.txt"

mkdir -p "$RUN_DIR"

if [[ ! -x "$SOLANA_BIN" ]]; then
  echo "solana binary not found at $SOLANA_BIN"
  exit 1
fi

if [[ ! -x "$SOLANA_KEYGEN_BIN" ]]; then
  echo "solana-keygen binary not found at $SOLANA_KEYGEN_BIN"
  exit 1
fi

if [[ ! -f "$PROGRAM_SO" ]]; then
  echo "Program binary not found at $PROGRAM_SO"
  exit 1
fi

if [[ ! -f "$WALLET_FILE" ]]; then
  echo "Wallet file not found at $WALLET_FILE"
  exit 1
fi

sync_anchor_program_ids() {
  local program_id="$1"
  local anchor_toml="Anchor.toml"

  for cluster in devnet localnet mainnet; do
    sed -i "/^\[programs\.$cluster\]$/{
      n
      s/^agon_protocol = \".*\"$/agon_protocol = \"$program_id\"/
    }" "$anchor_toml"
  done
}

dump_buffers() {
  local output_file="$1"
  {
    echo "# $(date -Iseconds) buffers for $NETWORK"
    "$SOLANA_BIN" program show --buffers --url "$RPC_URL" 2>&1 || true
  } >"$output_file"
}

dump_balance() {
  local output_file="$1"
  {
    echo "# $(date -Iseconds) deployer balance for $NETWORK"
    "$SOLANA_BIN" balance "$WALLET_FILE" --url "$RPC_URL" --keypair "$WALLET_FILE" 2>&1 || true
  } >"$output_file"
}

RUN_STATUS="FAILED"
DEPLOY_EXIT_CODE=1

on_exit() {
  DEPLOY_EXIT_CODE=$?
  if [[ $DEPLOY_EXIT_CODE -eq 0 ]]; then
    RUN_STATUS="SUCCESS"
  fi

  dump_balance "$BALANCE_AFTER_FILE"
  dump_buffers "$BUFFERS_AFTER"

  {
    echo "timestamp=$TIMESTAMP"
    echo "status=$RUN_STATUS"
    echo "exit_code=$DEPLOY_EXIT_CODE"
    echo "network=$NETWORK"
    echo "rpc_url=$RPC_URL"
    echo "solana_bin=$SOLANA_BIN"
    echo "program_so=$PROGRAM_SO"
    echo "program_keypair=$PROGRAM_KEYPAIR"
    echo "program_id=$PROGRAM_ID"
    echo "wallet_file=$WALLET_FILE"
    echo "wallet_pubkey=$WALLET_PUBKEY"
    echo "run_log=$RUN_LOG"
    echo "balance_before_file=$BALANCE_BEFORE_FILE"
    echo "balance_after_file=$BALANCE_AFTER_FILE"
    echo "buffers_before_file=$BUFFERS_BEFORE"
    echo "buffers_after_file=$BUFFERS_AFTER"
    echo "recover_buffers_command=$SOLANA_BIN program close --buffers --authority $WALLET_FILE --keypair $WALLET_FILE --recipient $WALLET_FILE --url $RPC_URL"
  } >"$SUMMARY_FILE"

  echo
  echo "Deploy artifacts saved to: $RUN_DIR"
  echo "Summary: $SUMMARY_FILE"
  echo "Log: $RUN_LOG"
  echo "Status: $RUN_STATUS"
}

trap on_exit EXIT

if [[ "$FRESH_PROGRAM_ID" == "1" ]]; then
  echo "Generating fresh program id..."
  mkdir -p target/deploy
  "$SOLANA_KEYGEN_BIN" new --no-bip39-passphrase -o "$PROGRAM_KEYPAIR" -f >/dev/null
  anchor keys sync >/dev/null
  FRESH_PROGRAM_ID_VALUE="$("$SOLANA_BIN" address -k "$PROGRAM_KEYPAIR")"
  sync_anchor_program_ids "$FRESH_PROGRAM_ID_VALUE"
fi

PROGRAM_ID="$("$SOLANA_BIN" address -k "$PROGRAM_KEYPAIR")"
WALLET_PUBKEY="$("$SOLANA_KEYGEN_BIN" pubkey "$WALLET_FILE")"

dump_balance "$BALANCE_BEFORE_FILE"
dump_buffers "$BUFFERS_BEFORE"

{
  echo "# $(date -Iseconds) deploy start"
  echo "network=$NETWORK"
  echo "rpc_url=$RPC_URL"
  echo "program_id=$PROGRAM_ID"
  echo "wallet_pubkey=$WALLET_PUBKEY"
  echo "program_so=$PROGRAM_SO"
  echo "program_keypair=$PROGRAM_KEYPAIR"
  echo "wallet_file=$WALLET_FILE"
  echo "---"
  "$SOLANA_BIN" --version
  echo "---"
  "$SOLANA_BIN" program deploy \
    "$PROGRAM_SO" \
    --program-id "$PROGRAM_KEYPAIR" \
    --keypair "$WALLET_FILE" \
    --fee-payer "$WALLET_FILE" \
    --upgrade-authority "$WALLET_FILE" \
    --url "$RPC_URL" \
    --skip-feature-verify
} 2>&1 | tee "$RUN_LOG"
