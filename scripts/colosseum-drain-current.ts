#!/usr/bin/env ts-node

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { RyvoProtocol } from "../target/types/ryvo_protocol";

const { loadProjectRpcEnv, resolveProjectRpcUrl } =
  require("./lib/rpc-env.cjs") as {
    loadProjectRpcEnv: (repoRoot?: string) => void;
    resolveProjectRpcUrl: (network?: string) => string;
  };

loadProjectRpcEnv(process.cwd());

type Network = "devnet" | "mainnet" | "localnet" | "testnet";

type CliOptions = {
  network: Network;
  basicManifestPath: string;
  channelsManifestPath: string;
  outputPath: string;
  sweepSol: boolean;
};

type WalletEntry = {
  label: string;
  role: "merchant" | "participant";
  keypairPath: string;
  publicKey: string;
  participantId: number;
  participantBucket: string;
  ownerIndexBucket: string;
};

type TokenManifestEntry = {
  tokenId: number;
  symbol: string;
  kind?: string;
  mint: string;
  decimals: number;
  vaultTokenAccount?: string;
  underlyingMint?: string;
  yieldProgram?: string;
  reserve?: string;
  shareMint?: string;
  shareVault?: string;
  liquidityVault?: string;
};

type ParticipantBalance = {
  available: bigint;
  withdrawing: bigint;
  withdrawalUnlockAt: bigint;
  withdrawalDestination: PublicKey;
};

const DEFAULT_BASIC_MANIFEST = "deployments/devnet/colosseum-basic-setup.json";
const DEFAULT_CHANNELS_MANIFEST =
  "deployments/devnet/colosseum-channels-setup.json";
const DEFAULT_OUTPUT = "deployments/devnet/colosseum-drain-current.json";

const GLOBAL_CONFIG_SEED = Buffer.from("global-config");
const TOKEN_REGISTRY_SEED = Buffer.from("token-registry");
const OWNER_INDEX_BUCKET_SEED = Buffer.from("owner-index-bucket-v2");
const VAULT_TOKEN_ACCOUNT_SEED = Buffer.from("vault-token-account");
const PARTICIPANT_BUCKET_SLOT_COUNT = 9;
const OWNER_INDEX_BUCKET_COUNT = 1024;
const CHANNEL_BUCKET_SLOT_COUNT = 46n;

const PB_DISCRIMINATOR = Buffer.from([107, 145, 82, 194, 47, 231, 201, 105]);
const PB_SLOTS_OFFSET = 13;
const PB_TOKEN_ENTRY_SPACE = 59;
const PB_TOKEN_BALANCES_OFFSET = 135;
const PB_TOKEN_ENTRY_INITIALIZED_OFFSET = 0;
const PB_TOKEN_ENTRY_TOKEN_ID_OFFSET = 1;
const PB_TOKEN_ENTRY_AVAILABLE_OFFSET = 3;
const PB_TOKEN_ENTRY_WITHDRAWING_OFFSET = 11;
const PB_TOKEN_ENTRY_UNLOCK_AT_OFFSET = 19;
const PB_TOKEN_ENTRY_DESTINATION_OFFSET = 27;
const PB_MAX_TOKEN_BALANCES = 16;
const PB_SLOT_SPACE = 1079;

