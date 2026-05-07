#!/usr/bin/env ts-node

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { RyvoProtocol } from "../target/types/ryvo_protocol";

const { loadProjectRpcEnv, resolveProjectRpcUrl } = require("./lib/rpc-env.cjs") as {
  loadProjectRpcEnv: (repoRoot?: string) => void;
  resolveProjectRpcUrl: (network?: string) => string;
};

loadProjectRpcEnv(process.cwd());

const TOKEN_REGISTRY_SEED = "token-registry";
const GLOBAL_CONFIG_SEED = "global-config";
const VAULT_TOKEN_ACCOUNT_SEED = "vault-token-account";
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const MESSAGE_DOMAIN_TAG = Buffer.from("ryvo-message-domain-v1", "utf8");

type SupportedNetwork = "devnet" | "mainnet" | "testnet" | "localnet";

interface AllowlistedTokenInput {
  id: number;
  mint: string;
  symbol: string;
}

interface DeploymentToken {
  id: number;
  mint: string;
  symbol: string;
  decimals: number;
  vault: string;
  feeRecipientTokenAccount: string;
}

interface DeploymentConfig {
  programId: string;
  network: string;
  chainId: number;
  messageDomain: string;
  deployer: string;
  authority: string;
  feeRecipient: string;
  feeBps: number;
  registrationFeeLamports: number;
  withdrawalTimelockSeconds: number;
  channelUnlockTimelockSeconds: number | null;
  tokens: DeploymentToken[];
  deployedAt: string;
}

type CliOptions = {
  allowlistedTokensJson?: string;
  feeRecipient?: string;
  initialAuthority?: string;
};

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) continue;

    const trimmed = value.slice(2);
    const eqIndex = trimmed.indexOf("=");
    let key = trimmed;
    let parsedValue: string | undefined;

    if (eqIndex >= 0) {
      key = trimmed.slice(0, eqIndex);
      parsedValue = trimmed.slice(eqIndex + 1);
    } else {
      parsedValue = argv[i + 1];
      if (parsedValue && !parsedValue.startsWith("--")) {
        i += 1;
      } else {
        parsedValue = undefined;
      }
    }

    if (key === "allowlisted-tokens-json" && parsedValue !== undefined) {
      options.allowlistedTokensJson = parsedValue;
    }
    if (key === "fee-recipient" && parsedValue !== undefined) {
      options.feeRecipient = parsedValue;
    }
    if (key === "initial-authority" && parsedValue !== undefined) {
      options.initialAuthority = parsedValue;
    }
  }

  return options;
}

function loadProgram(provider: anchor.AnchorProvider): Program<RyvoProtocol> {
  const idlPath = path.join(
    __dirname,
    "..",
    "target",
    "idl",
    "ryvo_protocol.json"
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const resolvedProgramId = resolveProgramId(provider, idl);
  return new Program(
    { ...idl, address: resolvedProgramId.toString() } as RyvoProtocol,
    provider
  );
}

function resolveProgramId(
  provider: anchor.AnchorProvider,
  idl: { address?: string }
): PublicKey {
  const fromEnv = process.env.RYVO_PROGRAM_ID?.trim();
  if (fromEnv) {
    return new PublicKey(fromEnv);
  }

  const anchorTomlPath = path.join(__dirname, "..", "Anchor.toml");
  if (fs.existsSync(anchorTomlPath)) {
    const network = inferNetwork(provider.connection.rpcEndpoint);
    const sectionHeader = `[programs.${network}]`;
    let inSection = false;
    for (const line of fs.readFileSync(anchorTomlPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        inSection = trimmed === sectionHeader;
        continue;
      }
      if (!inSection) continue;
      const match = trimmed.match(/^ryvo_protocol\s*=\s*"([^"]+)"$/);
      if (match) {
        return new PublicKey(match[1]);
      }
    }
  }

  if (idl.address) {
    return new PublicKey(idl.address);
  }

  throw new Error(
    "Unable to resolve program id. Set RYVO_PROGRAM_ID or update Anchor.toml."
  );
}

function createWallet(payer: Keypair): anchor.Wallet & { payer: Keypair } {
  return {
    payer,
    publicKey: payer.publicKey,
    signTransaction: async (transaction: any) => {
      if ("version" in transaction) {
        transaction.sign([payer]);
      } else {
        transaction.partialSign(payer);
      }
      return transaction;
    },
    signAllTransactions: async (transactions: any[]) =>
      Promise.all(
        transactions.map(async (transaction) => {
          if ("version" in transaction) {
            transaction.sign([payer]);
          } else {
            transaction.partialSign(payer);
          }
          return transaction;
        })
      ),
  };
}

