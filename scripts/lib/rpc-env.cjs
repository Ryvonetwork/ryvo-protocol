const fs = require("fs");
const path = require("path");

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex === -1) return null;

  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadProjectRpcEnv(repoRoot = process.cwd()) {
  const rpcEnvFile =
    process.env.RYVO_RPC_ENV_FILE ?? path.join(repoRoot, "config", "rpc.env");
  if (!fs.existsSync(rpcEnvFile)) return;

  const contents = fs.readFileSync(rpcEnvFile, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
  }
}

function resolveProjectRpcUrl(network = "devnet") {
  if (process.env.RYVO_RPC_URL) return process.env.RYVO_RPC_URL;
  if (process.env.ANCHOR_PROVIDER_URL) return process.env.ANCHOR_PROVIDER_URL;
  if (network === "mainnet" && process.env.RYVO_MAINNET_RPC_URL) {
    return process.env.RYVO_MAINNET_RPC_URL;
  }
  if (network === "devnet" && process.env.RYVO_DEVNET_RPC_URL) {
    return process.env.RYVO_DEVNET_RPC_URL;
  }
  return network === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";
}

module.exports = {
  loadProjectRpcEnv,
  resolveProjectRpcUrl,
};