const CB_DISCRIMINATOR = Buffer.from([171, 219, 130, 228, 148, 242, 103, 148]);
const CB_SLOTS_OFFSET = 19;
const CB_DIRECTIONAL_LANE_SPACE = 105;
const CB_SLOT_SPACE = 219;
const CB_SLOT_INITIALIZED_OFFSET = 0;
const CB_SLOT_LOWER_OFFSET = 1;
const CB_SLOT_HIGHER_OFFSET = 5;
const CB_LOWER_TO_HIGHER_LANE_OFFSET = 9;
const CB_HIGHER_TO_LOWER_LANE_OFFSET = 9 + CB_DIRECTIONAL_LANE_SPACE;
const CB_LANE_INITIALIZED_OFFSET = 0;
const CB_LANE_SETTLED_CUMULATIVE_OFFSET = 1;
const CB_LANE_LOCKED_BALANCE_OFFSET = 9;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    network: "devnet",
    basicManifestPath: DEFAULT_BASIC_MANIFEST,
    channelsManifestPath: DEFAULT_CHANNELS_MANIFEST,
    outputPath: DEFAULT_OUTPUT,
    sweepSol: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eqIndex = arg.indexOf("=");
    const key = arg.slice(2, eqIndex >= 0 ? eqIndex : undefined);
    let value = eqIndex >= 0 ? arg.slice(eqIndex + 1) : argv[i + 1];
    if (eqIndex < 0 && value && !value.startsWith("--")) i += 1;
    else if (eqIndex < 0) value = undefined;

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
      case "basic-manifest":
        if (value) options.basicManifestPath = value;
        break;
      case "channels-manifest":
        if (value) options.channelsManifestPath = value;
        break;
      case "output":
        if (value) options.outputPath = value;
        break;
      case "skip-sol-sweep":
        options.sweepSol = false;
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
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf8")))
  );
}

function createWallet(payer: Keypair): anchor.Wallet & { payer: Keypair } {
  return {
    payer,
    publicKey: payer.publicKey,
    signTransaction: async (transaction: any) => {
      if ("version" in transaction) transaction.sign([payer]);
      else transaction.partialSign(payer);
      return transaction;
    },
    signAllTransactions: async (transactions: any[]) =>
      Promise.all(
        transactions.map(async (transaction) => {
          if ("version" in transaction) transaction.sign([payer]);
          else transaction.partialSign(payer);
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
  const payer = loadKeypair(walletPath);
  return new anchor.AnchorProvider(
    new anchor.web3.Connection(rpc, "confirmed"),
    createWallet(payer),
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
}

function resolveProgramId(network: Network, programName: string): PublicKey {
  const sectionHeader = `[programs.${network}]`;
  let inSection = false;
  for (const line of fs
    .readFileSync(path.join(process.cwd(), "Anchor.toml"), "utf8")
    .split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inSection = trimmed === sectionHeader;
      continue;
    }
    if (!inSection) continue;
    const match = trimmed.match(
      new RegExp(`^${programName}\\s*=\\s*"([^"]+)"$`)
    );
    if (match) return new PublicKey(match[1]);
  }
  throw new Error(`Unable to resolve ${programName} for ${network}`);
}

function loadProgram(
  provider: anchor.AnchorProvider,
  network: Network
): Program<RyvoProtocol> {
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "target", "idl", "ryvo_protocol.json"),
      "utf8"
    )
  );
  const programId = resolveProgramId(network, "ryvo_protocol");
  return new Program(
    { ...idl, address: programId.toString() } as RyvoProtocol,
    provider
  );
}

function u16Le(value: number): Buffer {
  return new anchor.BN(value).toArrayLike(Buffer, "le", 2);
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

function findOwnerIndexBucketPda(
  programId: PublicKey,
  owner: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      OWNER_INDEX_BUCKET_SEED,
      new anchor.BN(ownerIndexBucketIdForOwner(owner)).toArrayLike(
        Buffer,
        "le",
        4
      ),
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

function pairOrdinal(lower: number, higher: number): bigint {
  const h = BigInt(higher);
  return (h * (h - 1n)) / 2n + BigInt(lower);
}

async function tokenAccountExists(
  connection: anchor.web3.Connection,
  address: PublicKey
): Promise<boolean> {
  return (await connection.getAccountInfo(address, "confirmed")) !== null;
}

async function ensureAta(
  connection: anchor.web3.Connection,
  payer: Keypair,
  owner: PublicKey,
  mint: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  if (await tokenAccountExists(connection, ata)) return ata;
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint)
    ),
    [payer],
    { commitment: "confirmed" }
  );
  return ata;
}

