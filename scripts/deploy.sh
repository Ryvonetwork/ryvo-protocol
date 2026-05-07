#!/bin/bash

set -e

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
      candidate="$(dirname "$latest_node")"
      if [[ ":$PATH:" != *":$candidate:"* ]]; then
        PATH="$candidate:$PATH"
      fi
    fi
  fi

  export PATH
}

bootstrap_tooling_path

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/lib/rpc-env.sh"
load_project_rpc_env "$REPO_ROOT"

require_command() {
  local command_name="$1"
  local install_hint="$2"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required deployment command: $command_name"
    echo "$install_hint"
    exit 1
  fi
}

require_deploy_tooling() {
  require_command "anchor" "Install Anchor CLI 0.32.x and make sure it is on PATH."
  require_command "cargo" "Install Rust/Cargo and source ~/.cargo/env before deploying."
  require_command "solana" "Install the Solana/Agave CLI and make sure solana is on PATH."
  require_command "solana-keygen" "Install the Solana/Agave CLI and make sure solana-keygen is on PATH."

  if ! cargo build-sbf --version >/dev/null 2>&1; then
    echo "Missing required deployment command: cargo build-sbf"
    echo "Install the Solana/Agave CLI toolchain so cargo-build-sbf is available on PATH."
    exit 1
  fi
}

find_agave_beta_solana_bin() {
  local candidate="$HOME/.local/share/agave-v4-beta/active_release/bin/solana"
  if [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
  fi
}

program_uses_bls_syscalls() {
  local program_path="$1"

  if [[ ! -f "$program_path" ]]; then
    return 1
  fi

  if command -v strings >/dev/null 2>&1 && strings "$program_path" | grep -q "sol_curve_decompress"; then
    return 0
  fi

  if command -v llvm-readelf >/dev/null 2>&1 && llvm-readelf -Ws "$program_path" 2>/dev/null | grep -q "sol_curve_decompress"; then
    return 0
  fi

  return 1
}

deploy_program_with_solana_cli() {
  local solana_bin="$1"
  local rpc_url="$2"
  local wallet_file="$3"
  local program_so="$4"
  local program_keypair="$5"
  local max_sign_attempts="${AGON_DEPLOY_MAX_SIGN_ATTEMPTS:-20}"
  local compute_unit_price="${AGON_DEPLOY_COMPUTE_UNIT_PRICE:-}"
  local skip_preflight="${AGON_DEPLOY_SKIP_PREFLIGHT:-0}"

  local deploy_args=(
    program deploy "$program_so"
    --program-id "$program_keypair"
    --keypair "$wallet_file"
    --fee-payer "$wallet_file"
    --upgrade-authority "$wallet_file"
    --url "$rpc_url"
    --use-rpc
    --skip-feature-verify
    --max-sign-attempts "$max_sign_attempts"
    --output json-compact
  )

  if [[ -n "$compute_unit_price" ]]; then
    deploy_args+=(--with-compute-unit-price "$compute_unit_price")
  fi

  if [[ "$skip_preflight" == "1" ]]; then
    deploy_args+=(--skip-preflight)
  fi

  echo "🧭 Using direct solana program deploy via: $solana_bin"
  "$solana_bin" --version

  "$solana_bin" "${deploy_args[@]}"
}

sync_anchor_program_ids() {
  local program_name="$1"
  local program_id="$2"
  local anchor_toml="Anchor.toml"

  for cluster in devnet localnet mainnet; do
    sed -i "/^\[programs\.$cluster\]$/,/^\[/ { s/^${program_name} = \".*\"$/${program_name} = \"$program_id\"/ }" "$anchor_toml"
  done
}

ensure_mock_yield_keypair() {
  if [[ ! -f "target/deploy/mock_yield-keypair.json" ]]; then
    mkdir -p target/deploy
    echo "🔑 Generating mock_yield program keypair (target/deploy/mock_yield-keypair.json)..."
    solana-keygen new --no-bip39-passphrase -o target/deploy/mock_yield-keypair.json -f >/dev/null
    local mock_yield_id
    mock_yield_id="$(solana address -k target/deploy/mock_yield-keypair.json)"
    sync_anchor_program_ids "mock_yield" "$mock_yield_id"
    # Update declare_id! in src/lib.rs so on-chain id matches the keypair.
    if [[ -f "programs/mock-yield/src/lib.rs" ]]; then
      sed -i "s|^declare_id!(\"[^\"]*\");|declare_id!(\"$mock_yield_id\");|" programs/mock-yield/src/lib.rs
    fi
    echo "📋 mock_yield program id: $mock_yield_id"
  fi
}

# Default network
NETWORK="devnet"
FRESH_PROGRAM_ID="false"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --network=*)
      NETWORK="${1#*=}"
      shift
      ;;
    --network)
      NETWORK="$2"
      shift 2
      ;;
    --fresh-program-id)
      FRESH_PROGRAM_ID="true"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--network=devnet|mainnet] [--fresh-program-id]"
      exit 1
      ;;
  esac
