#!/usr/bin/env ts-node
/**
 * v6 yield-bearing devnet demo.
 *
 * End-to-end flow:
 *   1. Bootstrap (idempotent) — creates a USDC-style mint (deployer-controlled), initialises a
 *      mock-yield Reserve at 6% APY, registers agUSDC as token_id=1 (kind=YieldBearing) in the
 *      Agon protocol.
 *   2. Two users (Alice, Bob) deposit USDC; the protocol auto-converts to agUSDC shares.
 *   3. Sleep + permissionless accrue_yield → user_index_q64 advances, protocol_owed_underlying
 *      grows.
 *   4. Mid-run update_apy_bps(900) (6% → 9%), then sleep + accrue again to show dynamic rates.
 *   5. claim_protocol_yield_fee(token_id=1) — fee_recipient pulls accrued protocol cut.
 *   6. Both users request + execute withdrawal. They receive their full USDC back (principal +
 *      4% (or 6% post-bump) yield share).
 *
 * Designed to also run on localnet (`anchor test --skip-local-validator` or against
 * `solana-test-validator` with the program deployed).
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AgonProtocol } from "../target/types/agon_protocol";
import { MockYield } from "../target/types/mock_yield";
import {
  Q64,
  agSharesToUsdc,
  formatUsdc,
} from "../shared/yield";

const { loadProjectRpcEnv, resolveProjectRpcUrl } = require("./lib/rpc-env.cjs") as {
  loadProjectRpcEnv: (repoRoot?: string) => void;
  resolveProjectRpcUrl: (network?: string) => string;
};

loadProjectRpcEnv(process.cwd());

// ---------------------------------------------------------------------------
// Constants (mirrored from agon-protocol/state + mock-yield/lib.rs)
// ---------------------------------------------------------------------------

const TOKEN_REGISTRY_SEED = Buffer.from("token-registry");
const GLOBAL_CONFIG_SEED = Buffer.from("global-config");
const PARTICIPANT_BUCKET_SEED = Buffer.from("participant-bucket-v2");
const OWNER_INDEX_BUCKET_SEED = Buffer.from("owner-index-bucket-v2");
const YIELD_STRATEGY_SEED = Buffer.from("yield-strategy");
const YIELD_SHARE_VAULT_SEED = Buffer.from("yield-share-vault");
const RESERVE_SEED = Buffer.from("reserve");
const SHARE_MINT_SEED = Buffer.from("share-mint");
const LIQUIDITY_VAULT_SEED = Buffer.from("liquidity-vault");

const AG_USDC_TOKEN_ID = 1;
const AG_USDC_SYMBOL = "agUSDC";
const PROTOCOL_YIELD_SHARE_BPS = 3_333; // ~33.33% of yield to protocol (6% gross → ~4% net for users).
// Demo defaults — cranked up so visible yield accrues in <60s even with small balances.
// Mock-yield uses linear integer accrual: yield = total * apy_bps * dt / (10_000 * 31_536_000).
// At 5000 bps (50%) APY and 10 USDC total, ~30s of accrual gives ~5 microunits — visible.
// At realistic 600 bps with the same balance/time, integer math rounds to ZERO. Override via
// --apy-initial-bps / --apy-bumped-bps for realistic narratives once you have larger deposits.
const INITIAL_APY_BPS = 4_000; // 40%
const BUMPED_APY_BPS = 5_000; // 50% (mid-run rate change demonstrates dynamic rates)
// Canonical Circle devnet USDC. Deployer cannot mint this, so the demo transfers from its own
// USDC ATA when funding users / topping up the yield buffer.
const CANONICAL_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const PARTICIPANT_BUCKET_SLOT_COUNT = 9;
const OWNER_INDEX_BUCKET_COUNT = 1024;
// Layout constants mirrored from agon-protocol::state::bucket_state. The struct is gated
// `#[cfg_attr(not(target_os = "solana"), account)]` so it does NOT show up in the IDL types
// and we cannot use `program.account.participantBucket.fetch(...)`. Instead we decode bytes.
const PB_SLOTS_OFFSET = 8 + 4 + 1; // discriminator(8) + bucket_id(4) + bump(1)
const PB_SLOT_SPACE =
  1 /*initialized*/ +
  32 /*owner*/ +
  4 /*participant_id*/ +
  1 /*inbound_channel_policy*/ +
  1 /*bls_scheme_version*/ +
  96 /*bls_pubkey_compressed*/ +
  16 * (1 + 2 + 8 + 8 + 8 + 32); /*MAX_BUCKET_TOKEN_BALANCES * BucketTokenBalance::SPACE*/
const PB_TOKEN_BALANCES_OFFSET_IN_SLOT = 1 + 32 + 4 + 1 + 1 + 96; // 135
const TOKEN_BALANCE_SPACE = 1 + 2 + 8 + 8 + 8 + 32; // 59
const MAX_BUCKET_TOKEN_BALANCES = 16;
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const MESSAGE_DOMAIN_TAG = Buffer.from("agon-message-domain-v1", "utf8");

type SupportedNetwork = "devnet" | "mainnet" | "testnet" | "localnet";

// ---------------------------------------------------------------------------
// CLI / env
// ---------------------------------------------------------------------------