function loadProvider(): anchor.AnchorProvider {
  const rpcEndpoint =
    process.env.ANCHOR_PROVIDER_URL ?? resolveProjectRpcUrl("devnet");
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(process.cwd(), "keys", "devnet-deployer.json");

  if (!fs.existsSync(walletPath)) {
    throw new Error(
      `Wallet file not found. Set ANCHOR_WALLET or create ${walletPath}`
    );
  }

  const secretKey = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf8"))
  );
  const payer = Keypair.fromSecretKey(secretKey);
  const wallet = createWallet(payer);
  const connection = new Connection(rpcEndpoint, "confirmed");

  return new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

function inferNetwork(rpcEndpoint: string): SupportedNetwork {
  if (rpcEndpoint.includes("mainnet")) {
    return "mainnet";
  }
  if (rpcEndpoint.includes("devnet")) {
    return "devnet";
  }
  if (rpcEndpoint.includes("testnet")) {
    return "testnet";
  }
  if (rpcEndpoint.includes("127.0.0.1") || rpcEndpoint.includes("localhost")) {
    return "localnet";
  }
  return "localnet";
}

function chainIdForNetwork(network: SupportedNetwork): number {
  switch (network) {
    case "mainnet":
      return 0;
    case "devnet":
      return 1;
    case "testnet":
      return 2;
    case "localnet":
      return 3;
  }
}

function parseAllowlistedTokens(
  cliOptions: CliOptions
): AllowlistedTokenInput[] {
  const raw =
    cliOptions.allowlistedTokensJson ?? process.env.RYVO_ALLOWLIST_TOKENS;
  const tokens = raw ? JSON.parse(raw) : [];

  if (!Array.isArray(tokens)) {
    throw new Error("RYVO_ALLOWLIST_TOKENS must be a JSON array");
  }

  return tokens.map((token, index) => {
    if (!Number.isInteger(token.id) || token.id <= 0 || token.id > 65_535) {
      throw new Error(`Invalid token id at index ${index}`);
    }
    if (
      typeof token.symbol !== "string" ||
      !/^[\x20-\x7E]{1,8}$/.test(token.symbol)
    ) {
      throw new Error(`Invalid token symbol at index ${index}`);
    }

    return {
      id: token.id,
      symbol: token.symbol,
      mint: new PublicKey(token.mint).toString(),
    };
  });
}

function symbolBytes(symbol: string): number[] {
  const bytes = Buffer.alloc(8);
  Buffer.from(symbol, "ascii").copy(bytes, 0, 0, 8);
  return [...bytes];
}

function decodeSymbol(symbol: number[] | Buffer): string {
  return Buffer.from(symbol).toString("ascii").replace(/\0+$/g, "");
}

function findVaultTokenAccountPda(
  programId: PublicKey,
  tokenId: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_TOKEN_ACCOUNT_SEED),
      new anchor.BN(tokenId).toArrayLike(Buffer, "le", 2),
    ],
    programId
  )[0];
}

async function ensureFeeRecipientTokenAccount(
  provider: anchor.AnchorProvider,
  mint: PublicKey,
  feeRecipientWallet: PublicKey
): Promise<PublicKey> {
  const account = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as any).payer,
    mint,
    feeRecipientWallet
  );

  return account.address;
}

async function ensureTokenRegistry(
  program: Program<RyvoProtocol>,
  globalConfig: PublicKey,
  authority: PublicKey
): Promise<void> {
  const [tokenRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_REGISTRY_SEED)],
    program.programId
  );

  try {
    await program.account.tokenRegistry.fetch(tokenRegistryPda);
    console.log(
      "📋 Token registry already initialized:",
      tokenRegistryPda.toString()
    );
  } catch {
    console.log("📋 Initializing token registry...");
    await (program.methods.initializeTokenRegistry() as any)
      .accounts({
        globalConfig,
        authority,
      })
      .rpc();
  }
}