done

# Validate network
if [[ "$NETWORK" != "devnet" && "$NETWORK" != "mainnet" ]]; then
  echo "❌ Invalid network: $NETWORK"
  echo "Supported networks: devnet, mainnet"
  exit 1
fi

require_deploy_tooling

# Setup wallet using the setup-wallet.sh script
echo "🔑 Setting up wallet..."
if [[ ! -d "keys" ]]; then
  mkdir -p keys
fi

bash ./scripts/setup-wallet.sh $NETWORK
if [[ $? -ne 0 ]]; then
  echo "❌ Failed to setup wallet."
  exit 1
fi

# Set the wallet path for this deployment
WALLET_FILE="keys/${NETWORK}-deployer.json"
if [[ ! -f "$WALLET_FILE" ]]; then
  echo "❌ Wallet file $WALLET_FILE not found."
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "❌ Node.js is required but was not found in PATH."
  exit 1
fi

echo "🚀 Starting Agon Protocol deployment to $NETWORK..."
RPC_URL="$(resolve_project_rpc_url "$NETWORK")"

if [[ "$FRESH_PROGRAM_ID" == "true" ]]; then
  echo "🆕 Generating a fresh agon_protocol program id to avoid stale onchain state..."
  mkdir -p target/deploy
  solana-keygen new --no-bip39-passphrase -o target/deploy/agon_protocol-keypair.json -f >/dev/null
  # Mock-yield is brand-new in v6; rotate its id alongside agon_protocol when --fresh-program-id is set.
  echo "🆕 Generating a fresh mock_yield program id..."
  solana-keygen new --no-bip39-passphrase -o target/deploy/mock_yield-keypair.json -f >/dev/null
  anchor keys sync >/dev/null
  FRESH_PROGRAM_ID_VALUE="$(solana address -k target/deploy/agon_protocol-keypair.json)"
  FRESH_MOCK_YIELD_ID_VALUE="$(solana address -k target/deploy/mock_yield-keypair.json)"
  sync_anchor_program_ids "agon_protocol" "$FRESH_PROGRAM_ID_VALUE"
  sync_anchor_program_ids "mock_yield" "$FRESH_MOCK_YIELD_ID_VALUE"
  if [[ -f "programs/mock-yield/src/lib.rs" ]]; then
    sed -i "s|^declare_id!(\"[^\"]*\");|declare_id!(\"$FRESH_MOCK_YIELD_ID_VALUE\");|" programs/mock-yield/src/lib.rs
  fi
  echo "📋 Fresh agon_protocol id: $FRESH_PROGRAM_ID_VALUE"
  echo "📋 Fresh mock_yield   id: $FRESH_MOCK_YIELD_ID_VALUE"
else
  ensure_mock_yield_keypair
fi

# Step 0: Check wallet balance and provide funding instructions
echo "💰 Checking wallet balance..."
if [[ "$NETWORK" == "devnet" ]]; then
  BALANCE=$(solana balance "$WALLET_FILE" --url "$RPC_URL" --keypair "$WALLET_FILE" 2>/dev/null | grep -oP '\d+\.\d+' || echo "0")
  echo "Current balance: $BALANCE SOL"
  if (( $(echo "$BALANCE < 2" | bc -l 2>/dev/null || echo "1") )); then
    echo "⚠️  Insufficient funds for deployment. You need at least 2 SOL."
    echo "🪂 To get devnet SOL, visit: https://faucet.solana.com/"
    echo "   Or run: solana airdrop 2 --url $RPC_URL --keypair $WALLET_FILE"
    echo "   (Note: Devnet airdrops may be rate-limited)"
    echo ""
    read -p "Press Enter after funding your wallet to continue..."
  fi
