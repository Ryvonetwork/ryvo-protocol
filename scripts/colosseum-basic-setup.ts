#!/usr/bin/env ts-node

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { RyvoProtocol } from "../target/types/ryvo_protocol";

const { loadProjectRpcEnv, resolveProjectRpcUrl } = require("./lib/rpc-env.cjs") as {
  loadProjectRpcEnv: (repoRoot?: string) => void;
  resolveProjectRpcUrl: (network?: string) => string;
};

loadProjectRpcEnv(process.cwd());

type Network = "devnet" | "mainnet" | "localnet" | "testnet";
type WalletRole = "merchant" | "participant";

type CliOptions = {
  network: Network;
  keysDir: string;
  manifestPath: string;
  participantCount: number;
  minWalletLamports: number;
  registerParticipants: boolean;
  ensureUsdc: boolean;
  usdcMint: string;
  usdcTokenId: number;
  usdcSymbol: string;
};

type WalletRecord = {
  label: string;
  role: WalletRole;
  keypairPath: string;
  publicKey: string;
  participantId?: number;
  participantBucket?: string;
  participantBucketId?: number;
  ownerIndexBucket?: string;
  ownerIndexBucketId?: number;
};

const GLOBAL_CONFIG_SEED = Buffer.from("global-config");
const TOKEN_REGISTRY_SEED = Buffer.from("token-registry");
const PARTICIPANT_BUCKET_SEED = Buffer.from("participant-bucket-v2");
const OWNER_INDEX_BUCKET_SEED = Buffer.from("owner-index-bucket-v2");
const VAULT_TOKEN_ACCOUNT_SEED = Buffer.from("vault-token-account");
const YIELD_STRATEGY_SEED = Buffer.from("yield-strategy");
const YIELD_SHARE_VAULT_SEED = Buffer.from("yield-share-vault");
const PARTICIPANT_BUCKET_SLOT_COUNT = 9;
const OWNER_INDEX_BUCKET_COUNT = 1024;
const DEFAULT_KEYS_DIR = "keys/colosseum-basic-devnet";
const DEFAULT_MANIFEST_PATH = "deployments/devnet/colosseum-basic-setup.json";
const DEFAULT_MIN_WALLET_LAMPORTS = Math.round(0.12 * LAMPORTS_PER_SOL);
const DEFAULT_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    network: "devnet",
    keysDir: DEFAULT_KEYS_DIR,
    manifestPath: DEFAULT_MANIFEST_PATH,
    participantCount: 32,
    minWalletLamports: DEFAULT_MIN_WALLET_LAMPORTS,
    registerParticipants: true,
    ensureUsdc: true,
    usdcMint: DEFAULT_DEVNET_USDC_MINT,
    usdcTokenId: 1,
    usdcSymbol: "USDC",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const eqIndex = arg.indexOf("=");
    const key = arg.slice(2, eqIndex >= 0 ? eqIndex : undefined);
    let value = eqIndex >= 0 ? arg.slice(eqIndex + 1) : argv[i + 1];
    if (eqIndex < 0 && value && !value.startsWith("--")) {
      i += 1;
    } else if (eqIndex < 0) {
      value = undefined;
    }

    switch (key) {
      case "network":
        if (
          value === "devnet" ||
          value === "mainnet" ||
          value === "localnet" ||
          value === "testnet"
        ) {
          options.network = value;
        }
        break;
      case "keys-dir":
        if (value) options.keysDir = value;
        break;
      case "manifest":
        if (value) options.manifestPath = value;
        break;
      case "participant-count":
        if (value) options.participantCount = parseInt(value, 10);
        break;
      case "min-wallet-lamports":
        if (value) options.minWalletLamports = parseInt(value, 10);
        break;
      case "skip-register":
        options.registerParticipants = false;
        break;
      case "skip-usdc":
        options.ensureUsdc = false;
        break;
      case "usdc-mint":
        if (value) options.usdcMint = value;
        break;
      case "usdc-token-id":
        if (value) options.usdcTokenId = parseInt(value, 10);
        break;
      case "usdc-symbol":
        if (value) options.usdcSymbol = value;
        break;
      default:
        break;
    }
  }

  return options;
}