interface CliOptions {
  network: SupportedNetwork;
  usdcMint?: string;
  sleepSecsAfterDeposit: number;
  sleepSecsAfterApyBump: number;
  perUserUsdc: bigint;
  yieldBufferUsdc: bigint;
  apyInitialBps: number;
  apyBumpedBps: number;
  protocolYieldBps: number;
  feeRecipient?: string;
  bootstrapOnly: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  const out: CliOptions = {
    network: "devnet",
    sleepSecsAfterDeposit: 30,
    sleepSecsAfterApyBump: 30,
    perUserUsdc: 5_000_000n, // 5 USDC per user (10 total) — well within a 60-USDC devnet balance.
    yieldBufferUsdc: 1_000_000n, // 1 USDC reserved as simulated-yield buffer in liquidity_vault.
    apyInitialBps: INITIAL_APY_BPS,
    apyBumpedBps: BUMPED_APY_BPS,
    protocolYieldBps: PROTOCOL_YIELD_SHARE_BPS,
    bootstrapOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) continue;
    const eqIdx = value.indexOf("=");
    let key: string;
    let parsed: string | undefined;
    if (eqIdx >= 0) {
      key = value.slice(2, eqIdx);
      parsed = value.slice(eqIdx + 1);
    } else {
      key = value.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        parsed = next;
        i += 1;
      }
    }
    switch (key) {
      case "network":
        if (parsed === "devnet" || parsed === "mainnet" || parsed === "localnet" || parsed === "testnet") {
          out.network = parsed;
        }
        break;
      case "usdc-mint":
        out.usdcMint = parsed;
        break;
      case "sleep-secs":
        if (parsed) {
          out.sleepSecsAfterDeposit = parseInt(parsed, 10);
          out.sleepSecsAfterApyBump = parseInt(parsed, 10);
        }
        break;
      case "per-user-usdc":
        if (parsed) out.perUserUsdc = BigInt(parsed);
        break;
      case "yield-buffer-usdc":
        if (parsed) out.yieldBufferUsdc = BigInt(parsed);
        break;
      case "apy-initial-bps":
        if (parsed) out.apyInitialBps = parseInt(parsed, 10);
        break;
      case "apy-bumped-bps":
        if (parsed) out.apyBumpedBps = parseInt(parsed, 10);
        break;
      case "protocol-yield-bps":
        if (parsed) out.protocolYieldBps = parseInt(parsed, 10);
        break;
      case "fee-recipient":
        out.feeRecipient = parsed;
        break;
      case "bootstrap-only":
        out.bootstrapOnly = true;
        break;
      default:
        break;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function inferNetwork(rpc: string): SupportedNetwork {
  if (rpc.includes("mainnet")) return "mainnet";
  if (rpc.includes("devnet")) return "devnet";
  if (rpc.includes("testnet")) return "testnet";
  if (rpc.includes("127.0.0.1") || rpc.includes("localhost")) return "localnet";
  return "localnet";
}

function chainIdForNetwork(net: SupportedNetwork): number {
  switch (net) {
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

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function createWallet(payer: Keypair): anchor.Wallet & { payer: Keypair } {
  return {
    payer,
    publicKey: payer.publicKey,
    signTransaction: async (tx: any) => {
      if ("version" in tx) {
        tx.sign([payer]);
      } else {
        tx.partialSign(payer);
      }
      return tx;
    },
    signAllTransactions: async (txs: any[]) =>
      Promise.all(
        txs.map(async (tx) => {
          if ("version" in tx) {
            tx.sign([payer]);
          } else {
            tx.partialSign(payer);
          }
          return tx;
        })
      ),
  };
}

function loadProvider(network: SupportedNetwork): anchor.AnchorProvider {
  const rpc = process.env.ANCHOR_PROVIDER_URL ?? resolveProjectRpcUrl(network);
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(process.cwd(), "keys", `${network}-deployer.json`);
  if (!fs.existsSync(walletPath)) {
    throw new Error(
      `Wallet file not found. Set ANCHOR_WALLET or place a deployer key at ${walletPath}`
    );
  }
  const payer = loadKeypair(walletPath);
  const wallet = createWallet(payer);
  const connection = new Connection(rpc, "confirmed");
  return new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

function resolveProgramId(
  net: SupportedNetwork,
  programName: "agon_protocol" | "mock_yield",
  fallback?: string
): PublicKey {
  const anchorTomlPath = path.join(__dirname, "..", "Anchor.toml");
  if (fs.existsSync(anchorTomlPath)) {
    const sectionHeader = `[programs.${net}]`;
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
  }
  if (fallback) return new PublicKey(fallback);
  throw new Error(`Could not resolve program id for ${programName} on ${net}`);
}

function loadAgonProgram(provider: anchor.AnchorProvider, net: SupportedNetwork): Program<AgonProtocol> {
  const idlPath = path.join(__dirname, "..", "target", "idl", "agon_protocol.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = resolveProgramId(net, "agon_protocol", idl.address);
  return new Program({ ...idl, address: programId.toString() } as AgonProtocol, provider);
}

function loadMockYieldProgram(provider: anchor.AnchorProvider, net: SupportedNetwork): Program<MockYield> {
  const idlPath = path.join(__dirname, "..", "target", "idl", "mock_yield.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = resolveProgramId(net, "mock_yield", idl.address);
  return new Program({ ...idl, address: programId.toString() } as MockYield, provider);
}

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

function findGlobalConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([GLOBAL_CONFIG_SEED], programId)[0];
}

function findTokenRegistryPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([TOKEN_REGISTRY_SEED], programId)[0];
}

function u16Le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32Le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function findYieldStrategyPda(programId: PublicKey, tokenId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [YIELD_STRATEGY_SEED, u16Le(tokenId)],
    programId
  )[0];
}

function findYieldShareVaultPda(programId: PublicKey, tokenId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [YIELD_SHARE_VAULT_SEED, u16Le(tokenId)],
    programId
  )[0];
}

function findReservePda(programId: PublicKey, underlyingMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [RESERVE_SEED, underlyingMint.toBuffer()],
    programId
  )[0];
}

function findShareMintPda(programId: PublicKey, underlyingMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SHARE_MINT_SEED, underlyingMint.toBuffer()],
    programId
  )[0];
}