elif [[ "$NETWORK" == "mainnet" ]]; then
  echo "⚠️  WARNING: Make sure your wallet has sufficient SOL for mainnet deployment!"
  echo "💰 Check your balance: solana balance $WALLET_FILE --url $RPC_URL --keypair $WALLET_FILE"
  echo "   You need ~2-3 SOL for deployment + initialization."
  read -p "Press Enter to continue with mainnet deployment..."
fi

# Step 1: Run verification
echo "🔍 Running verification..."
cargo fmt --all
cargo clippy --lib --features no-entrypoint -- -D warnings
anchor build -- --features custom-heap

# Step 2: Deploy to specified network
echo "📦 Deploying to $NETWORK..."
PROGRAM_SO="target/deploy/agon_protocol.so"
PROGRAM_KEYPAIR="target/deploy/agon_protocol-keypair.json"
MOCK_YIELD_SO="target/deploy/mock_yield.so"
MOCK_YIELD_KEYPAIR="target/deploy/mock_yield-keypair.json"
AGAVE_SOLANA_BIN="$(find_agave_beta_solana_bin || true)"

USE_DIRECT_SOLANA_DEPLOY="${AGON_DEPLOY_WITH_SOLANA_CLI:-0}"
if [[ "$USE_DIRECT_SOLANA_DEPLOY" != "1" && "$NETWORK" == "devnet" && -n "$AGAVE_SOLANA_BIN" ]]; then
  if program_uses_bls_syscalls "$PROGRAM_SO"; then
    USE_DIRECT_SOLANA_DEPLOY="1"
    echo "🧪 Detected BLS syscalls in $PROGRAM_SO, switching to direct Agave beta deploy."
  fi
fi

if [[ "$USE_DIRECT_SOLANA_DEPLOY" == "1" ]]; then
  if [[ -z "$AGAVE_SOLANA_BIN" ]]; then
    echo "❌ AGON_DEPLOY_WITH_SOLANA_CLI=1 but Agave beta solana binary was not found."
    exit 1
  fi
  echo "📦 Deploying agon_protocol..."
  deploy_program_with_solana_cli "$AGAVE_SOLANA_BIN" "$RPC_URL" "$WALLET_FILE" "$PROGRAM_SO" "$PROGRAM_KEYPAIR"
  if [[ -f "$MOCK_YIELD_SO" ]]; then
    echo "📦 Deploying mock_yield..."
    deploy_program_with_solana_cli "$AGAVE_SOLANA_BIN" "$RPC_URL" "$WALLET_FILE" "$MOCK_YIELD_SO" "$MOCK_YIELD_KEYPAIR"
  fi
elif [[ "$NETWORK" == "devnet" ]]; then
  ANCHOR_PROVIDER_URL="$RPC_URL" anchor deploy --provider.cluster devnet --provider.wallet "$WALLET_FILE"
elif [[ "$NETWORK" == "mainnet" ]]; then
  ANCHOR_PROVIDER_URL="$RPC_URL" anchor deploy --provider.cluster mainnet-beta --provider.wallet "$WALLET_FILE"
fi

# Step 3: Initialize the program and capture config
echo "⚙️  Initializing program..."
INIT_ARGS=()
if [[ -n "${AGON_ALLOWLIST_TOKENS:-}" ]]; then
  echo "🪙 Passing AGON_ALLOWLIST_TOKENS to initializer"
  INIT_ARGS+=(--allowlisted-tokens-json "$AGON_ALLOWLIST_TOKENS")
fi
if [[ -n "${AGON_FEE_RECIPIENT:-}" ]]; then
  echo "💼 Passing AGON_FEE_RECIPIENT to initializer"
  INIT_ARGS+=(--fee-recipient "$AGON_FEE_RECIPIENT")
fi
if [[ -n "${AGON_INITIAL_AUTHORITY:-}" ]]; then
  echo "🛡️ Passing AGON_INITIAL_AUTHORITY to initializer"
  INIT_ARGS+=(--initial-authority "$AGON_INITIAL_AUTHORITY")