function relPath(filePath: string): string {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

function loadKeypair(filePath: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function writeKeypair(filePath: string, keypair: Keypair): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
  fs.chmodSync(filePath, 0o600);
}

function loadOrCreateKey(filePath: string): Keypair {
  if (fs.existsSync(filePath)) return loadKeypair(filePath);

  const keypair = Keypair.generate();
  writeKeypair(filePath, keypair);
  return keypair;
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

function loadProvider(network: Network): anchor.AnchorProvider {
  const rpc = process.env.ANCHOR_PROVIDER_URL ?? resolveProjectRpcUrl(network);
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(process.cwd(), "keys", `${network}-deployer.json`);

  if (!fs.existsSync(walletPath)) {
    throw new Error(`Missing deployer wallet: ${walletPath}`);
  }

  const payer = loadKeypair(walletPath);
  const wallet = createWallet(payer);
  return new anchor.AnchorProvider(
    new anchor.web3.Connection(rpc, "confirmed"),
    wallet,
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    }
  );
}

function resolveProgramId(network: Network, programName: string): PublicKey {
  const anchorTomlPath = path.join(process.cwd(), "Anchor.toml");
  const sectionHeader = `[programs.${network}]`;
  let inSection = false;

  for (const line of fs.readFileSync(anchorTomlPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inSection = trimmed === sectionHeader;
      continue;
    }
    if (!inSection) continue;
    const match = trimmed.match(new RegExp(`^${programName}\\s*=\\s*"([^"]+)"$`));
    if (match) return new PublicKey(match[1]);
  }

  throw new Error(`Unable to resolve ${programName} for ${network}`);
}

function loadProgram(
  provider: anchor.AnchorProvider,
  network: Network
): Program<RyvoProtocol> {
  const idlPath = path.join(process.cwd(), "target", "idl", "ryvo_protocol.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = resolveProgramId(network, "ryvo_protocol");
  return new Program({ ...idl, address: programId.toString() } as RyvoProtocol, provider);
}

function u16Le(value: number): Buffer {
  return new anchor.BN(value).toArrayLike(Buffer, "le", 2);
}

function u32Le(value: number): Buffer {
  return new anchor.BN(value).toArrayLike(Buffer, "le", 4);
}

function participantBucketIdForParticipantId(participantId: number): number {
  return Math.floor(participantId / PARTICIPANT_BUCKET_SLOT_COUNT);
}

function ownerIndexBucketIdForOwner(owner: PublicKey): number {
  const digest = createHash("sha256").update(owner.toBuffer()).digest();
  return digest.readUInt32LE(0) % OWNER_INDEX_BUCKET_COUNT;
}

function findGlobalConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([GLOBAL_CONFIG_SEED], programId)[0];
}

function findTokenRegistryPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([TOKEN_REGISTRY_SEED], programId)[0];
}

function findParticipantBucketPda(programId: PublicKey, participantId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PARTICIPANT_BUCKET_SEED, u32Le(participantBucketIdForParticipantId(participantId))],
    programId
  )[0];
}

function findOwnerIndexBucketPda(programId: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [OWNER_INDEX_BUCKET_SEED, u32Le(ownerIndexBucketIdForOwner(owner))],
    programId
  )[0];
}

function findVaultTokenAccountPda(programId: PublicKey, tokenId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [VAULT_TOKEN_ACCOUNT_SEED, u16Le(tokenId)],
    programId
  )[0];
}

function findYieldStrategyPda(programId: PublicKey, tokenId: number): PublicKey {
  return PublicKey.findProgramAddressSync([YIELD_STRATEGY_SEED, u16Le(tokenId)], programId)[0];
}

function findYieldShareVaultPda(programId: PublicKey, tokenId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [YIELD_SHARE_VAULT_SEED, u16Le(tokenId)],
    programId
  )[0];
}

function symbolFromBytes(symbol: number[] | Buffer): string {
  return Buffer.from(symbol).toString("ascii").replace(/\0+$/g, "");
}

function symbolBytes(symbol: string): number[] {
  const bytes = Buffer.alloc(8);
  Buffer.from(symbol, "ascii").copy(bytes, 0, 0, 8);
  return [...bytes];
}