function findLiquidityVaultPda(programId: PublicKey, underlyingMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [LIQUIDITY_VAULT_SEED, underlyingMint.toBuffer()],
    programId
  )[0];
}

function ownerIndexBucketIdForOwner(owner: PublicKey): number {
  const digest = createHash("sha256").update(owner.toBuffer()).digest();
  return digest.readUInt32LE(0) % OWNER_INDEX_BUCKET_COUNT;
}

function findOwnerIndexBucketPda(programId: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [OWNER_INDEX_BUCKET_SEED, u32Le(ownerIndexBucketIdForOwner(owner))],
    programId
  )[0];
}

function participantBucketIdForParticipantId(participantId: number): number {
  return Math.floor(participantId / PARTICIPANT_BUCKET_SLOT_COUNT);
}

function findParticipantBucketPda(programId: PublicKey, participantId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PARTICIPANT_BUCKET_SEED, u32Le(participantBucketIdForParticipantId(participantId))],
    programId
  )[0];
}

function symbolBytes(symbol: string): number[] {
  const buf = Buffer.alloc(8);
  Buffer.from(symbol, "ascii").copy(buf, 0, 0, 8);
  return [...buf];
}

// ---------------------------------------------------------------------------
// USDC mint resolution
// ---------------------------------------------------------------------------

async function resolveUsdcMint(
  provider: anchor.AnchorProvider,
  options: CliOptions
): Promise<PublicKey> {
  if (options.usdcMint) {
    const mint = new PublicKey(options.usdcMint);
    console.log(`💵 Using provided USDC mint: ${mint.toBase58()}`);
    return mint;
  }
  if (process.env.USDC_MINT) {
    const mint = new PublicKey(process.env.USDC_MINT);
    console.log(`💵 Using USDC mint from env: ${mint.toBase58()}`);
    return mint;
  }

  const network = inferNetwork(provider.connection.rpcEndpoint);

  // Devnet/mainnet → use the canonical Circle USDC. Deployer is not the mint authority, so user
  // funding and yield-buffer top-ups are SPL transfers from the deployer's USDC ATA (the deployer
  // must hold enough real USDC).
  if (network === "devnet" || network === "mainnet") {
    const mint = new PublicKey(CANONICAL_DEVNET_USDC_MINT);
    console.log(`💵 Using canonical ${network} USDC mint: ${mint.toBase58()}`);
    console.log(
      `   ℹ️ Deployer must hold enough real USDC: ` +
        `(per_user_usdc × num_users) + yield_buffer_usdc + a small ATA-rent + tx-fees buffer.`
    );
    return mint;
  }

  // Localnet/testnet → spin up a deployer-controlled mint and cache it. Reruns are idempotent.
  const cachePath = path.join(process.cwd(), "keys", `${network}-demo-usdc-mint.json`);
  if (fs.existsSync(cachePath)) {
    const mintAddress = fs.readFileSync(cachePath, "utf8").trim();
    const mint = new PublicKey(mintAddress);
    console.log(`💵 Using cached demo USDC mint: ${mint.toBase58()}`);
    return mint;
  }

  console.log("💵 Creating fresh demo USDC-style mint (6 decimals, deployer-controlled)...");
  const payer = (provider.wallet as any).payer as Keypair;
  const mint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    6,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, mint.toBase58() + "\n");
  console.log(`   ✓ Created and cached: ${mint.toBase58()}`);
  return mint;
}

async function deployerIsMintAuthority(
  provider: anchor.AnchorProvider,
  mint: PublicKey
): Promise<boolean> {
  try {
    const { getMint } = require("@solana/spl-token") as typeof import("@solana/spl-token");
    const info = await getMint(provider.connection, mint, "confirmed");
    return !!info.mintAuthority && info.mintAuthority.equals(provider.wallet.publicKey);
  } catch {
    return false;
  }
}

async function fundUsdc(
  provider: anchor.AnchorProvider,
  mint: PublicKey,
  recipient: PublicKey,
  amount: bigint
): Promise<PublicKey> {
  const payer = (provider.wallet as any).payer as Keypair;
  const ata = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    mint,
    recipient,
    false,
    "confirmed"
  );
  if (await deployerIsMintAuthority(provider, mint)) {
    await mintTo(
      provider.connection,
      payer,
      mint,
      ata.address,
      payer,
      Number(amount),
      [],
      { commitment: "confirmed" }
    );
    return ata.address;
  }
  // Deployer is not mint authority (real USDC). Transfer from the deployer's own USDC ATA.
  const { transfer } = require("@solana/spl-token") as typeof import("@solana/spl-token");
  const deployerAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    mint,
    payer.publicKey,
    false,
    "confirmed"
  );
  if (deployerAta.amount < amount) {
    throw new Error(
      `Deployer USDC ATA ${deployerAta.address.toBase58()} has only ${deployerAta.amount} ` +
        `(need at least ${amount}). Top up the deployer's USDC and retry.`
    );
  }
  await transfer(
    provider.connection,
    payer,
    deployerAta.address,
    ata.address,
    payer,
    Number(amount),
    [],
    { commitment: "confirmed" }
  );
  return ata.address;
}