async function readParticipantBalance(
  connection: anchor.web3.Connection,
  participantBucketPda: PublicKey,
  participantId: number,
  tokenId: number
): Promise<ParticipantBalance> {
  const account = await connection.getAccountInfo(
    participantBucketPda,
    "confirmed"
  );
  if (!account) {
    return {
      available: 0n,
      withdrawing: 0n,
      withdrawalUnlockAt: 0n,
      withdrawalDestination: PublicKey.default,
    };
  }
  const data = account.data;
  if (!data.subarray(0, 8).equals(PB_DISCRIMINATOR)) {
    throw new Error(
      `Invalid participant bucket ${participantBucketPda.toBase58()}`
    );
  }
  const slotIndex = participantId % PARTICIPANT_BUCKET_SLOT_COUNT;
  const tokenBalancesOffset =
    PB_SLOTS_OFFSET + slotIndex * PB_SLOT_SPACE + PB_TOKEN_BALANCES_OFFSET;
  for (let index = 0; index < PB_MAX_TOKEN_BALANCES; index += 1) {
    const entryOffset = tokenBalancesOffset + index * PB_TOKEN_ENTRY_SPACE;
    if (data.readUInt8(entryOffset + PB_TOKEN_ENTRY_INITIALIZED_OFFSET) !== 1) {
      continue;
    }
    if (
      data.readUInt16LE(entryOffset + PB_TOKEN_ENTRY_TOKEN_ID_OFFSET) !==
      tokenId
    ) {
      continue;
    }
    return {
      available: data.readBigUInt64LE(
        entryOffset + PB_TOKEN_ENTRY_AVAILABLE_OFFSET
      ),
      withdrawing: data.readBigUInt64LE(
        entryOffset + PB_TOKEN_ENTRY_WITHDRAWING_OFFSET
      ),
      withdrawalUnlockAt: data.readBigInt64LE(
        entryOffset + PB_TOKEN_ENTRY_UNLOCK_AT_OFFSET
      ),
      withdrawalDestination: new PublicKey(
        data.subarray(
          entryOffset + PB_TOKEN_ENTRY_DESTINATION_OFFSET,
          entryOffset + PB_TOKEN_ENTRY_DESTINATION_OFFSET + 32
        )
      ),
    };
  }
  return {
    available: 0n,
    withdrawing: 0n,
    withdrawalUnlockAt: 0n,
    withdrawalDestination: PublicKey.default,
  };
}

async function readLockedBalance(
  connection: anchor.web3.Connection,
  channelBucketPda: PublicKey,
  payerId: number,
  payeeId: number
): Promise<bigint> {
  const account = await connection.getAccountInfo(
    channelBucketPda,
    "confirmed"
  );
  if (!account) return 0n;
  const data = account.data;
  if (!data.subarray(0, 8).equals(CB_DISCRIMINATOR)) return 0n;
  const lower = Math.min(payerId, payeeId);
  const higher = Math.max(payerId, payeeId);
  const slotIndex = Number(
    pairOrdinal(lower, higher) % CHANNEL_BUCKET_SLOT_COUNT
  );
  const slotOffset = CB_SLOTS_OFFSET + slotIndex * CB_SLOT_SPACE;
  if (
    data.readUInt8(slotOffset + CB_SLOT_INITIALIZED_OFFSET) !== 1 ||
    data.readUInt32LE(slotOffset + CB_SLOT_LOWER_OFFSET) !== lower ||
    data.readUInt32LE(slotOffset + CB_SLOT_HIGHER_OFFSET) !== higher
  ) {
    return 0n;
  }
  const laneOffset =
    payerId === lower
      ? slotOffset + CB_LOWER_TO_HIGHER_LANE_OFFSET
      : slotOffset + CB_HIGHER_TO_LOWER_LANE_OFFSET;
  if (data.readUInt8(laneOffset + CB_LANE_INITIALIZED_OFFSET) !== 1) return 0n;
  data.readBigUInt64LE(laneOffset + CB_LANE_SETTLED_CUMULATIVE_OFFSET);
  return data.readBigUInt64LE(laneOffset + CB_LANE_LOCKED_BALANCE_OFFSET);
}