async function ensureAllowlistedTokens(
  program: Program<RyvoProtocol>,
  provider: anchor.AnchorProvider,
  feeRecipientWallet: PublicKey,
  requestedTokens: AllowlistedTokenInput[]
): Promise<void> {
  if (requestedTokens.length === 0) {
    console.log("ℹ️ No tokens requested for initial allowlist registration.");
    return;
  }

  const [tokenRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_REGISTRY_SEED)],
    program.programId
  );

  const registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);

  for (const token of requestedTokens) {
    const existing = registry.tokens.find(
      (entry: any) => entry.id === token.id
    );
    if (existing) {
      const existingMint = existing.mint.toString();
      if (existingMint !== token.mint) {
        throw new Error(
          `Token id ${token.id} is already registered to ${existingMint}, not ${token.mint}`
        );
      }

      console.log(`✅ Token ${token.symbol} (${token.id}) already registered`);
    } else {
      console.log(
        `💰 Registering allowlisted token ${token.symbol} (${token.id})...`
      );
      await program.methods
        .registerToken(token.id, symbolBytes(token.symbol))
        .accounts({
          mint: new PublicKey(token.mint),
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }

    const feeAccount = await ensureFeeRecipientTokenAccount(
      provider,
      new PublicKey(token.mint),
      feeRecipientWallet
    );
    console.log(
      `💳 Fee-recipient token account for ${
        token.symbol
      }: ${feeAccount.toString()}`
    );
  }
}

async function buildDeploymentTokens(
  program: Program<RyvoProtocol>,
  provider: anchor.AnchorProvider,
  feeRecipientWallet: PublicKey
): Promise<DeploymentToken[]> {
  const [tokenRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_REGISTRY_SEED)],
    program.programId
  );
  let registry: any;
  try {
    registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);
  } catch {
    return [];
  }

  const tokens = await Promise.all(
    registry.tokens.map(async (entry: any) => {
      const mint = new PublicKey(entry.mint.toString());
      const feeRecipientTokenAccount = await ensureFeeRecipientTokenAccount(
        provider,
        mint,
        feeRecipientWallet
      );

      return {
        id: entry.id,
        mint: mint.toString(),
        symbol: decodeSymbol(entry.symbol),
        decimals: entry.decimals,
        vault: findVaultTokenAccountPda(program.programId, entry.id).toString(),
        feeRecipientTokenAccount: feeRecipientTokenAccount.toString(),
      };
    })
  );

  return tokens.sort((a, b) => a.id - b.id);
}