fi
if [[ "$NETWORK" == "devnet" ]]; then
  CONFIG_OUTPUT=$(env ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_FILE" "$NODE_BIN" node_modules/ts-node/dist/bin.js scripts/initialize-program.ts "${INIT_ARGS[@]}" 2>&1)
elif [[ "$NETWORK" == "mainnet" ]]; then
  CONFIG_OUTPUT=$(env ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_FILE" "$NODE_BIN" node_modules/ts-node/dist/bin.js scripts/initialize-program.ts "${INIT_ARGS[@]}" 2>&1)
fi

echo "$CONFIG_OUTPUT"

# Extract JSON config from output (find the JSON object)
CONFIG_JSON=$(echo "$CONFIG_OUTPUT" | sed -n '/^{/,/^}/p')

if [[ -n "${AGON_ALLOWLIST_TOKENS:-}" ]]; then
  if [[ -z "$CONFIG_JSON" || "$CONFIG_JSON" == "{}" ]]; then
    echo "❌ Initializer did not emit deployment JSON, so the requested token allowlist could not be verified."
    exit 1
  fi

  if ! CONFIG_JSON="$CONFIG_JSON" AGON_ALLOWLIST_TOKENS="$AGON_ALLOWLIST_TOKENS" "$NODE_BIN" - <<'NODE'
const config = JSON.parse(process.env.CONFIG_JSON ?? "{}");
const requested = JSON.parse(process.env.AGON_ALLOWLIST_TOKENS ?? "[]");
const actualIds = new Set((config.tokens ?? []).map((token) => token.id));
const missing = requested.filter((token) => !actualIds.has(token.id));

if (missing.length > 0) {
  console.error(
    `❌ Initializer completed without registering requested token ids: ${missing
      .map((token) => token.id)
      .join(", ")}`
  );
  process.exit(1);
}
NODE
  then
    exit 1
  fi
fi

if [[ -n "$CONFIG_JSON" && "$CONFIG_JSON" != "{}" ]]; then
  # Create config directory if it doesn't exist
  mkdir -p config

  # Save deployment config
  CONFIG_FILE="config/${NETWORK}-deployment.json"
  echo "$CONFIG_JSON" > "$CONFIG_FILE"
  echo "💾 Deployment config saved to: $CONFIG_FILE"
fi

# Step 4: Bootstrap v6 yield-bearing setup (mock-yield Reserve + agUSDC TokenEntry).
# Idempotent — safe to run on every deploy.
if [[ "${AGON_SKIP_YIELD_BOOTSTRAP:-0}" != "1" ]]; then
  echo "🌱 Bootstrapping yield-bearing setup (mock-yield Reserve + agUSDC TokenEntry)..."
  BOOTSTRAP_ARGS=(--bootstrap-only --network "$NETWORK")
  if [[ -n "${AGON_USDC_MINT:-}" ]]; then
    BOOTSTRAP_ARGS+=(--usdc-mint "$AGON_USDC_MINT")
  fi
  if [[ -n "${AGON_FEE_RECIPIENT:-}" ]]; then
    BOOTSTRAP_ARGS+=(--fee-recipient "$AGON_FEE_RECIPIENT")
  fi
  env ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_FILE" \
    "$NODE_BIN" node_modules/ts-node/dist/bin.js scripts/yield-bearing-demo.ts "${BOOTSTRAP_ARGS[@]}" || {
      echo "❌ Yield-bearing bootstrap failed."
      echo "   You can re-run it manually with:"
      echo "     yarn ts-node scripts/bootstrap-yield-bearing.ts --network $NETWORK"
      exit 1
    }
  echo "✅ Yield-bearing setup ready."
else
  echo "⏭️  Skipping yield-bearing bootstrap (AGON_SKIP_YIELD_BOOTSTRAP=1)."
fi

echo "🎉 Deployment, initialization, and yield-bearing bootstrap complete!"
echo "🌐 Network: $NETWORK"
echo "📋 agon_protocol id: $(solana address -k target/deploy/agon_protocol-keypair.json)"
if [[ -f "target/deploy/mock_yield-keypair.json" ]]; then
  echo "📋 mock_yield   id: $(solana address -k target/deploy/mock_yield-keypair.json)"
fi

if [[ -f "config/${NETWORK}-deployment.json" ]]; then
  echo "📄 Config file: config/${NETWORK}-deployment.json"
fi
