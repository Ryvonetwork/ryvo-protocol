#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLANA_BIN="${SOLANA_BIN:-$HOME/.local/share/solana/install/active_release/bin/solana}"
VALIDATOR_BIN="${VALIDATOR_BIN:-$HOME/.local/share/solana/install/active_release/bin/solana-test-validator}"
RPC_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
WALLET="${ANCHOR_WALLET_LINUX:-$REPO_ROOT/keys/devnet-deployer.json}"
PROGRAM_SO="${PROGRAM_SO:-$REPO_ROOT/target/deploy/agon_protocol.so}"
MOCK_YIELD_SO="${MOCK_YIELD_SO:-$REPO_ROOT/target/deploy/mock_yield.so}"
VALIDATOR_LOG="${VALIDATOR_LOG:-/tmp/agon-local-validator.log}"
PROGRAM_ADDRESS="${PROGRAM_ADDRESS:-$(grep -m1 'declare_id!' "$REPO_ROOT/programs/agon-protocol/src/lib.rs" | sed -E 's/.*"([^"]+)".*/\1/')}"
MOCK_YIELD_ADDRESS="${MOCK_YIELD_ADDRESS:-$(grep -m1 'declare_id!' "$REPO_ROOT/programs/mock-yield/src/lib.rs" | sed -E 's/.*"([^"]+)".*/\1/')}"

if [[ ! -x "$SOLANA_BIN" ]]; then
  echo "solana binary not found at $SOLANA_BIN" >&2
  exit 1
fi

if [[ ! -x "$VALIDATOR_BIN" ]]; then
  echo "solana-test-validator binary not found at $VALIDATOR_BIN" >&2
  exit 1
fi

if [[ ! -f "$WALLET" ]]; then
  echo "wallet not found at $WALLET" >&2
  exit 1
fi

if [[ ! -f "$PROGRAM_SO" ]]; then
  echo "program binary not found at $PROGRAM_SO" >&2
  exit 1
fi

if [[ ! -f "$MOCK_YIELD_SO" ]]; then
  echo "mock-yield binary not found at $MOCK_YIELD_SO" >&2
  exit 1
fi

pkill -f solana-test-validator >/dev/null 2>&1 || true
pkill -f solana-faucet >/dev/null 2>&1 || true
sleep 1
nohup "$VALIDATOR_BIN" \
  --reset \
  --upgradeable-program "$PROGRAM_ADDRESS" "$PROGRAM_SO" "$WALLET" \
  --upgradeable-program "$MOCK_YIELD_ADDRESS" "$MOCK_YIELD_SO" "$WALLET" \
  > "$VALIDATOR_LOG" 2>&1 &

READY=0
for _ in $(seq 1 30); do
  if "$SOLANA_BIN" -u "$RPC_URL" cluster-version >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo "local validator did not become ready; see $VALIDATOR_LOG" >&2
  exit 1
fi

"$SOLANA_BIN" -u "$RPC_URL" airdrop 20 "$WALLET" >/dev/null
"$SOLANA_BIN" config set --url "$RPC_URL" --keypair "$WALLET" >/dev/null

echo "local validator ready at $RPC_URL"
echo "wallet: $WALLET"
echo "validator log: $VALIDATOR_LOG"