async function initializeProgram(): Promise<DeploymentConfig> {
  console.log("🚀 Initializing Ryvo Network...");

  const cliOptions = parseCliArgs(process.argv.slice(2));
  const provider = loadProvider();
  anchor.setProvider(provider);
  const program = loadProgram(provider);
  const network = inferNetwork(provider.connection.rpcEndpoint);
  const chainId = chainIdForNetwork(network);
  const requestedTokens = parseAllowlistedTokens(cliOptions);
  const desiredInitialAuthority = cliOptions.initialAuthority
    ? new PublicKey(cliOptions.initialAuthority)
    : process.env.RYVO_INITIAL_AUTHORITY
    ? new PublicKey(process.env.RYVO_INITIAL_AUTHORITY)
    : provider.wallet.publicKey;
  const desiredFeeRecipient = cliOptions.feeRecipient
    ? new PublicKey(cliOptions.feeRecipient)
    : process.env.RYVO_FEE_RECIPIENT
    ? new PublicKey(process.env.RYVO_FEE_RECIPIENT)
    : provider.wallet.publicKey;

  console.log("📡 Connected to:", provider.connection.rpcEndpoint);
  console.log("🔑 Deployer:", provider.wallet.publicKey.toString());
  console.log(
    "🛡️ Desired config authority:",
    desiredInitialAuthority.toString()
  );
  console.log(
    "💼 Desired fee recipient wallet:",
    desiredFeeRecipient.toString()
  );
  if (requestedTokens.length > 0) {
    console.log(
      "🪙 Requested token allowlist:",
      requestedTokens.map((token) => `${token.symbol}:${token.id}`).join(", ")
    );
  }

  const [globalConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_CONFIG_SEED)],
    program.programId
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  );
  const messageDomain = createHash("sha256")
    .update(MESSAGE_DOMAIN_TAG)
    .update(program.programId.toBuffer())
    .update(Buffer.from([chainId & 0xff, (chainId >> 8) & 0xff]))
    .digest()
    .subarray(0, 16);

  let globalConfig: any | null = null;
  try {
    globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
    console.log("✅ Program already initialized!");
    console.log("🏦 Global Config PDA:", globalConfigPda.toString());
  } catch {
    console.log("⚙️  Initializing protocol...");
    console.log("💼 Fee recipient wallet:", desiredFeeRecipient.toString());
    console.log("⛓️ Chain ID:", chainId);
    console.log("🧬 Message domain:", Buffer.from(messageDomain).toString("hex"));

    const signature = await (program.methods.initialize(
      chainId,
      30,
      new anchor.BN(0),
      desiredInitialAuthority
    ) as any)
      .accounts({
        feeRecipient: desiredFeeRecipient,
        upgradeAuthority: provider.wallet.publicKey,
        program: program.programId,
        programData: programDataPda,
      })
      .rpc();

    console.log("✅ Protocol initialized! Transaction:", signature);
    globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
  }

  const currentAuthority = new PublicKey(globalConfig.authority.toString());
  if (!currentAuthority.equals(provider.wallet.publicKey)) {
    console.log(
      "ℹ️ Current config authority differs from the deployer wallet. Skipping authority-only bootstrap steps."
    );
  } else {
    await ensureTokenRegistry(program, globalConfigPda, provider.wallet.publicKey);
  }

  const currentFeeRecipient = new PublicKey(
    globalConfig.feeRecipient.toString()
  );
  if (
    currentAuthority.equals(provider.wallet.publicKey) &&
    !currentFeeRecipient.equals(desiredFeeRecipient)
  ) {
    console.log(
      "♻️ Updating fee recipient wallet to:",
      desiredFeeRecipient.toString()
    );
    await program.methods
      .updateConfig(null, desiredFeeRecipient, null, null)
      .accounts({
        globalConfig: globalConfigPda,
        authority: provider.wallet.publicKey,
      } as any)
      .remainingAccounts([
        {
          pubkey: desiredFeeRecipient,
          isSigner: false,
          isWritable: false,
        },
      ])
      .rpc();
    globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
  }

  await ensureAllowlistedTokens(
    program,
    provider,
    new PublicKey(globalConfig.feeRecipient.toString()),
    currentAuthority.equals(provider.wallet.publicKey) ? requestedTokens : []
  );
  if (
    requestedTokens.length > 0 &&
    !currentAuthority.equals(provider.wallet.publicKey)
  ) {
    console.log(
      "ℹ️ Skipped token registration because the current config authority is not the deployer wallet."
    );
  }

  globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
  const expectedMessageDomainHex = Buffer.from(messageDomain).toString("hex");
  const actualMessageDomainHex = Buffer.from(globalConfig.messageDomain).toString(
    "hex"
  );
  if (actualMessageDomainHex !== expectedMessageDomainHex) {
    throw new Error(
      `GlobalConfig message_domain mismatch: expected ${expectedMessageDomainHex}, got ${actualMessageDomainHex}`
    );
  }
  const tokens = await buildDeploymentTokens(
    program,
    provider,
    new PublicKey(globalConfig.feeRecipient.toString())
  );
  const channelUnlockTimelockSeconds =
    (globalConfig as any).channelUnlockTimelockSeconds?.toNumber?.() ?? null;

  console.log("🎯 Global config verified:");
  console.log("   - Authority:", globalConfig.authority.toString());
  if (!new PublicKey(globalConfig.pendingAuthority.toString()).equals(PublicKey.default)) {
    console.log(
      "   - Pending Authority:",
      globalConfig.pendingAuthority.toString(),
      "(must accept to complete the handoff)"
    );
  }
  console.log(
    "   - Fee Recipient Wallet:",
    globalConfig.feeRecipient.toString()
  );
  console.log("   - Fee BPS:", globalConfig.feeBps);
  console.log(
    "   - Registration Fee:",
    globalConfig.registrationFeeLamports.toString(),
    "lamports"
  );
  console.log(
    "   - Withdrawal Timelock:",
    globalConfig.withdrawalTimelockSeconds.toNumber(),
    "seconds"
  );
  if (channelUnlockTimelockSeconds !== null) {
    console.log(
      "   - Channel Unlock Timelock:",
      channelUnlockTimelockSeconds,
      "seconds"
    );
  }
  console.log("   - Allowlisted Tokens:", tokens.length);

  return {
    programId: program.programId.toString(),
    network,
    chainId,
    messageDomain: Buffer.from(globalConfig.messageDomain).toString("hex"),
    deployer: provider.wallet.publicKey.toString(),
    authority: globalConfig.authority.toString(),
    feeRecipient: globalConfig.feeRecipient.toString(),
    feeBps: globalConfig.feeBps,
    registrationFeeLamports: globalConfig.registrationFeeLamports.toNumber(),
    withdrawalTimelockSeconds:
      globalConfig.withdrawalTimelockSeconds.toNumber(),
    channelUnlockTimelockSeconds,
    tokens,
    deployedAt: new Date().toISOString(),
  };
}

initializeProgram()
  .then((config) => {
    console.log("✅ Initialization complete!");
    process.stdout.write(JSON.stringify(config, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Initialization failed:", err);
    process.exit(1);
  });