async function cooperativeUnlock(
  program: Program<RyvoProtocol>,
  tokenId: number,
  payer: WalletEntry,
  payerKeypair: Keypair,
  payee: WalletEntry,
  payeeKeypair: Keypair,
  channelBucket: PublicKey,
  amount: bigint
): Promise<string> {
  return program.methods
    .cooperativeUnlockChannelFunds(
      tokenId,
      payee.participantId,
      new anchor.BN(amount.toString())
    )
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      payerBucket: new PublicKey(payer.participantBucket),
      payeeBucket: new PublicKey(payee.participantBucket),
      channelBucket,
      ownerIndexBucket: new PublicKey(payer.ownerIndexBucket),
      owner: payerKeypair.publicKey,
      payeeOwner: payeeKeypair.publicKey,
    } as any)
    .signers([payerKeypair, payeeKeypair])
    .rpc();
}

async function executePlainWithdrawal(params: {
  program: Program<RyvoProtocol>;
  token: TokenManifestEntry;
  wallet: WalletEntry;
  destination: PublicKey;
  feeRecipientTokenAccount: PublicKey;
}): Promise<string> {
  return params.program.methods
    .executeWithdrawalTimelocked(
      params.token.tokenId,
      params.wallet.participantId
    )
    .accounts({
      tokenRegistry: findTokenRegistryPda(params.program.programId),
      globalConfig: findGlobalConfigPda(params.program.programId),
      participantBucket: new PublicKey(params.wallet.participantBucket),
      vaultTokenAccount: params.token.vaultTokenAccount
        ? new PublicKey(params.token.vaultTokenAccount)
        : findVaultTokenAccountPda(
            params.program.programId,
            params.token.tokenId
          ),
      withdrawalDestination: params.destination,
      feeRecipientTokenAccount: params.feeRecipientTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
}

async function executeYieldWithdrawal(params: {
  program: Program<RyvoProtocol>;
  token: TokenManifestEntry;
  wallet: WalletEntry;
  destination: PublicKey;
  feeRecipientTokenAccount: PublicKey;
}): Promise<string> {
  return params.program.methods
    .executeWithdrawalYieldBearing(
      params.token.tokenId,
      params.wallet.participantId
    )
    .accounts({
      participantBucket: new PublicKey(params.wallet.participantBucket),
      yieldProgram: new PublicKey(params.token.yieldProgram!),
      reserve: new PublicKey(params.token.reserve!),
      underlyingMint: new PublicKey(params.token.underlyingMint!),
      shareMint: new PublicKey(params.token.shareMint!),
      liquidityVault: new PublicKey(params.token.liquidityVault!),
      shareVault: new PublicKey(params.token.shareVault!),
      withdrawalDestination: params.destination,
      feeRecipientTokenAccount: params.feeRecipientTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
}

async function requestWithdrawal(params: {
  program: Program<RyvoProtocol>;
  token: TokenManifestEntry;
  wallet: WalletEntry;
  owner: Keypair;
  destination: PublicKey;
  amount: bigint;
}): Promise<string> {
  if (params.token.kind === "yield-bearing") {
    return params.program.methods
      .requestWithdrawalYieldBearing(
        params.token.tokenId,
        new anchor.BN(params.amount.toString()),
        params.destination
      )
      .accounts({
        participantBucket: new PublicKey(params.wallet.participantBucket),
        ownerIndexBucket: new PublicKey(params.wallet.ownerIndexBucket),
        withdrawalDestination: params.destination,
        owner: params.owner.publicKey,
      } as any)
      .signers([params.owner])
      .rpc();
  }
  return params.program.methods
    .requestWithdrawal(
      params.token.tokenId,
      new anchor.BN(params.amount.toString()),
      params.destination
    )
    .accounts({
      tokenRegistry: findTokenRegistryPda(params.program.programId),
      globalConfig: findGlobalConfigPda(params.program.programId),
      owner: params.owner.publicKey,
      participantBucket: new PublicKey(params.wallet.participantBucket),
      ownerIndexBucket: new PublicKey(params.wallet.ownerIndexBucket),
      withdrawalDestination: params.destination,
    } as any)
    .signers([params.owner])
    .rpc();
}

async function executeWithdrawal(params: {
  program: Program<RyvoProtocol>;
  token: TokenManifestEntry;
  wallet: WalletEntry;
  destination: PublicKey;
  feeRecipientTokenAccount: PublicKey;
}): Promise<string> {
  return params.token.kind === "yield-bearing"
    ? executeYieldWithdrawal(params)
    : executePlainWithdrawal(params);
}

async function sweepTokenAccount(params: {
  provider: anchor.AnchorProvider;
  deployer: Keypair;
  owner: Keypair;
  mint: PublicKey;
  decimals: number;
  destination: PublicKey;
}): Promise<{ amount: string; signature: string | null }> {
  const source = getAssociatedTokenAddressSync(
    params.mint,
    params.owner.publicKey
  );
  if (!(await tokenAccountExists(params.provider.connection, source))) {
    return { amount: "0", signature: null };
  }
  const account = await getAccount(params.provider.connection, source);
  const transaction = new Transaction();
  if (account.amount > 0n) {
    transaction.add(
      createTransferCheckedInstruction(
        source,
        params.mint,
        params.destination,
        params.owner.publicKey,
        account.amount,
        params.decimals,
        [],
        TOKEN_PROGRAM_ID
      )
    );
  }
  transaction.add(
    createCloseAccountInstruction(
      source,
      params.deployer.publicKey,
      params.owner.publicKey,
      [],
      TOKEN_PROGRAM_ID
    )
  );
  transaction.feePayer = params.deployer.publicKey;
  const signature = await sendAndConfirmTransaction(
    params.provider.connection,
    transaction,
    [params.deployer, params.owner],
    { commitment: "confirmed" }
  );
  return { amount: account.amount.toString(), signature };
}

async function sweepSol(params: {
  provider: anchor.AnchorProvider;
  deployer: Keypair;
  owner: Keypair;
}): Promise<{ lamports: number; signature: string | null }> {
  const balance = await params.provider.connection.getBalance(
    params.owner.publicKey,
    "confirmed"
  );
  if (balance <= 0) return { lamports: 0, signature: null };
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.owner.publicKey,
      toPubkey: params.deployer.publicKey,
      lamports: balance,
    })
  );
  transaction.feePayer = params.deployer.publicKey;
  const signature = await sendAndConfirmTransaction(
    params.provider.connection,
    transaction,
    [params.deployer, params.owner],
    { commitment: "confirmed" }
  );
  return { lamports: balance, signature };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = loadProvider(options.network);
  anchor.setProvider(provider);
  const program = loadProgram(provider, options.network);
  const deployer = (provider.wallet as any).payer as Keypair;
  const basicManifestPath = path.resolve(options.basicManifestPath);
  const channelsManifestPath = path.resolve(options.channelsManifestPath);
  const basicManifest = JSON.parse(fs.readFileSync(basicManifestPath, "utf8"));
  const channelsManifest = fs.existsSync(channelsManifestPath)
    ? JSON.parse(fs.readFileSync(channelsManifestPath, "utf8"))
    : null;
  const merchant = basicManifest.wallets.merchant as WalletEntry;
  const wallets: WalletEntry[] = [
    merchant,
    ...(basicManifest.wallets.participants ?? []),
  ];
  const tokens = (basicManifest.tokens ?? []) as TokenManifestEntry[];
  const feeRecipient = new PublicKey(basicManifest.program.feeRecipient);

  const actions: any = {
    unlockedChannels: [],
    withdrawals: [],
    tokenSweeps: [],
    solSweeps: [],
  };

  if (channelsManifest?.agents?.length) {
    const merchantKeypair = loadKeypair(path.resolve(merchant.keypairPath));
    const tokenId = Number(channelsManifest.token.tokenId);
    for (const agent of channelsManifest.agents as WalletEntry[]) {
      const channelBucket = new PublicKey((agent as any).channelBucket);
      const locked = await readLockedBalance(
        provider.connection,
        channelBucket,
        agent.participantId,
        merchant.participantId
      );
      if (locked === 0n) continue;
      const agentKeypair = loadKeypair(path.resolve(agent.keypairPath));
      const signature = await cooperativeUnlock(
        program,
        tokenId,
        agent,
        agentKeypair,
        merchant,
        merchantKeypair,
        channelBucket,
        locked
      );
      actions.unlockedChannels.push({
        label: agent.label,
        tokenId,
        amount: locked.toString(),
        signature,
      });
      console.log(`unlocked ${agent.label} -> merchant: ${locked.toString()}`);
    }
  }

  const uniqueSweepMints = new Map<
    string,
    { mint: PublicKey; decimals: number }
  >();
  for (const token of tokens) {
    const mint = new PublicKey(
      token.kind === "yield-bearing" ? token.underlyingMint! : token.mint
    );
    uniqueSweepMints.set(mint.toString(), {
      mint,
      decimals: Number(token.decimals ?? 6),
    });
    const feeRecipientTokenAccount = await ensureAta(
      provider.connection,
      deployer,
      feeRecipient,
      mint
    );

    for (const wallet of wallets) {
      const owner = loadKeypair(path.resolve(wallet.keypairPath));
      const destination = await ensureAta(
        provider.connection,
        deployer,
        owner.publicKey,
        mint
      );

      let balance = await readParticipantBalance(
        provider.connection,
        new PublicKey(wallet.participantBucket),
        wallet.participantId,
        token.tokenId
      );
      if (balance.withdrawing > 0n) {
        const pendingDestination = balance.withdrawalDestination.equals(
          PublicKey.default
        )
          ? destination
          : balance.withdrawalDestination;
        const signature = await executeWithdrawal({
          program,
          token,
          wallet,
          destination: pendingDestination,
          feeRecipientTokenAccount,
        });
        actions.withdrawals.push({
          label: wallet.label,
          tokenId: token.tokenId,
          phase: "execute-existing",
          amount: balance.withdrawing.toString(),
          signature,
        });
      }

      balance = await readParticipantBalance(
        provider.connection,
        new PublicKey(wallet.participantBucket),
        wallet.participantId,
        token.tokenId
      );
      if (balance.available > 0n) {
        const requestSignature = await requestWithdrawal({
          program,
          token,
          wallet,
          owner,
          destination,
          amount: balance.available,
        });
        const executeSignature = await executeWithdrawal({
          program,
          token,
          wallet,
          destination,
          feeRecipientTokenAccount,
        });
        actions.withdrawals.push({
          label: wallet.label,
          tokenId: token.tokenId,
          phase: "request-and-execute",
          amount: balance.available.toString(),
          requestSignature,
          executeSignature,
        });
        console.log(
          `withdrew ${balance.available.toString()} token ${
            token.tokenId
          } for ${wallet.label}`
        );
      }
    }
  }

  for (const wallet of wallets) {
    const owner = loadKeypair(path.resolve(wallet.keypairPath));
    for (const { mint, decimals } of uniqueSweepMints.values()) {
      const destination = await ensureAta(
        provider.connection,
        deployer,
        deployer.publicKey,
        mint
      );
      const sweep = await sweepTokenAccount({
        provider,
        deployer,
        owner,
        mint,
        decimals,
        destination,
      });
      if (sweep.signature) {
        actions.tokenSweeps.push({
          label: wallet.label,
          mint: mint.toString(),
          amount: sweep.amount,
          signature: sweep.signature,
        });
        console.log(`swept token ATA for ${wallet.label}: ${sweep.amount}`);
      }
    }
  }

  if (options.sweepSol) {
    for (const wallet of wallets) {
      const owner = loadKeypair(path.resolve(wallet.keypairPath));
      const sweep = await sweepSol({ provider, deployer, owner });
      if (sweep.signature) {
        actions.solSweeps.push({
          label: wallet.label,
          lamports: sweep.lamports,
          signature: sweep.signature,
        });
        console.log(
          `swept SOL for ${wallet.label}: ${(
            sweep.lamports / LAMPORTS_PER_SOL
          ).toFixed(6)}`
        );
      }
    }
  }

  const outputPath = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        network: options.network,
        rpcUrl: provider.connection.rpcEndpoint,
        programId: program.programId.toString(),
        basicManifest: relPath(basicManifestPath),
        channelsManifest: channelsManifest
          ? relPath(channelsManifestPath)
          : null,
        recipient: deployer.publicKey.toString(),
        actions,
      },
      null,
      2
    )}\n`
  );
  console.log(`Wrote drain manifest to ${relPath(outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
