load_project_rpc_env() {
  local repo_root="$1"
  local rpc_env_file="${RYVO_RPC_ENV_FILE:-$repo_root/config/rpc.env}"

  if [[ -f "$rpc_env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$rpc_env_file"
    set +a
  fi
}

resolve_project_rpc_url() {
  local network="$1"

  if [[ -n "${RYVO_RPC_URL:-}" ]]; then
    printf '%s\n' "$RYVO_RPC_URL"
    return
  fi

  if [[ -n "${ANCHOR_PROVIDER_URL:-}" ]]; then
    printf '%s\n' "$ANCHOR_PROVIDER_URL"
    return
  fi

  if [[ "$network" == "mainnet" && -n "${RYVO_MAINNET_RPC_URL:-}" ]]; then
    printf '%s\n' "$RYVO_MAINNET_RPC_URL"
    return
  fi

  if [[ "$network" == "devnet" && -n "${RYVO_DEVNET_RPC_URL:-}" ]]; then
    printf '%s\n' "$RYVO_DEVNET_RPC_URL"
    return
  fi

  if [[ "$network" == "mainnet" ]]; then
    printf '%s\n' "https://api.mainnet-beta.solana.com"
  else
    printf '%s\n' "https://api.devnet.solana.com"
  fi
}
