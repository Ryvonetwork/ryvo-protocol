#!/usr/bin/env ts-node
/**
 * colosseum-channels-setup.ts
 *
 * One-time, idempotent setup that takes the 33 wallets registered by
 * scripts/colosseum-basic-setup.ts and brings them to the state required by
 * the BLS clearing-round demo (`/demo` page on the landing site):
 *
 *   1. Generates a deterministic BLS12-381 keypair per wallet (persisted to
 *      keys/colosseum-basic-devnet/bls/{label}.json so re-runs are no-ops).
 *   2. Calls `register_participant_bls_key` for any wallet whose participant
 *      slot still has `bls_scheme_version == 0` on-chain.
 *   3. Deposits USDC into the protocol vault for each agent (1..32) so that
 *      its `participant_bucket` slot has at least the configured deposit
 *      target. Tops up the difference if a partial deposit already exists.
 *   4. Creates the canonical channel between each agent and the merchant
 *      (participant 0). The merchant always co-signs to satisfy any inbound
 *      consent policy without needing to inspect it first.
 *   5. Locks USDC into the agent -> merchant lane on each channel up to the
 *      configured lock target.
 *   6. Creates and warms up an Address Lookup Table containing every
 *      participant bucket + channel bucket + a few fixed accounts that the
 *      demo's clearing-round transaction will reference.
 *   7. Writes a fresh manifest to deployments/devnet/colosseum-channels-setup.json
 *      that the gateway and the /demo route can consume.
 *
 * The script is safe to re-run; every step is gated by an on-chain read.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { RyvoProtocol } from "../target/types/ryvo_protocol";
import {
  BLS_PUBLIC_KEY_COMPRESSED_SIZE,
  BLS_SIGNATURE_COMPRESSED_SIZE,
  BlsKeypair,
  createBlsKeypairFromSeed,
  createBlsRegistrationMessage,
  signBlsMessage,
} from "../shared/protocol-bls";

const { loadProjectRpcEnv, resolveProjectRpcUrl } = require("./lib/rpc-env.cjs") as {
  loadProjectRpcEnv: (repoRoot?: string) => void;
  resolveProjectRpcUrl: (network?: string) => string;
};

loadProjectRpcEnv(process.cwd());

type Network = "devnet" | "mainnet" | "localnet" | "testnet";

type CliOptions = {
  network: Network;
  basicManifestPath: string;
  outputManifestPath: string;
  blsKeysDir: string;
  tokenId: number;
  depositAmount: bigint;
  lockAmount: bigint;
  merchantParticipantId: number;
  altAddress?: string;
  skipBls: boolean;
  skipDeposit: boolean;
  skipChannel: boolean;
  skipLock: boolean;
  skipAlt: boolean;
};

type WalletEntry = {
  label: string;
  role: "merchant" | "participant";
  keypairPath: string;
  publicKey: string;
  participantId: number;
  participantBucket: string;
  participantBucketId: number;
  ownerIndexBucket: string;
  ownerIndexBucketId: number;
};

type AgentManifestEntry = WalletEntry & {
  blsKeypairPath: string;
  blsPubkeyCompressedB64: string;
  channelBucket?: string;
  channelBucketId?: number;
  ownerUsdcAta?: string;
  depositedUsdc?: string;
  lockedUsdc?: string;
};

const GLOBAL_CONFIG_SEED = Buffer.from("global-config");
const TOKEN_REGISTRY_SEED = Buffer.from("token-registry");
const PARTICIPANT_BUCKET_SEED = Buffer.from("participant-bucket-v2");
const OWNER_INDEX_BUCKET_SEED = Buffer.from("owner-index-bucket-v2");
const CHANNEL_BUCKET_SEED = Buffer.from("channel-bucket-v2");
const VAULT_TOKEN_ACCOUNT_SEED = Buffer.from("vault-token-account");
const PARTICIPANT_BUCKET_SLOT_COUNT = 9;
const CHANNEL_BUCKET_SLOT_COUNT = 46n;
const OWNER_INDEX_BUCKET_COUNT = 1024;
const BLS_KEY_SEED_TAG = Buffer.from("ryvo-colosseum-bls-seed-v1", "utf8");

const DEFAULT_BASIC_MANIFEST = "deployments/devnet/colosseum-basic-setup.json";
const DEFAULT_OUTPUT_MANIFEST =
  "deployments/devnet/colosseum-channels-setup.json";
const DEFAULT_BLS_KEYS_DIR = "keys/colosseum-basic-devnet/bls";
const DEFAULT_TOKEN_ID = 1;
const DEFAULT_DEPOSIT_USDC = 1_500_000n; // 1.5 USDC (6 decimals)
const DEFAULT_LOCK_USDC = 1_000_000n; // 1.0 USDC (6 decimals)
const DEFAULT_MERCHANT_PARTICIPANT_ID = 0;
const DEFAULT_DEPLOYER_MIN_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
const DEFAULT_AGENT_MIN_LAMPORTS = 0.02 * LAMPORTS_PER_SOL;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    network: "devnet",
    basicManifestPath: DEFAULT_BASIC_MANIFEST,
    outputManifestPath: DEFAULT_OUTPUT_MANIFEST,
    blsKeysDir: DEFAULT_BLS_KEYS_DIR,
    tokenId: DEFAULT_TOKEN_ID,
    depositAmount: DEFAULT_DEPOSIT_USDC,
    lockAmount: DEFAULT_LOCK_USDC,
    merchantParticipantId: DEFAULT_MERCHANT_PARTICIPANT_ID,
    skipBls: false,
    skipDeposit: false,
    skipChannel: false,
    skipLock: false,
    skipAlt: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const eqIndex = arg.indexOf("=");
    const key = arg.slice(2, eqIndex >= 0 ? eqIndex : undefined);
    let value: string | undefined =
      eqIndex >= 0 ? arg.slice(eqIndex + 1) : argv[i + 1];
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
      case "manifest":
      case "basic-manifest":
        if (value) options.basicManifestPath = value;
        break;
      case "output":
      case "output-manifest":
        if (value) options.outputManifestPath = value;
        break;
      case "bls-keys-dir":
        if (value) options.blsKeysDir = value;
        break;
      case "token-id":
        if (value) options.tokenId = parseInt(value, 10);
        break;
      case "deposit-amount":
        if (value) options.depositAmount = BigInt(value);
        break;
      case "lock-amount":
        if (value) options.lockAmount = BigInt(value);
        break;
      case "merchant-participant-id":
        if (value) options.merchantParticipantId = parseInt(value, 10);
        break;
      case "alt-address":
        if (value) options.altAddress = value;
        break;
      case "skip-bls":
        options.skipBls = true;
        break;
      case "skip-deposit":
        options.skipDeposit = true;
        break;
      case "skip-channel":
        options.skipChannel = true;
        break;
      case "skip-lock":
        options.skipLock = true;
        break;
      case "skip-alt":
        options.skipAlt = true;
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

function loadOrCreateBlsKeypair(
  filePath: string,
  ownerSecretKey: Uint8Array
): BlsKeypair {
  if (fs.existsSync(filePath)) {
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      secretScalarHex: string;
      publicKeyCompressedHex: string;
    };
    return {
      secretScalar: BigInt(`0x${stored.secretScalarHex}`),
      publicKeyCompressed: Buffer.from(stored.publicKeyCompressedHex, "hex"),
    };
  }

  const seed = createHash("sha256")
    .update(BLS_KEY_SEED_TAG)
    .update(Buffer.from(ownerSecretKey))
    .digest();
  const keypair = createBlsKeypairFromSeed(seed);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        secretScalarHex: keypair.secretScalar
          .toString(16)
          .padStart(64, "0"),
        publicKeyCompressedHex: Buffer.from(
          keypair.publicKeyCompressed
        ).toString("hex"),
      },
      null,
      2
    )
  );
  fs.chmodSync(filePath, 0o600);
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
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u32Le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

function u64Le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function participantBucketIdForParticipantId(participantId: number): number {
  return Math.floor(participantId / PARTICIPANT_BUCKET_SLOT_COUNT);
}

function ownerIndexBucketIdForOwner(owner: PublicKey): number {
  const digest = createHash("sha256").update(owner.toBuffer()).digest();
  return digest.readUInt32LE(0) % OWNER_INDEX_BUCKET_COUNT;
}

function pairOrdinal(lower: number, higher: number): bigint {
  const h = BigInt(higher);
  return (h * (h - 1n)) / 2n + BigInt(lower);
}

function channelBucketIdForPair(payerId: number, payeeId: number): bigint {
  const lower = BigInt(Math.min(payerId, payeeId));
  const higher = BigInt(Math.max(payerId, payeeId));
  return pairOrdinal(Number(lower), Number(higher)) / CHANNEL_BUCKET_SLOT_COUNT;
}

function findGlobalConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([GLOBAL_CONFIG_SEED], programId)[0];
}

function findTokenRegistryPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([TOKEN_REGISTRY_SEED], programId)[0];
}

function findParticipantBucketPda(
  programId: PublicKey,
  participantId: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PARTICIPANT_BUCKET_SEED, u32Le(participantBucketIdForParticipantId(participantId))],
    programId
  )[0];
}

function findOwnerIndexBucketPda(
  programId: PublicKey,
  owner: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [OWNER_INDEX_BUCKET_SEED, u32Le(ownerIndexBucketIdForOwner(owner))],
    programId
  )[0];
}

function findChannelBucketPda(
  programId: PublicKey,
  tokenId: number,
  payerId: number,
  payeeId: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      CHANNEL_BUCKET_SEED,
      u16Le(tokenId),
      u64Le(channelBucketIdForPair(payerId, payeeId)),
    ],
    programId
  )[0];
}

function findVaultTokenAccountPda(
  programId: PublicKey,
  tokenId: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [VAULT_TOKEN_ACCOUNT_SEED, u16Le(tokenId)],
    programId
  )[0];
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
  console.log(
    `  funded ${recipient.toBase58().slice(0, 8)}... with ${(missing / LAMPORTS_PER_SOL).toFixed(4)} SOL`
  );
}

// Layout constants for ParticipantBucket / ParticipantBucketSlot, mirroring
// the offsets defined in `programs/ryvo-protocol/src/state/bucket_state.rs`.
// We decode by hand because these accounts are CPI-init and not in the IDL.
const PB_DISCRIMINATOR = Buffer.from([107, 145, 82, 194, 47, 231, 201, 105]);
const PB_SLOTS_OFFSET = 13; // 8 disc + 4 bucket_id + 1 bump
const PB_TOKEN_ENTRY_SPACE = 1 + 2 + 8 + 8 + 8 + 32; // = 59
const PB_TOKEN_BALANCES_OFFSET = 135;
const PB_SLOT_INITIALIZED_OFFSET = 0;
const PB_SLOT_OWNER_OFFSET = 1;
const PB_SLOT_PARTICIPANT_ID_OFFSET = 33;
const PB_SLOT_BLS_SCHEME_VERSION_OFFSET = 38;
const PB_SLOT_BLS_PUBKEY_OFFSET = 39;
const PB_TOKEN_ENTRY_INITIALIZED_OFFSET = 0;
const PB_TOKEN_ENTRY_TOKEN_ID_OFFSET = 1;
const PB_TOKEN_ENTRY_AVAILABLE_OFFSET = 3;
const PB_MAX_TOKEN_BALANCES = 16;
const PB_SLOT_SPACE =
  1 + 32 + 4 + 1 + 1 + 96 + PB_MAX_TOKEN_BALANCES * PB_TOKEN_ENTRY_SPACE; // = 1079

// Layout constants for ChannelBucket / ChannelBucketSlot.
const CB_DISCRIMINATOR = Buffer.from([171, 219, 130, 228, 148, 242, 103, 148]);
const CB_SLOTS_OFFSET = 19; // 8 disc + 2 token_id + 8 bucket_id + 1 bump
const CB_DIRECTIONAL_LANE_SPACE = 1 + 8 + 8 + 32 + 8 + 8 + 32 + 8; // = 105
const CB_SLOT_SPACE = 1 + 4 + 4 + 2 * CB_DIRECTIONAL_LANE_SPACE; // = 219
const CB_SLOT_INITIALIZED_OFFSET = 0;
const CB_SLOT_LOWER_OFFSET = 1;
const CB_SLOT_HIGHER_OFFSET = 5;
const CB_LOWER_TO_HIGHER_LANE_OFFSET = 9;
const CB_HIGHER_TO_LOWER_LANE_OFFSET = 9 + CB_DIRECTIONAL_LANE_SPACE;
const CB_LANE_INITIALIZED_OFFSET = 0;
const CB_LANE_SETTLED_CUMULATIVE_OFFSET = 1;
const CB_LANE_LOCKED_BALANCE_OFFSET = 9;

type ParticipantBucketSlotState = {
  initialized: boolean;
  ownerPubkey: PublicKey;
  participantId: number;
  blsSchemeVersion: number;
  blsPubkeyCompressed: Buffer;
  tokenAvailableBalance: bigint;
};

async function readParticipantSlot(
  connection: anchor.web3.Connection,
  participantBucketPda: PublicKey,
  participantId: number,
  tokenId: number
): Promise<ParticipantBucketSlotState | null> {
  const account = await connection.getAccountInfo(participantBucketPda, "confirmed");
  if (!account) return null;
  const data = account.data;

  if (!data.subarray(0, 8).equals(PB_DISCRIMINATOR)) {
    throw new Error(
      `account ${participantBucketPda.toBase58()} does not have the ParticipantBucket discriminator`
    );
  }

  const slotIndex = participantId % PARTICIPANT_BUCKET_SLOT_COUNT;
  const slotOffset = PB_SLOTS_OFFSET + slotIndex * PB_SLOT_SPACE;
  if (slotOffset + PB_SLOT_SPACE > data.length) {
    throw new Error(
      `ParticipantBucket data too short: have ${data.length}, need ${slotOffset + PB_SLOT_SPACE}`
    );
  }

  const initialized = data.readUInt8(slotOffset + PB_SLOT_INITIALIZED_OFFSET) === 1;
  const ownerPubkey = new PublicKey(
    data.subarray(slotOffset + PB_SLOT_OWNER_OFFSET, slotOffset + PB_SLOT_OWNER_OFFSET + 32)
  );
  const slotParticipantId = data.readUInt32LE(slotOffset + PB_SLOT_PARTICIPANT_ID_OFFSET);
  const blsSchemeVersion = data.readUInt8(
    slotOffset + PB_SLOT_BLS_SCHEME_VERSION_OFFSET
  );
  const blsPubkeyCompressed = Buffer.from(
    data.subarray(
      slotOffset + PB_SLOT_BLS_PUBKEY_OFFSET,
      slotOffset + PB_SLOT_BLS_PUBKEY_OFFSET + BLS_PUBLIC_KEY_COMPRESSED_SIZE
    )
  );

  // Walk the 16 fixed-size token-balance entries to find the requested tokenId.
  let tokenAvailableBalance = 0n;
  if (initialized) {
    const tokenBalancesOffset = slotOffset + PB_TOKEN_BALANCES_OFFSET;
    for (let i = 0; i < PB_MAX_TOKEN_BALANCES; i += 1) {
      const entryOffset = tokenBalancesOffset + i * PB_TOKEN_ENTRY_SPACE;
      const entryInitialized =
        data.readUInt8(entryOffset + PB_TOKEN_ENTRY_INITIALIZED_OFFSET) === 1;
      if (!entryInitialized) continue;
      const entryTokenId = data.readUInt16LE(entryOffset + PB_TOKEN_ENTRY_TOKEN_ID_OFFSET);
      if (entryTokenId !== tokenId) continue;
      tokenAvailableBalance = data.readBigUInt64LE(
        entryOffset + PB_TOKEN_ENTRY_AVAILABLE_OFFSET
      );
      break;
    }
  }

  return {
    initialized,
    ownerPubkey,
    participantId: slotParticipantId,
    blsSchemeVersion,
    blsPubkeyCompressed,
    tokenAvailableBalance,
  };
}

async function readTokenAvailableBalance(
  connection: anchor.web3.Connection,
  participantBucketPda: PublicKey,
  participantId: number,
  tokenId: number
): Promise<bigint> {
  const slot = await readParticipantSlot(
    connection,
    participantBucketPda,
    participantId,
    tokenId
  );
  return slot ? slot.tokenAvailableBalance : 0n;
}

async function readDirectionalLockedBalance(
  connection: anchor.web3.Connection,
  channelBucketPda: PublicKey,
  payerId: number,
  payeeId: number
): Promise<{ initialized: boolean; lockedBalance: bigint; settledCumulative: bigint }> {
  const account = await connection.getAccountInfo(channelBucketPda, "confirmed");
  if (!account) return { initialized: false, lockedBalance: 0n, settledCumulative: 0n };
  const data = account.data;

  if (!data.subarray(0, 8).equals(CB_DISCRIMINATOR)) {
    return { initialized: false, lockedBalance: 0n, settledCumulative: 0n };
  }

  const lower = Math.min(payerId, payeeId);
  const higher = Math.max(payerId, payeeId);
  const slotIndex = Number(
    pairOrdinal(lower, higher) % CHANNEL_BUCKET_SLOT_COUNT
  );

  const slotOffset = CB_SLOTS_OFFSET + slotIndex * CB_SLOT_SPACE;
  if (slotOffset + CB_SLOT_SPACE > data.length) {
    return { initialized: false, lockedBalance: 0n, settledCumulative: 0n };
  }

  const slotInitialized =
    data.readUInt8(slotOffset + CB_SLOT_INITIALIZED_OFFSET) === 1;
  const slotLower = data.readUInt32LE(slotOffset + CB_SLOT_LOWER_OFFSET);
  const slotHigher = data.readUInt32LE(slotOffset + CB_SLOT_HIGHER_OFFSET);

  if (!slotInitialized || slotLower !== lower || slotHigher !== higher) {
    return { initialized: false, lockedBalance: 0n, settledCumulative: 0n };
  }

  const laneOffset =
    payerId === lower
      ? slotOffset + CB_LOWER_TO_HIGHER_LANE_OFFSET
      : slotOffset + CB_HIGHER_TO_LOWER_LANE_OFFSET;

  const laneInitialized = data.readUInt8(laneOffset + CB_LANE_INITIALIZED_OFFSET) === 1;
  if (!laneInitialized) {
    return { initialized: false, lockedBalance: 0n, settledCumulative: 0n };
  }

  const settledCumulative = data.readBigUInt64LE(
    laneOffset + CB_LANE_SETTLED_CUMULATIVE_OFFSET
  );
  const lockedBalance = data.readBigUInt64LE(
    laneOffset + CB_LANE_LOCKED_BALANCE_OFFSET
  );

  return { initialized: true, lockedBalance, settledCumulative };
}

async function registerBlsKeyForWallet(
  program: Program<RyvoProtocol>,
  ownerKeypair: Keypair,
  participantId: number,
  participantBucketPda: PublicKey,
  ownerIndexBucketPda: PublicKey,
  blsKeypair: BlsKeypair,
  messageDomain: Buffer
): Promise<void> {
  const popMessage = createBlsRegistrationMessage({
    participantId,
    owner: ownerKeypair.publicKey,
    blsPubkeyCompressed: blsKeypair.publicKeyCompressed,
    messageDomain,
  });
  const popSignature = signBlsMessage(blsKeypair, popMessage);

  await program.methods
    .registerParticipantBlsKey(
      [...blsKeypair.publicKeyCompressed] as any,
      [...popSignature] as any
    )
    .accounts({
      globalConfig: findGlobalConfigPda(program.programId),
      owner: ownerKeypair.publicKey,
      participantBucket: participantBucketPda,
      ownerIndexBucket: ownerIndexBucketPda,
    } as any)
    .signers([ownerKeypair])
    .rpc();
}

async function depositForWallet(
  program: Program<RyvoProtocol>,
  ownerKeypair: Keypair,
  participantBucketPda: PublicKey,
  ownerIndexBucketPda: PublicKey,
  ownerUsdcAta: PublicKey,
  vaultTokenAccount: PublicKey,
  tokenId: number,
  amount: bigint
): Promise<void> {
  await program.methods
    .deposit(tokenId, new anchor.BN(amount.toString()))
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      globalConfig: findGlobalConfigPda(program.programId),
      participantBucket: participantBucketPda,
      ownerIndexBucket: ownerIndexBucketPda,
      ownerTokenAccount: ownerUsdcAta,
      vaultTokenAccount,
      owner: ownerKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([ownerKeypair])
    .rpc();
}

async function createChannelForPair(
  program: Program<RyvoProtocol>,
  payerKeypair: Keypair,
  merchantKeypair: Keypair,
  payerParticipantId: number,
  merchantParticipantId: number,
  payerBucket: PublicKey,
  merchantBucket: PublicKey,
  payerOwnerIndexBucket: PublicKey,
  channelBucket: PublicKey,
  tokenId: number
): Promise<void> {
  const lower = Math.min(payerParticipantId, merchantParticipantId);
  const higher = Math.max(payerParticipantId, merchantParticipantId);
  const channelBucketId = channelBucketIdForPair(payerParticipantId, merchantParticipantId);

  await program.methods
    .createChannel(
      tokenId,
      lower,
      higher,
      new anchor.BN(channelBucketId.toString()),
      null
    )
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      payerBucket,
      payeeBucket: merchantBucket,
      ownerIndexBucket: payerOwnerIndexBucket,
      payeeOwner: merchantKeypair.publicKey,
      channelBucket,
      owner: payerKeypair.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([payerKeypair, merchantKeypair])
    .rpc();
}

async function lockChannelFundsForPair(
  program: Program<RyvoProtocol>,
  payerKeypair: Keypair,
  merchantParticipantId: number,
  payerBucket: PublicKey,
  payerOwnerIndexBucket: PublicKey,
  channelBucket: PublicKey,
  tokenId: number,
  amount: bigint
): Promise<void> {
  await program.methods
    .lockChannelFunds(
      tokenId,
      merchantParticipantId,
      new anchor.BN(amount.toString())
    )
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      payerBucket,
      channelBucket,
      ownerIndexBucket: payerOwnerIndexBucket,
      owner: payerKeypair.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([payerKeypair])
    .rpc();
}

async function buildAddressLookupTable(
  provider: anchor.AnchorProvider,
  addresses: PublicKey[]
): Promise<PublicKey> {
  const payer = (provider.wallet as any).payer as Keypair;
  const recentSlot =
    (await provider.connection.getSlot("confirmed")) - 1;

  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });

  await sendAndConfirmTransaction(
    provider.connection,
    new Transaction().add(createIx),
    [payer],
    { commitment: "confirmed" }
  );

  // Extend in chunks of 20 to stay well under tx-size limits.
  const CHUNK = 20;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const slice = addresses.slice(i, i + CHUNK);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses: slice,
    });
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(extendIx),
      [payer],
      { commitment: "confirmed" }
    );
  }

  // Wait for the table to be active. Per docs, an ALT becomes usable on the
  // slot AFTER the slot in which extendLookupTable lands. Sleeping for a few
  // slots avoids a "lookup table is invalid for this slot" error in the demo.
  await sleep(2_000);

  return lookupTableAddress;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = loadProvider(options.network);
  anchor.setProvider(provider);
  const program = loadProgram(provider, options.network);

  const basicManifestPath = path.resolve(options.basicManifestPath);
  if (!fs.existsSync(basicManifestPath)) {
    throw new Error(
      `basic manifest not found at ${basicManifestPath}; run colosseum-basic-setup.ts first`
    );
  }
  const basicManifest = JSON.parse(fs.readFileSync(basicManifestPath, "utf8"));

  const merchantEntry = basicManifest.wallets.merchant as WalletEntry;
  const participantEntries = basicManifest.wallets.participants as WalletEntry[];
  const allEntries: WalletEntry[] = [merchantEntry, ...participantEntries];

  if (
    merchantEntry.participantId !== options.merchantParticipantId
  ) {
    throw new Error(
      `merchant participantId in manifest (${merchantEntry.participantId}) does not match --merchant-participant-id (${options.merchantParticipantId})`
    );
  }

  // Resolve mint + on-chain addresses we need throughout.
  const tokenRegistryPda = findTokenRegistryPda(program.programId);
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const globalConfig: any = await program.account.globalConfig.fetch(
    globalConfigPda
  );
  const messageDomain = Buffer.from(globalConfig.messageDomain);
  const vaultTokenAccount = findVaultTokenAccountPda(
    program.programId,
    options.tokenId
  );
  const tokenRegistry: any = await program.account.tokenRegistry.fetch(
    tokenRegistryPda
  );
  const tokenEntry = tokenRegistry.tokens.find(
    (t: any) => Number(t.id) === options.tokenId
  );
  if (!tokenEntry) {
    throw new Error(`token id ${options.tokenId} not registered on-chain`);
  }
  const usdcMint = new PublicKey(tokenEntry.mint.toString());

  console.log(`Network: ${options.network}`);
  console.log(`RPC:     ${provider.connection.rpcEndpoint}`);
  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`Mint:    ${usdcMint.toBase58()} (token_id=${options.tokenId})`);
  console.log(
    `Domain:  0x${messageDomain.toString("hex")}  ChainId=${Number(globalConfig.chainId)}`
  );

  const blsKeysDir = path.resolve(options.blsKeysDir);
  fs.mkdirSync(blsKeysDir, { recursive: true });

  const enrichedAgents: AgentManifestEntry[] = [];

  for (const entry of allEntries) {
    const ownerKeypair = loadKeypair(path.resolve(entry.keypairPath));
    const ownerPubkey = ownerKeypair.publicKey;

    if (ownerPubkey.toBase58() !== entry.publicKey) {
      throw new Error(
        `keypair mismatch for ${entry.label}: file pubkey ${ownerPubkey.toBase58()} != manifest ${entry.publicKey}`
      );
    }

    // Recompute PDAs from scratch (manifest is authoritative for participantId
    // only; everything else is derived).
    const participantBucketPda = findParticipantBucketPda(
      program.programId,
      entry.participantId
    );
    const ownerIndexBucketPda = findOwnerIndexBucketPda(
      program.programId,
      ownerPubkey
    );

    const blsKeyPath = path.join(blsKeysDir, `${entry.label}.json`);
    const blsKeypair = loadOrCreateBlsKeypair(blsKeyPath, ownerKeypair.secretKey);

    console.log(
      `\n[${entry.label}] participantId=${entry.participantId} owner=${ownerPubkey.toBase58().slice(0, 8)}...`
    );

    // Make sure the wallet has enough SOL to pay for its own ix fees.
    const minSol = entry.role === "merchant" ? DEFAULT_DEPLOYER_MIN_LAMPORTS : DEFAULT_AGENT_MIN_LAMPORTS;
    await ensureLamports(provider, ownerPubkey, minSol);

    // Step 1 — BLS registration.
    if (!options.skipBls) {
      const slot = await readParticipantSlot(
        provider.connection,
        participantBucketPda,
        entry.participantId,
        options.tokenId
      );
      if (slot && slot.initialized && slot.blsSchemeVersion !== 0) {
        if (
          !slot.blsPubkeyCompressed.equals(blsKeypair.publicKeyCompressed)
        ) {
          throw new Error(
            `BLS key already registered on-chain for ${entry.label} but does not match local keypair file ${blsKeyPath}. Either delete the local file or rotate is not yet implemented.`
          );
        }
        console.log(`  bls: already registered`);
      } else {
        await registerBlsKeyForWallet(
          program,
          ownerKeypair,
          entry.participantId,
          participantBucketPda,
          ownerIndexBucketPda,
          blsKeypair,
          messageDomain
        );
        console.log(`  bls: registered`);
      }
    }

    enrichedAgents.push({
      ...entry,
      participantBucket: participantBucketPda.toBase58(),
      participantBucketId: participantBucketIdForParticipantId(entry.participantId),
      ownerIndexBucket: ownerIndexBucketPda.toBase58(),
      ownerIndexBucketId: ownerIndexBucketIdForOwner(ownerPubkey),
      blsKeypairPath: relPath(blsKeyPath),
      blsPubkeyCompressedB64: Buffer.from(
        blsKeypair.publicKeyCompressed
      ).toString("base64"),
    });
  }

  // Resolve merchant separately for channel-creation co-signing.
  const merchantKeypair = loadKeypair(path.resolve(merchantEntry.keypairPath));
  const merchantBucketPda = findParticipantBucketPda(
    program.programId,
    merchantEntry.participantId
  );

  // Steps 2-4 happen for every agent (skip merchant in payer role).
  for (const agent of enrichedAgents) {
    if (agent.role === "merchant") continue;

    const ownerKeypair = loadKeypair(path.resolve(agent.keypairPath));
    const participantBucketPda = new PublicKey(agent.participantBucket);
    const ownerIndexBucketPda = new PublicKey(agent.ownerIndexBucket);
    const ownerUsdcAta = getAssociatedTokenAddressSync(usdcMint, ownerKeypair.publicKey);
    agent.ownerUsdcAta = ownerUsdcAta.toBase58();

    console.log(
      `\n[${agent.label}] flowing setup for agent ${agent.participantId}`
    );

    // Step 3 (read first) — Channel creation. We compute the channel PDA up
    // front so step 2 can factor existing locked balance into its idempotency
    // check (locked funds still count toward the protocol-side deposit total).
    const channelBucketPda = findChannelBucketPda(
      program.programId,
      options.tokenId,
      agent.participantId,
      merchantEntry.participantId
    );
    agent.channelBucket = channelBucketPda.toBase58();
    agent.channelBucketId = Number(
      channelBucketIdForPair(agent.participantId, merchantEntry.participantId)
    );

    const existingLane = await readDirectionalLockedBalance(
      provider.connection,
      channelBucketPda,
      agent.participantId,
      merchantEntry.participantId
    );

    // Step 2 — Deposit.
    if (!options.skipDeposit) {
      const currentAvailable = await readTokenAvailableBalance(
        provider.connection,
        participantBucketPda,
        agent.participantId,
        options.tokenId
      );
      const totalInProtocol = currentAvailable + existingLane.lockedBalance;
      if (totalInProtocol >= options.depositAmount) {
        console.log(
          `  deposit: already at ${formatUsdc(totalInProtocol)} USDC in protocol (avail=${formatUsdc(currentAvailable)} + locked=${formatUsdc(existingLane.lockedBalance)}) >= target ${formatUsdc(options.depositAmount)}`
        );
        agent.depositedUsdc = totalInProtocol.toString();
      } else {
        const topUp = options.depositAmount - totalInProtocol;
        await depositForWallet(
          program,
          ownerKeypair,
          participantBucketPda,
          ownerIndexBucketPda,
          ownerUsdcAta,
          vaultTokenAccount,
          options.tokenId,
          topUp
        );
        const finalTotal = totalInProtocol + topUp;
        console.log(
          `  deposit: +${formatUsdc(topUp)} USDC (now ${formatUsdc(finalTotal)} in protocol)`
        );
        agent.depositedUsdc = finalTotal.toString();
      }
    }

    if (!options.skipChannel) {
      if (existingLane.initialized) {
        console.log(
          `  channel: already exists (locked=${formatUsdc(existingLane.lockedBalance)} USDC)`
        );
        agent.lockedUsdc = existingLane.lockedBalance.toString();
      } else {
        await createChannelForPair(
          program,
          ownerKeypair,
          merchantKeypair,
          agent.participantId,
          merchantEntry.participantId,
          participantBucketPda,
          merchantBucketPda,
          ownerIndexBucketPda,
          channelBucketPda,
          options.tokenId
        );
        console.log(`  channel: created`);
        agent.lockedUsdc = "0";
      }
    }

    // Step 4 — Lock funds.
    if (!options.skipLock) {
      const lane = await readDirectionalLockedBalance(
        provider.connection,
        channelBucketPda,
        agent.participantId,
        merchantEntry.participantId
      );
      if (lane.lockedBalance >= options.lockAmount) {
        console.log(
          `  lock: already at ${formatUsdc(lane.lockedBalance)} USDC (>= target ${formatUsdc(options.lockAmount)})`
        );
        agent.lockedUsdc = lane.lockedBalance.toString();
      } else {
        const topUp = options.lockAmount - lane.lockedBalance;
        await lockChannelFundsForPair(
          program,
          ownerKeypair,
          merchantEntry.participantId,
          participantBucketPda,
          ownerIndexBucketPda,
          channelBucketPda,
          options.tokenId,
          topUp
        );
        const finalLocked = lane.lockedBalance + topUp;
        console.log(
          `  lock: +${formatUsdc(topUp)} USDC (now ${formatUsdc(finalLocked)})`
        );
        agent.lockedUsdc = finalLocked.toString();
      }
    }
  }

  // Step 5 — Address Lookup Table.
  let lookupTableAddress: string | undefined = options.altAddress;
  if (!options.skipAlt && !lookupTableAddress) {
    const uniqueParticipantBuckets = Array.from(
      new Set(enrichedAgents.map((a) => a.participantBucket))
    ).map((s) => new PublicKey(s));
    const uniqueChannelBuckets = Array.from(
      new Set(
        enrichedAgents
          .filter((a) => a.channelBucket)
          .map((a) => a.channelBucket as string)
      )
    ).map((s) => new PublicKey(s));

    const fixedAccounts = [
      tokenRegistryPda,
      globalConfigPda,
      SYSVAR_INSTRUCTIONS_PUBKEY,
      vaultTokenAccount,
    ];

    const allAddresses = [
      ...uniqueParticipantBuckets,
      ...uniqueChannelBuckets,
      ...fixedAccounts,
    ];
    console.log(
      `\nBuilding ALT with ${uniqueParticipantBuckets.length} participant buckets + ${uniqueChannelBuckets.length} channel buckets + ${fixedAccounts.length} fixed accounts`
    );
    const alt = await buildAddressLookupTable(provider, allAddresses);
    lookupTableAddress = alt.toBase58();
    console.log(`  alt: ${lookupTableAddress}`);
  } else if (lookupTableAddress) {
    console.log(`\nReusing existing ALT: ${lookupTableAddress}`);
  } else {
    console.log(`\nSkipping ALT creation (--skip-alt)`);
  }

  // Step 6 — Write manifest.
  const merchantOut = enrichedAgents.find((a) => a.role === "merchant");
  const agentsOut = enrichedAgents.filter((a) => a.role === "participant");

  const manifest = {
    generatedAt: new Date().toISOString(),
    network: options.network,
    rpcUrl: provider.connection.rpcEndpoint,
    program: {
      ryvoProtocol: program.programId.toBase58(),
      globalConfig: globalConfigPda.toBase58(),
      tokenRegistry: tokenRegistryPda.toBase58(),
      messageDomainHex: messageDomain.toString("hex"),
      chainId: Number(globalConfig.chainId),
    },
    token: {
      tokenId: options.tokenId,
      mint: usdcMint.toBase58(),
      symbol: "USDC",
      decimals: Number(tokenEntry.decimals),
      vaultTokenAccount: vaultTokenAccount.toBase58(),
    },
    blsKeysDirectory: relPath(blsKeysDir),
    blsKeysNote:
      "BLS secret keys live alongside the basic-setup keys directory and are gitignored.",
    targets: {
      depositPerAgentBaseUnits: options.depositAmount.toString(),
      lockPerAgentBaseUnits: options.lockAmount.toString(),
    },
    lookupTable: lookupTableAddress
      ? { address: lookupTableAddress }
      : null,
    merchant: merchantOut,
    agents: agentsOut,
  };

  const outputPath = path.resolve(options.outputManifestPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nWrote channels manifest to ${relPath(outputPath)}`);
}

function formatUsdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