// ---------------------------------------------------------------------------
// Bootstrap (idempotent)
// ---------------------------------------------------------------------------

async function ensureMockYieldReserve(
  provider: anchor.AnchorProvider,
  mockYield: Program<MockYield>,
  underlyingMint: PublicKey,
  apyBps: number
): Promise<{ reserve: PublicKey; shareMint: PublicKey; liquidityVault: PublicKey }> {
  const reservePda = findReservePda(mockYield.programId, underlyingMint);
  const shareMintPda = findShareMintPda(mockYield.programId, underlyingMint);
  const liquidityVaultPda = findLiquidityVaultPda(mockYield.programId, underlyingMint);

  const reserveAccountInfo = await provider.connection.getAccountInfo(reservePda);
  if (reserveAccountInfo) {
    console.log(`🏦 Mock-yield reserve already initialised: ${reservePda.toBase58()}`);
    return { reserve: reservePda, shareMint: shareMintPda, liquidityVault: liquidityVaultPda };
  }

  console.log(`🏦 Initialising mock-yield reserve at ${apyBps / 100}% APY...`);
  await mockYield.methods
    .initializeReserve(apyBps)
    .accounts({
      underlyingMint,
      authority: provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  console.log(`   ✓ Reserve PDA: ${reservePda.toBase58()}`);
  console.log(`   ✓ Share mint (cUSDC): ${shareMintPda.toBase58()}`);
  console.log(`   ✓ Liquidity vault: ${liquidityVaultPda.toBase58()}`);
  return { reserve: reservePda, shareMint: shareMintPda, liquidityVault: liquidityVaultPda };
}

/**
 * Mock-yield's `accrue` bumps `total_underlying` virtually but does not actually move USDC into
 * `liquidity_vault` (real lending protocols would be paid by borrowers). To keep the simulated
 * yield redeemable, we mint a USDC buffer directly into `liquidity_vault` on bootstrap. This is
 * only valid because the demo USDC mint is deployer-controlled. In production with a real Save /
 * Kamino reserve, no such buffer is needed because borrowers actually pay interest.
 */
async function ensureLiquidityVaultYieldBuffer(
  provider: anchor.AnchorProvider,
  underlyingMint: PublicKey,
  liquidityVault: PublicKey,
  bufferAmount: bigint
): Promise<void> {
  if (bufferAmount === 0n) {
    console.log("   ℹ️ Yield buffer disabled (--yield-buffer-usdc=0).");
    return;
  }
  const payer = (provider.wallet as any).payer as Keypair;
  const current = await getAccount(provider.connection, liquidityVault, "confirmed").catch(() => null);
  if (current && current.amount >= bufferAmount) {
    console.log(`   ℹ️ Liquidity vault already buffered (${formatUsdc(current.amount)} USDC).`);
    return;
  }
  const topUp = bufferAmount - (current?.amount ?? 0n);

  // Path 1: deployer is mint authority → mint fresh tokens. Used for localnet/testnet demos.
  if (await deployerIsMintAuthority(provider, underlyingMint)) {
    console.log(
      `💧 Topping up liquidity_vault with ${formatUsdc(topUp)} USDC ` +
        `(simulated-yield buffer, minted by deployer)...`
    );
    await mintTo(
      provider.connection,
      payer,
      underlyingMint,
      liquidityVault,
      payer,
      Number(topUp),
      [],
      { commitment: "confirmed" }
    );
    console.log(`   ✓ Buffer in place.`);
    return;
  }

  // Path 2: real USDC. Transfer from the deployer's USDC ATA into liquidity_vault. The deployer
  // must hold enough real USDC; otherwise we surface a clear error.
  const { transfer } = require("@solana/spl-token") as typeof import("@solana/spl-token");
  const deployerAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    underlyingMint,
    payer.publicKey,
    false,
    "confirmed"
  );
  if (deployerAta.amount < topUp) {
    throw new Error(
      `Yield-buffer top-up requires ${topUp} micro-USDC but deployer ATA ` +
        `${deployerAta.address.toBase58()} only has ${deployerAta.amount}. ` +
        `Top up the deployer with real USDC (or set --yield-buffer-usdc=0 to skip — ` +
        `note redemptions may fail when the simulated yield exceeds rounding).`
    );
  }
  console.log(
    `💧 Topping up liquidity_vault with ${formatUsdc(topUp)} USDC ` +
      `(simulated-yield buffer, transferred from deployer's USDC ATA)...`
  );
  await transfer(
    provider.connection,
    payer,
    deployerAta.address,
    liquidityVault,
    payer,
    Number(topUp),
    [],
    { commitment: "confirmed" }
  );
  console.log(`   ✓ Buffer in place.`);
}

async function ensureProtocolInitialised(
  provider: anchor.AnchorProvider,
  agon: Program<AgonProtocol>,
  network: SupportedNetwork,
  feeRecipient: PublicKey
): Promise<void> {
  const globalConfigPda = findGlobalConfigPda(agon.programId);
  const existing = await provider.connection.getAccountInfo(globalConfigPda);
  if (existing) {
    console.log(`✅ Agon protocol already initialised (GlobalConfig: ${globalConfigPda.toBase58()})`);
    return;
  }
  console.log("⚙️ Initializing Agon protocol GlobalConfig + TokenRegistry...");
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [agon.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  );
  await agon.methods
    .initialize(chainIdForNetwork(network), 30, new anchor.BN(0), provider.wallet.publicKey)
    .accounts({
      feeRecipient,
      upgradeAuthority: provider.wallet.publicKey,
      program: agon.programId,
      programData: programDataPda,
    } as any)
    .rpc();
  await agon.methods
    .initializeTokenRegistry()
    .accounts({
      globalConfig: globalConfigPda,
      authority: provider.wallet.publicKey,
    } as any)
    .rpc();
  console.log(`   ✓ GlobalConfig + TokenRegistry initialised.`);
}

async function ensureAgUsdcRegistered(
  provider: anchor.AnchorProvider,
  agon: Program<AgonProtocol>,
  mockYield: Program<MockYield>,
  underlyingMint: PublicKey,
  reserve: PublicKey,
  shareMint: PublicKey,
  liquidityVault: PublicKey,
  protocolYieldBps: number
): Promise<{ yieldStrategy: PublicKey; shareVault: PublicKey }> {
  const yieldStrategyPda = findYieldStrategyPda(agon.programId, AG_USDC_TOKEN_ID);
  const shareVaultPda = findYieldShareVaultPda(agon.programId, AG_USDC_TOKEN_ID);

  const existing = await provider.connection.getAccountInfo(yieldStrategyPda);
  if (existing) {
    console.log(
      `🪙 agUSDC (token_id=${AG_USDC_TOKEN_ID}) already registered. YieldStrategy: ${yieldStrategyPda.toBase58()}`
    );
    return { yieldStrategy: yieldStrategyPda, shareVault: shareVaultPda };
  }

  console.log(
    `🪙 Registering agUSDC as token_id=${AG_USDC_TOKEN_ID} (protocol_yield_share_bps=${protocolYieldBps})...`
  );
  await agon.methods
    .registerYieldBearingToken(AG_USDC_TOKEN_ID, symbolBytes(AG_USDC_SYMBOL), protocolYieldBps)
    .accounts({
      underlyingMint,
      yieldProgram: mockYield.programId,
      reserve,
      shareMint,
      liquidityVault,
      authority: provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  console.log(`   ✓ YieldStrategy: ${yieldStrategyPda.toBase58()}`);
  console.log(`   ✓ Protocol cUSDC share_vault: ${shareVaultPda.toBase58()}`);
  return { yieldStrategy: yieldStrategyPda, shareVault: shareVaultPda };
}

// ---------------------------------------------------------------------------
// Per-user setup
// ---------------------------------------------------------------------------

interface DemoUser {
  label: string;
  keypair: Keypair;
  participantId: number;
  participantBucket: PublicKey;
  ownerIndexBucket: PublicKey;
  usdcAta: PublicKey;
}

async function airdropIfNeeded(
  connection: Connection,
  recipient: PublicKey,
  minLamports: number
): Promise<void> {
  const network = inferNetwork(connection.rpcEndpoint);
  if (network === "mainnet") return;
  const balance = await connection.getBalance(recipient);
  if (balance >= minLamports) return;
  if (network === "localnet") {
    const sig = await connection.requestAirdrop(recipient, minLamports);
    await connection.confirmTransaction(sig, "confirmed");
    return;
  }
  // Devnet airdrops can fail/rate-limit. Best-effort.
  try {
    const sig = await connection.requestAirdrop(recipient, minLamports);
    await connection.confirmTransaction(sig, "confirmed");
  } catch (err) {
    console.warn(
      `   ⚠️ Devnet airdrop failed for ${recipient.toBase58()} (${(err as Error).message}). ` +
        `Will attempt to fund from deployer instead.`
    );
  }
}

async function fundLamportsFromDeployer(
  provider: anchor.AnchorProvider,
  recipient: PublicKey,
  lamports: number
): Promise<void> {
  const balance = await provider.connection.getBalance(recipient);
  if (balance >= lamports) return;
  const ix = SystemProgram.transfer({
    fromPubkey: provider.wallet.publicKey,
    toPubkey: recipient,
    lamports: lamports - balance,
  });
  const tx = new Transaction().add(ix);
  await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
}

async function setupUser(
  provider: anchor.AnchorProvider,
  agon: Program<AgonProtocol>,
  underlyingMint: PublicKey,
  feeRecipient: PublicKey,
  label: string,
  perUserUsdc: bigint
): Promise<DemoUser> {
  const keypair = Keypair.generate();
  console.log(`\n👤 Setting up ${label}: ${keypair.publicKey.toBase58()}`);
  // ParticipantBucket alone needs ~0.069 SOL of rent (~9.7KB). Add ATA rents and tx fees and 0.15
  // SOL is a safe per-user budget. Deployer covers it via fundLamportsFromDeployer when devnet's
  // airdrop is rate-limited.
  const perUserLamports = (LAMPORTS_PER_SOL * 15) / 100; // 0.15 SOL
  await airdropIfNeeded(provider.connection, keypair.publicKey, perUserLamports);
  await fundLamportsFromDeployer(provider, keypair.publicKey, perUserLamports);

  const usdcAta = await fundUsdc(provider, underlyingMint, keypair.publicKey, perUserUsdc);
  console.log(`   ✓ USDC ATA: ${usdcAta.toBase58()} (funded with ${formatUsdc(perUserUsdc)} USDC)`);

  // Initialize participant.
  const globalConfigPda = findGlobalConfigPda(agon.programId);
  const config: any = await agon.account.globalConfig.fetch(globalConfigPda);
  const participantId = Number(config.nextParticipantId);
  const participantBucket = findParticipantBucketPda(agon.programId, participantId);
  const ownerIndexBucket = findOwnerIndexBucketPda(agon.programId, keypair.publicKey);

  await agon.methods
    .initializeParticipant(
      participantBucketIdForParticipantId(participantId),
      ownerIndexBucketIdForOwner(keypair.publicKey)
    )
    .accounts({
      participantBucket,
      ownerIndexBucket,
      feeRecipient,
      owner: keypair.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([keypair])
    .rpc();
  console.log(`   ✓ Participant id: ${participantId}`);

  return {
    label,
    keypair,
    participantId,
    participantBucket,
    ownerIndexBucket,
    usdcAta,
  };
}

// ---------------------------------------------------------------------------
// Reads / pretty printing
// ---------------------------------------------------------------------------

interface StrategyState {
  userIndexQ64: bigint;
  totalUserShares: bigint;
  protocolOwedUnderlying: bigint;
  lastSettledUnderlying: bigint;
}

async function fetchYieldStrategy(
  agon: Program<AgonProtocol>,
  yieldStrategyPda: PublicKey
): Promise<StrategyState> {
  const acc: any = await agon.account.yieldStrategy.fetch(yieldStrategyPda);
  return {
    userIndexQ64: BigInt(acc.userIndexQ64.toString()),
    totalUserShares: BigInt(acc.totalUserShares.toString()),
    protocolOwedUnderlying: BigInt(acc.protocolOwedUnderlying.toString()),
    lastSettledUnderlying: BigInt(acc.lastSettledUnderlying.toString()),
  };
}

async function readBucketBalanceForToken(
  agon: Program<AgonProtocol>,
  participantBucketPda: PublicKey,
  participantId: number,
  tokenId: number
): Promise<{ available: bigint; withdrawing: bigint; withdrawalUnlockAt: bigint }> {
  const info = await agon.provider.connection.getAccountInfo(participantBucketPda);
  if (!info) return { available: 0n, withdrawing: 0n, withdrawalUnlockAt: 0n };
  const data = info.data;
  const slotIndex = participantId % PARTICIPANT_BUCKET_SLOT_COUNT;
  const slotStart = PB_SLOTS_OFFSET + slotIndex * PB_SLOT_SPACE;
  if (data.length < slotStart + PB_SLOT_SPACE) {
    return { available: 0n, withdrawing: 0n, withdrawalUnlockAt: 0n };
  }
  const initialized = data.readUInt8(slotStart);
  if (initialized !== 1) {
    return { available: 0n, withdrawing: 0n, withdrawalUnlockAt: 0n };
  }
  const tokenBalancesStart = slotStart + PB_TOKEN_BALANCES_OFFSET_IN_SLOT;
  for (let i = 0; i < MAX_BUCKET_TOKEN_BALANCES; i += 1) {
    const entryStart = tokenBalancesStart + i * TOKEN_BALANCE_SPACE;
    const entryInitialized = data.readUInt8(entryStart);
    if (entryInitialized !== 1) continue;
    const entryTokenId = data.readUInt16LE(entryStart + 1);
    if (entryTokenId !== tokenId) continue;
    const available = data.readBigUInt64LE(entryStart + 3);
    const withdrawing = data.readBigUInt64LE(entryStart + 11);
    const unlockAt = data.readBigInt64LE(entryStart + 19);
    return {
      available,
      withdrawing,
      withdrawalUnlockAt: unlockAt,
    };
  }
  return { available: 0n, withdrawing: 0n, withdrawalUnlockAt: 0n };
}

async function getUsdcBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const acc = await getAccount(connection, ata, "confirmed");
    return acc.amount;
  } catch {
    return 0n;
  }
}

async function printSnapshot(
  label: string,
  agon: Program<AgonProtocol>,
  yieldStrategyPda: PublicKey,
  alice: DemoUser,
  bob: DemoUser,
  feeRecipientUsdcAta: PublicKey,
  shareVault: PublicKey
): Promise<void> {
  console.log(`\n📊 [${label}]`);
  const strategy = await fetchYieldStrategy(agon, yieldStrategyPda);
  console.log(
    `   strategy.user_index_q64        = ${strategy.userIndexQ64.toString()}` +
      ` (≈ ${(Number(strategy.userIndexQ64) / Number(Q64)).toFixed(8)}× per share)`
  );
  console.log(
    `   strategy.total_user_shares     = ${strategy.totalUserShares.toString()}`
  );
  console.log(
    `   strategy.last_settled_underlying = ${formatUsdc(strategy.lastSettledUnderlying)} USDC`
  );
  console.log(
    `   strategy.protocol_owed         = ${formatUsdc(strategy.protocolOwedUnderlying)} USDC`
  );

  const aliceBuckets = await readBucketBalanceForToken(
    agon,
    alice.participantBucket,
    alice.participantId,
    AG_USDC_TOKEN_ID
  );
  const bobBuckets = await readBucketBalanceForToken(
    agon,
    bob.participantBucket,
    bob.participantId,
    AG_USDC_TOKEN_ID
  );

  console.log(
    `   Alice agUSDC shares: avail=${aliceBuckets.available.toString()}, withdrawing=${aliceBuckets.withdrawing.toString()}` +
      ` (≈ ${formatUsdc(agSharesToUsdc({ userIndexQ64: strategy.userIndexQ64 }, aliceBuckets.available))} USDC available)`
  );
  console.log(
    `   Bob   agUSDC shares: avail=${bobBuckets.available.toString()}, withdrawing=${bobBuckets.withdrawing.toString()}` +
      ` (≈ ${formatUsdc(agSharesToUsdc({ userIndexQ64: strategy.userIndexQ64 }, bobBuckets.available))} USDC available)`
  );

  const aliceUsdc = await getUsdcBalance(agon.provider.connection, alice.usdcAta);
  const bobUsdc = await getUsdcBalance(agon.provider.connection, bob.usdcAta);
  const feeUsdc = await getUsdcBalance(agon.provider.connection, feeRecipientUsdcAta);
  console.log(`   Alice wallet USDC: ${formatUsdc(aliceUsdc)}`);
  console.log(`   Bob   wallet USDC: ${formatUsdc(bobUsdc)}`);
  console.log(`   Fee recipient USDC: ${formatUsdc(feeUsdc)}`);

  try {
    const shareVaultAcc = await getAccount(agon.provider.connection, shareVault, "confirmed");
    console.log(`   share_vault cUSDC supply: ${shareVaultAcc.amount.toString()}`);
  } catch (err) {
    console.log(`   share_vault not yet readable (${(err as Error).message})`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  console.log(`\n🚀 v6 yield-bearing demo starting on ${cli.network}`);

  const provider = loadProvider(cli.network);
  anchor.setProvider(provider);
  const network = inferNetwork(provider.connection.rpcEndpoint);

  console.log(`📡 RPC: ${provider.connection.rpcEndpoint}`);
  console.log(`🔑 Deployer/authority: ${provider.wallet.publicKey.toBase58()}`);
  if (!cli.bootstrapOnly) {
    const totalUsdcNeeded = cli.perUserUsdc * 2n + cli.yieldBufferUsdc;
    console.log(
      `💰 USDC budget — per-user=${formatUsdc(cli.perUserUsdc)}, ` +
        `yield-buffer=${formatUsdc(cli.yieldBufferUsdc)}, ` +
        `total=${formatUsdc(totalUsdcNeeded)} USDC.`
    );
  }

  const agon = loadAgonProgram(provider, network);
  const mockYield = loadMockYieldProgram(provider, network);
  console.log(`📦 agon-protocol program id: ${agon.programId.toBase58()}`);
  console.log(`📦 mock-yield   program id: ${mockYield.programId.toBase58()}`);

  // -------------------------------------------------------------------------
  // 1. Bootstrap (idempotent)
  // -------------------------------------------------------------------------
  const feeRecipient = cli.feeRecipient
    ? new PublicKey(cli.feeRecipient)
    : provider.wallet.publicKey;
  await ensureProtocolInitialised(provider, agon, network, feeRecipient);

  const underlyingMint = await resolveUsdcMint(provider, cli);
  const { reserve, shareMint, liquidityVault } = await ensureMockYieldReserve(
    provider,
    mockYield,
    underlyingMint,
    cli.apyInitialBps
  );
  // Pre-fund liquidity_vault with a USDC buffer so the simulated yield is actually redeemable.
  // - If deployer is the mint authority (localnet demo mint): mint the buffer.
  // - Otherwise (real USDC): transfer the buffer from the deployer's own USDC ATA.
  // Set --yield-buffer-usdc=0 to skip entirely (redemptions may fail if simulated yield exceeds
  // rounding-floor in mock-yield).
  await ensureLiquidityVaultYieldBuffer(
    provider,
    underlyingMint,
    liquidityVault,
    cli.yieldBufferUsdc
  );
  const { yieldStrategy, shareVault } = await ensureAgUsdcRegistered(
    provider,
    agon,
    mockYield,
    underlyingMint,
    reserve,
    shareMint,
    liquidityVault,
    cli.protocolYieldBps
  );

  // Ensure the fee_recipient has a USDC ATA so claim_protocol_yield_fee + execute_withdrawal can pay
  // out the protocol/fee USDC.
  const feeRecipientUsdcAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as any).payer as Keypair,
    underlyingMint,
    feeRecipient,
    false,
    "confirmed"
  );
  console.log(`💼 Fee recipient USDC ATA: ${feeRecipientUsdcAta.address.toBase58()}`);

  if (cli.bootstrapOnly) {
    console.log("\n✅ Bootstrap complete. Exiting (`--bootstrap-only`).");
    return;
  }

  // -------------------------------------------------------------------------
  // 2. User setup + deposits
  // -------------------------------------------------------------------------
  console.log("\n--- Phase 2: deposits ---");
  const alice = await setupUser(provider, agon, underlyingMint, feeRecipient, "Alice", cli.perUserUsdc);
  const bob = await setupUser(provider, agon, underlyingMint, feeRecipient, "Bob", cli.perUserUsdc);

  for (const user of [alice, bob]) {
    console.log(`\n💸 ${user.label} deposits ${formatUsdc(cli.perUserUsdc)} USDC -> agUSDC...`);
    await agon.methods
      .depositYieldBearing(AG_USDC_TOKEN_ID, new anchor.BN(cli.perUserUsdc.toString()))
      .accounts({
        participantBucket: user.participantBucket,
        ownerIndexBucket: user.ownerIndexBucket,
        yieldProgram: mockYield.programId,
        reserve,
        underlyingMint,
        shareMint,
        liquidityVault,
        shareVault,
        depositorUnderlying: user.usdcAta,
        depositor: user.keypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([user.keypair])
      .rpc();
    console.log(`   ✓ Deposit confirmed.`);
  }

  await printSnapshot(
    "after deposits",
    agon,
    yieldStrategy,
    alice,
    bob,
    feeRecipientUsdcAta.address,
    shareVault
  );

  // -------------------------------------------------------------------------
  // 3. Sleep + accrue, twice (with mid-run APY bump).
  // -------------------------------------------------------------------------
  console.log(
    `\n--- Phase 3: sleep ${cli.sleepSecsAfterDeposit}s, accrue at ${cli.apyInitialBps / 100}% APY ---`
  );
  await sleep(cli.sleepSecsAfterDeposit * 1000);

  await agon.methods
    .accrueYield()
    .accounts({
      yieldStrategy,
      yieldProgram: mockYield.programId,
      reserve,
      shareMint,
      shareVault,
    } as any)
    .rpc();
  console.log(`   ✓ accrue_yield #1`);
  await printSnapshot(
    `after first accrue (${cli.apyInitialBps / 100}% APY for ${cli.sleepSecsAfterDeposit}s)`,
    agon,
    yieldStrategy,
    alice,
    bob,
    feeRecipientUsdcAta.address,
    shareVault
  );

  console.log(
    `\n--- Phase 4: bump APY to ${cli.apyBumpedBps / 100}%, sleep ${cli.sleepSecsAfterApyBump}s, accrue ---`
  );
  await mockYield.methods
    .updateApyBps(cli.apyBumpedBps)
    .accounts({
      reserve,
      authority: provider.wallet.publicKey,
    } as any)
    .rpc();
  console.log(`   ✓ Reserve APY updated to ${cli.apyBumpedBps / 100}%`);

  await sleep(cli.sleepSecsAfterApyBump * 1000);
  await agon.methods
    .accrueYield()
    .accounts({
      yieldStrategy,
      yieldProgram: mockYield.programId,
      reserve,
      shareMint,
      shareVault,
    } as any)
    .rpc();
  console.log(`   ✓ accrue_yield #2`);
  await printSnapshot(
    `after second accrue (post APY bump)`,
    agon,
    yieldStrategy,
    alice,
    bob,
    feeRecipientUsdcAta.address,
    shareVault
  );

  // -------------------------------------------------------------------------
  // 5. Protocol claims its fee
  // -------------------------------------------------------------------------
  const strategyBeforeClaim = await fetchYieldStrategy(agon, yieldStrategy);
  if (strategyBeforeClaim.protocolOwedUnderlying > 0n) {
    console.log(
      `\n--- Phase 5: claim ${formatUsdc(strategyBeforeClaim.protocolOwedUnderlying)} USDC of protocol yield ---`
    );
    const claimAmount = strategyBeforeClaim.protocolOwedUnderlying;
    await agon.methods
      .claimProtocolYieldFee(AG_USDC_TOKEN_ID, new anchor.BN(claimAmount.toString()))
      .accounts({
        yieldStrategy,
        yieldProgram: mockYield.programId,
        reserve,
        underlyingMint,
        shareMint,
        liquidityVault,
        shareVault,
        feeRecipientTokenAccount: feeRecipientUsdcAta.address,
        feeRecipient: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
    console.log(`   ✓ Protocol yield claimed.`);
    await printSnapshot(
      "after claim_protocol_yield_fee",
      agon,
      yieldStrategy,
      alice,
      bob,
      feeRecipientUsdcAta.address,
      shareVault
    );
  } else {
    console.log("\n--- Phase 5: skipping claim_protocol_yield_fee (protocol_owed_underlying == 0) ---");
  }

  // -------------------------------------------------------------------------
  // 6. Users withdraw
  // -------------------------------------------------------------------------
  console.log("\n--- Phase 6: users withdraw all agUSDC -> USDC ---");
  for (const user of [alice, bob]) {
    const balances = await readBucketBalanceForToken(
      agon,
      user.participantBucket,
      user.participantId,
      AG_USDC_TOKEN_ID
    );
    const shares = balances.available;
    if (shares === 0n) {
      console.log(`   ⚠️ ${user.label} has no agUSDC shares to withdraw, skipping.`);
      continue;
    }
    console.log(`\n👤 ${user.label} withdrawing ${shares.toString()} agUSDC shares...`);
    await agon.methods
      .requestWithdrawalYieldBearing(
        AG_USDC_TOKEN_ID,
        new anchor.BN(shares.toString()),
        user.usdcAta
      )
      .accounts({
        participantBucket: user.participantBucket,
        ownerIndexBucket: user.ownerIndexBucket,
        withdrawalDestination: user.usdcAta,
        owner: user.keypair.publicKey,
      } as any)
      .signers([user.keypair])
      .rpc();
    console.log(`   ✓ Withdrawal requested.`);

    await agon.methods
      .executeWithdrawalYieldBearing(AG_USDC_TOKEN_ID, user.participantId)
      .accounts({
        participantBucket: user.participantBucket,
        yieldProgram: mockYield.programId,
        reserve,
        underlyingMint,
        shareMint,
        liquidityVault,
        shareVault,
        withdrawalDestination: user.usdcAta,
        feeRecipientTokenAccount: feeRecipientUsdcAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
    const finalUsdc = await getUsdcBalance(agon.provider.connection, user.usdcAta);
    console.log(`   ✓ Withdrawal executed. ${user.label} wallet USDC: ${formatUsdc(finalUsdc)}`);
  }

  await printSnapshot(
    "final",
    agon,
    yieldStrategy,
    alice,
    bob,
    feeRecipientUsdcAta.address,
    shareVault
  );

  console.log("\n🎉 Yield-bearing demo complete.");
}

main().catch((err) => {
  console.error("\n❌ Demo failed:", err);
  if (err && err.logs) {
    for (const log of err.logs) console.error("   ", log);
  }
  process.exit(1);
});