function loadExistingManifest(manifestPath: string): any | null {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function buildWalletRecords(options: CliOptions, existingManifest: any | null): WalletRecord[] {
  const absoluteKeysDir = path.resolve(options.keysDir);
  fs.mkdirSync(absoluteKeysDir, { recursive: true });

  const existingByLabel = new Map<string, any>();
  if (existingManifest?.wallets?.merchant) {
    existingByLabel.set(existingManifest.wallets.merchant.label, existingManifest.wallets.merchant);
  }
  for (const participant of existingManifest?.wallets?.participants ?? []) {
    existingByLabel.set(participant.label, participant);
  }

  const labels: Array<{ label: string; role: WalletRole; file: string }> = [
    { label: "merchant", role: "merchant", file: "merchant.json" },
    ...Array.from({ length: options.participantCount }, (_, index) => {
      const n = String(index + 1).padStart(2, "0");
      return {
        label: `participant-${n}`,
        role: "participant" as const,
        file: `participant-${n}.json`,
      };
    }),
  ];

  return labels.map(({ label, role, file }) => {
    const keypairPath = path.join(absoluteKeysDir, file);
    const keypair = loadOrCreateKey(keypairPath);
    const existing = existingByLabel.get(label);

    return {
      label,
      role,
      keypairPath: relPath(keypairPath),
      publicKey: keypair.publicKey.toString(),
      participantId: existing?.participantId,
      participantBucket: existing?.participantBucket,
      participantBucketId: existing?.participantBucketId,
      ownerIndexBucket: existing?.ownerIndexBucket,
      ownerIndexBucketId: existing?.ownerIndexBucketId,
    };
  });
}

async function ensureLamports(
  provider: anchor.AnchorProvider,
  recipient: PublicKey,
  minLamports: number
): Promise<void> {
  const current = await provider.connection.getBalance(recipient, "confirmed");
  if (current >= minLamports) return;

  const payer = (provider.wallet as any).payer as Keypair;
  const missing = minLamports - current;
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: missing,
    })
  );
  await sendAndConfirmTransaction(provider.connection, transaction, [payer], {
    commitment: "confirmed",
  });
}

async function registerWallets(
  program: Program<RyvoProtocol>,
  provider: anchor.AnchorProvider,
  records: WalletRecord[],
  minWalletLamports: number
): Promise<WalletRecord[]> {
  const globalConfigPda = findGlobalConfigPda(program.programId);
  let globalConfig: any = await program.account.globalConfig.fetch(globalConfigPda);
  const feeRecipient = new PublicKey(globalConfig.feeRecipient.toString());

  const updated: WalletRecord[] = [];
  for (const record of records) {
    const owner = loadKeypair(path.resolve(record.keypairPath));

    if (record.participantId !== undefined) {
      updated.push(record);
      continue;
    }

    await ensureLamports(provider, owner.publicKey, minWalletLamports);

    globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
    const participantId = Number(globalConfig.nextParticipantId);
    const participantBucketId = participantBucketIdForParticipantId(participantId);
    const ownerIndexBucketId = ownerIndexBucketIdForOwner(owner.publicKey);
    const participantBucket = findParticipantBucketPda(program.programId, participantId);
    const ownerIndexBucket = findOwnerIndexBucketPda(program.programId, owner.publicKey);

    console.log(
      `Registering ${record.label} (${owner.publicKey.toBase58()}) as participant ${participantId}`
    );
    await program.methods
      .initializeParticipant(participantBucketId, ownerIndexBucketId)
      .accounts({
        globalConfig: globalConfigPda,
        participantBucket,
        ownerIndexBucket,
        feeRecipient,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([owner])
      .rpc();

    updated.push({
      ...record,
      participantId,
      participantBucket: participantBucket.toString(),
      participantBucketId,
      ownerIndexBucket: ownerIndexBucket.toString(),
      ownerIndexBucketId,
    });
  }

  return updated;
}

async function ensurePlainTokenRegistered(
  program: Program<RyvoProtocol>,
  provider: anchor.AnchorProvider,
  tokenId: number,
  mint: PublicKey,
  symbol: string
): Promise<void> {
  const tokenRegistryPda = findTokenRegistryPda(program.programId);
  const registry: any = await program.account.tokenRegistry.fetch(tokenRegistryPda);
  const existing = registry.tokens.find((entry: any) => Number(entry.id) === tokenId);

  if (existing) {
    if (existing.mint.toString() !== mint.toString()) {
      throw new Error(
        `Token id ${tokenId} is already registered to ${existing.mint.toString()}, not ${mint.toString()}`
      );
    }
    return;
  }

  console.log(`Registering ${symbol} as token ${tokenId}: ${mint.toBase58()}`);
  await program.methods
    .registerToken(tokenId, symbolBytes(symbol))
    .accounts({
      mint,
      authority: provider.wallet.publicKey,
    } as any)
    .rpc();
}

async function buildTokens(program: Program<RyvoProtocol>): Promise<any[]> {
  const tokenRegistryPda = findTokenRegistryPda(program.programId);
  const registry: any = await program.account.tokenRegistry.fetch(tokenRegistryPda);

  const tokens = [];
  for (const entry of registry.tokens) {
    const tokenId = Number(entry.id);
    const kindId = Number(entry.kind);
    const token: any = {
      tokenId,
      symbol: symbolFromBytes(entry.symbol),
      kind: kindId === 1 ? "yield-bearing" : "plain",
      kindId,
      mint: entry.mint.toString(),
      decimals: Number(entry.decimals),
      registeredAt: entry.registeredAt?.toString?.() ?? String(entry.registered_at ?? ""),
    };

    if (kindId === 0) {
      token.vaultTokenAccount = findVaultTokenAccountPda(program.programId, tokenId).toString();
    }

    if (kindId === 1) {
      const yieldStrategyPda = findYieldStrategyPda(program.programId, tokenId);
      const shareVaultPda = findYieldShareVaultPda(program.programId, tokenId);
      token.yieldStrategy = yieldStrategyPda.toString();
      token.shareVault = shareVaultPda.toString();
      try {
        const strategy: any = await program.account.yieldStrategy.fetch(yieldStrategyPda);
        token.underlyingMint = strategy.underlyingMint.toString();
        token.yieldProgram = strategy.yieldProgram.toString();
        token.reserve = strategy.reserve.toString();
        token.shareMint = strategy.shareMint.toString();
        token.liquidityVault = strategy.liquidityVault.toString();
        token.protocolYieldShareBps = Number(strategy.protocolYieldShareBps);
      } catch {
        token.warning = "YieldStrategy account was not found.";
      }
    }

    tokens.push(token);
  }

  return tokens.sort((a, b) => a.tokenId - b.tokenId);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = loadProvider(options.network);
  anchor.setProvider(provider);
  const program = loadProgram(provider, options.network);
  const mockYieldProgramId = resolveProgramId(options.network, "mock_yield");
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const tokenRegistryPda = findTokenRegistryPda(program.programId);

  const existingManifest = loadExistingManifest(path.resolve(options.manifestPath));
  let walletRecords = buildWalletRecords(options, existingManifest);
  if (options.registerParticipants) {
    walletRecords = await registerWallets(
      program,
      provider,
      walletRecords,
      options.minWalletLamports
    );
  }
  if (options.ensureUsdc) {
    await ensurePlainTokenRegistered(
      program,
      provider,
      options.usdcTokenId,
      new PublicKey(options.usdcMint),
      options.usdcSymbol
    );
  }

  const globalConfig: any = await program.account.globalConfig.fetch(globalConfigPda);
  const tokens = await buildTokens(program);
  const merchant = walletRecords.find((record) => record.role === "merchant");
  const participants = walletRecords.filter((record) => record.role === "participant");

  const manifest = {
    generatedAt: new Date().toISOString(),
    network: options.network,
    rpcUrl: provider.connection.rpcEndpoint,
    program: {
      ryvoProtocol: program.programId.toString(),
      mockYield: mockYieldProgramId.toString(),
      globalConfig: globalConfigPda.toString(),
      tokenRegistry: tokenRegistryPda.toString(),
      authority: globalConfig.authority.toString(),
      feeRecipient: globalConfig.feeRecipient.toString(),
      chainId: Number(globalConfig.chainId),
      messageDomain: Buffer.from(globalConfig.messageDomain).toString("hex"),
      nextParticipantId: Number(globalConfig.nextParticipantId),
    },
    wallets: {
      keysDirectory: relPath(path.resolve(options.keysDir)),
      note: "Secret keypair JSON files are stored under keysDirectory and are intentionally gitignored.",
      merchant,
      participants,
    },
    tokens,
  };

  const manifestPath = path.resolve(options.manifestPath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote public setup manifest to ${relPath(manifestPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
