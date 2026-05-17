#!/usr/bin/env ts-node

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";
import { createHash, createPrivateKey, sign as cryptoSign } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { RyvoProtocol } from "../target/types/ryvo_protocol";

const { loadProjectRpcEnv, resolveProjectRpcUrl } =
  require("./lib/rpc-env.cjs") as {
    loadProjectRpcEnv: (repoRoot?: string) => void;
    resolveProjectRpcUrl: (network?: string) => string;
  };

loadProjectRpcEnv(process.cwd());

import {
  BLS_CLEARING_ROUND_MESSAGE_VERSION,
  BLS_PUBLIC_KEY_COMPRESSED_SIZE,
  BLS_REGISTRATION_MESSAGE_VERSION,
  BLS_REGISTRATION_MESSAGE_KIND,
  BLS_SIGNATURE_COMPRESSED_SIZE,
  aggregateBlsSignatures,
  createBlsKeypairFromSeed,
  createBlsRegistrationMessage,
  signBlsMessage as signSharedBlsMessage,
} from "../shared/protocol-bls";
import {
  getCanonicalChannelParticipants,
  normalizeChannelBucketState as normalizeSharedChannelBucketState,
  normalizeDirectionalChannelState,
  normalizeParticipantBucketSlot,
} from "../shared/channel-bucket-state";
import {
  type BenchmarkShape,
  type DemoBenchmarkScenario,
  computeSavingsMetrics,
  explorerUrl as buildExplorerUrl,
} from "./lib/benchmark-artifacts";
import {
  type ClearingRoundCapacitySummary,
  LEGACY_PACKET_DATA_SIZE,
  measureClearingRoundCapacity,
  summarizeClearingRoundCapacity,
} from "./lib/clearing-round-capacity";

const TOKEN_REGISTRY_SEED = "token-registry";
const GLOBAL_CONFIG_SEED = "global-config";
const PARTICIPANT_BUCKET_SEED = "participant-bucket-v2";
const OWNER_INDEX_BUCKET_SEED = "owner-index-bucket-v2";
const CHANNEL_BUCKET_SEED = "channel-bucket-v2";
const PARTICIPANT_BUCKET_SLOT_COUNT = 9;
const CHANNEL_BUCKET_SLOT_COUNT = 46;
const CHANNEL_BUCKET_DISCRIMINATOR = Buffer.from([
  171, 219, 130, 228, 148, 242, 103, 148,
]);
const CHANNEL_BUCKET_TOKEN_ID_OFFSET = 8;
const CHANNEL_BUCKET_ID_OFFSET = 10;
const CHANNEL_BUCKET_SLOTS_OFFSET = 19;
const CHANNEL_BUCKET_SLOT_SIZE = 219;
const CHANNEL_BUCKET_SPACE =
  CHANNEL_BUCKET_SLOTS_OFFSET +
  CHANNEL_BUCKET_SLOT_COUNT * CHANNEL_BUCKET_SLOT_SIZE;
const CHANNEL_BUCKET_SLOT_INITIALIZED_OFFSET = 0;
const CHANNEL_BUCKET_SLOT_LOWER_PARTICIPANT_ID_OFFSET = 1;
const CHANNEL_BUCKET_SLOT_HIGHER_PARTICIPANT_ID_OFFSET = 5;
const CHANNEL_BUCKET_LOWER_TO_HIGHER_LANE_OFFSET = 9;
const CHANNEL_BUCKET_HIGHER_TO_LOWER_LANE_OFFSET = 114;
const CHANNEL_BUCKET_LANE_INITIALIZED_OFFSET = 0;
const CHANNEL_BUCKET_LANE_SETTLED_CUMULATIVE_OFFSET = 1;
const CHANNEL_BUCKET_LANE_LOCKED_BALANCE_OFFSET = 9;
const OWNER_INDEX_BUCKET_COUNT = 1024;
const VAULT_TOKEN_ACCOUNT_SEED = "vault-token-account";
const USED_SIGNATURE_SEED = "used-sig";
const MULTILATERAL_NAMESPACE = "mnet";
const DEFAULT_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_TOKEN_ID = 1;
const DEFAULT_TOKEN_SYMBOL = "USDC";
const DEFAULT_WALLET_MANIFEST_PATH = path.join(
  "config",
  "ryvo-protocol-demo-wallets.json"
);
const DEMO_WALLET_BASE_NAMES = [
  "Alice",
  "Bob",
  "Carol",
  "Dave",
  "Erin",
  "Frank",
  "Grace",
  "Heidi",
  "Ivan",
  "Judy",
];
const DEFAULT_BLS_SEARCH_RESULTS_LOG_PATH = path.join(
  "logs",
  "bls-search-results.jsonl"
);
const MIN_WALLET_COUNT = 6;
const DEFAULT_WALLET_COUNT = 32;
const MAX_WALLET_COUNT = 32;
const DEFAULT_SOL_PER_WALLET = 0.1;
const DEFAULT_USDC_PER_WALLET = 1000;
const DEFAULT_BLS_INTERNAL_BALANCE_TARGET = 100;
const DEFAULT_BLS_RANDOM_MIN_AMOUNT = 0.5;
const DEFAULT_BLS_RANDOM_MAX_AMOUNT = 2;
const DEFAULT_BLS_RANDOM_SEED = "ryvo-bls-search-v1";
const DEFAULT_BLS_MAX_DENSE_CHANNELS = 150;
const DEFAULT_DEPOSIT_PLAN: Record<string, number> = {
  Alice: 350,
  Bob: 120,
  Carol: 120,
  Dave: 80,
  Erin: 80,
  Frank: 80,
};
const DEFAULT_SINGLE_COMMITMENT_COUNT = 1;
const DEFAULT_SINGLE_COMMITMENT_AMOUNT = 25;
const DEFAULT_SINGLE_COMMITMENT_LOG_EVERY = 1;
const DEFAULT_BATCH_COMMITMENT_BATCH_COUNT = 1;
const DEFAULT_BATCH_COMMITMENT_BATCH_SIZE = 5;
const DEFAULT_BATCH_COMMITMENT_AMOUNT = 5;
const DEFAULT_BATCH_COMMITMENT_LOG_EVERY = 1;
const MAX_BUNDLE_CHANNELS_PER_TX = 2;
const DEFAULT_UNILATERAL_PAYEE_A_COMMITMENT_COUNT = 400;
const DEFAULT_UNILATERAL_PAYEE_B_COMMITMENT_COUNT = 300;
const DEFAULT_UNILATERAL_AMOUNT_PER_COMMITMENT = 0.1;
const DEFAULT_UNILATERAL_LOCK_AMOUNT = 10;
const DEFAULT_BILATERAL_FORWARD_COMMITMENT_COUNT = 350;
const DEFAULT_BILATERAL_REVERSE_COMMITMENT_COUNT = 200;
const DEFAULT_BILATERAL_AMOUNT_PER_COMMITMENT = 0.1;
const DEFAULT_MULTILATERAL_EDGE_COMMITMENT_COUNT = 220;
const DEFAULT_MULTILATERAL_AMOUNT_PER_COMMITMENT = 0.1;
const X402_SOLANA_COST_PER_TX_USD = 0.00044;
const DEFAULT_BLS_COMPUTE_UNIT_LIMIT = 1_400_000;
const SIGNED_COMMITMENT_PREVIEW_COUNT = 4;
const BLS_DEMO_KEY_DERIVATION_TAG = Buffer.from("ryvo-demo-bls-key-v1", "utf8");
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);

type SupportedNetwork = "devnet" | "mainnet" | "testnet" | "localnet";

type CliOptions = {
  configFilePath: string | null;
  walletCount: number;
  activeWalletNames: string[] | null;
  tokenId: number;
  tokenMint: PublicKey;
  tokenSymbol: string;
  solPerWallet: number;
  tokensPerWallet: number;
  walletManifestPath: string;
  blsSearchResultsLogPath: string;
  blsInternalBalanceTarget: number;
  blsRandomSeed: string;
  blsRandomMinAmount: number;
  blsRandomMaxAmount: number;
  blsMaxDenseChannels: number;
  blsComputeUnitLimit: number;
  reuseManifestPath: string | null;
  skipFunding: boolean;
  skipParticipantInit: boolean;
  skipDeposits: boolean;
  skipMaxChannels: boolean;
  depositPlan: Record<string, number>;
  singleCommitmentCount: number;
  singleCommitmentAmount: number;
  singleCommitmentLogEvery: number;
  batchCommitmentBatchCount: number;
  batchCommitmentBatchSize: number;
  batchCommitmentAmount: number;
  batchCommitmentLogEvery: number;
  unilateralPayeeACommitmentCount: number;
  unilateralPayeeBCommitmentCount: number;
  unilateralAmountPerCommitment: number;
  unilateralLockAmount: number;
  bilateralForwardCommitmentCount: number;
  bilateralReverseCommitmentCount: number;
  bilateralAmountPerCommitment: number;
  multilateralEdgeCommitmentCount: number;
  multilateralAmountPerCommitment: number;
};

type DemoWallet = {
  name: string;
  keypair: Keypair;
  secretPath: string;
  participantPda: PublicKey;
  participantId: number;
  tokenAccount: PublicKey;
  blsSecretScalar: bigint;
  blsPublicKeyCompressed: Buffer;
};

type TokenBalanceView = {
  available: number;
  withdrawing: number;
};

type ChannelEntrySpec = {
  payeeRef: number;
  targetCumulative: number;
};

type ParticipantBlockSpec = {
  participantId: number;
  entries: {
    payeeRef: number;
    targetCumulative: number;
  }[];
};

type SignedCommitmentPreviewInput = {
  payer: DemoWallet;
  payee: DemoWallet;
  committedAmount: number;
  tokenId: number;
};

type DirectCommitmentPayloadPreview = {
  signedBy: string;
  payload: {
    kind: number;
    version: number;
    messageDomain: string;
    flags: number;
    payer: string;
    payee: string;
    payerId: number;
    payeeId: number;
    tokenId: number;
    committedAmount: string;
  };
  signature: string;
};

type SignedCommitmentPreview = {
  example: DirectCommitmentPayloadPreview;
  signatures: string[];
};

type CommitmentBundlePayloadPreview = {
  kind: number;
  version: number;
  messageDomain: string;
  payee: string;
  payeeId: number;
  tokenId: number;
  token: string;
  entryCount: number;
  entries: {
    signedBy: string;
    payerId: number;
    committedAmount: string;
    signature: string;
  }[];
};

type ClearingRoundPreviewBlockInput = {
  participant: DemoWallet;
  entries: {
    payeeRef: number;
    payee: DemoWallet;
    targetCumulative: number;
  }[];
};

type ClearingRoundPayloadPreview = {
  kind: number;
  version: number;
  messageDomain: string;
  tokenId: number;
  token: string;
  participantCount: number;
  channelCount: number;
  cosignedBy: string[];
  participantBlocks: {
    participant: string;
    participantId: number;
    entryCount: number;
    entries: {
      channel: string;
      payeeRef: number;
      targetCumulative: string;
    }[];
  }[];
  signatures: string[];
};

type ScenarioSignatureMap = {
  singleCommitment: string;
  batchCommitment: string;
  atomicRoutedClearing: string;
  blsMaxParticipantsClearing: string;
  blsMaxChannelsClearing?: string;
};

type ScenarioResult = {
  primarySignature: string;
  benchmark: DemoBenchmarkScenario;
};

type MultilateralScenarioResult = ScenarioResult & {
  settledChannelCount: number;
};

type MultilateralSearchTarget = {
  balanced: BenchmarkShape;
  overall: BenchmarkShape;
};

type DemoManifestWallet = {
  name: string;
  publicKey: string;
  participantId?: number;
  participantPda?: string;
  tokenAccount?: string;
  secretPath: string;
};

type DemoRunManifest = {
  runId: string;
  network: string;
  rpcEndpoint: string;
  programId: string;
  deployer: string;
  token: {
    id: number;
    symbol: string;
    mint: string;
    decimals: number;
    vaultTokenAccount: string;
  };
  feeRecipient: string;
  wallets: DemoManifestWallet[];
  messageDomain?: string;
};

type PreparedWalletSet = {
  runId: string;
  walletDir: string;
  wallets: DemoWallet[];
  source: "created" | "manifest";
  manifestPath?: string;
};

type MultilateralChannelEdge = {
  payer: DemoWallet;
  payee: DemoWallet;
  channelPda: PublicKey;
  channel: any;
};

type MultilateralEdgeSelection = {
  edges: MultilateralChannelEdge[];
  participants: DemoWallet[];
};

type MultilateralCandidate = {
  participantCount: number;
  channelCount: number;
};

type MultilateralScenarioMode = "max-participants" | "max-channels";

type MultilateralScenarioDefinition = {
  scenarioId: string;
  scenarioTitle: string;
  mode: MultilateralScenarioMode;
  fullParticipantSet: DemoWallet[];
  lowerBound: number;
  upperBound: number;
};

type MultilateralSearchAttempt = {
  candidate: MultilateralCandidate;
  txBytes: number;
  fitsPacket: boolean;
  simulationPassed: boolean;
  simulationError: string | null;
  messageBytes: number;
  aggregateSignatureBytes: number;
};

type MultilateralPreparedRound = {
  participants: DemoWallet[];
  edges: MultilateralChannelEdge[];
  roundBlocks: ClearingRoundPreviewBlockInput[];
  message: Buffer;
  aggregateSignatureCompressed: Buffer;
  instruction: TransactionInstruction;
  clearingRoundPreview: ClearingRoundPayloadPreview;
  signedCommitmentPreview: SignedCommitmentPreview;
  totalGrossRouted: number;
  totalUnderlyingCommitments: number;
};

type RpcParticipantVerification = {
  name: string;
  participantPda: PublicKey;
  beforeAvailable: bigint;
  afterAnchorAvailable: bigint;
  afterRpcAvailable: bigint;
  beforeWithdrawing: bigint;
  afterAnchorWithdrawing: bigint;
  afterRpcWithdrawing: bigint;
  matchesAnchor: boolean;
};

type RpcChannelVerification = {
  channelLabel: string;
  channelPda: PublicKey;
  beforeSettledCumulative: bigint;
  afterAnchorSettledCumulative: bigint;
  afterRpcSettledCumulative: bigint;
  matchesAnchor: boolean;
};

type RpcSettlementVerification = {
  participantChecks: RpcParticipantVerification[];
  channelChecks: RpcChannelVerification[];
};

type MultilateralSearchContext = {
  fullParticipants: DemoWallet[];
  completeGraphEdges: MultilateralChannelEdge[];
  lookupTables: AddressLookupTableAccount[];
  sponsor: Keypair;
  extraSigners: Keypair[];
  decimals: number;
  tokenId: number;
  tokenSymbol: string;
  messageDomain: Buffer;
  edgeCommitmentCount: number;
  resultsLogPath: string;
  runId: string;
  scenarioSeed: string;
  randomMinAmount: number;
  randomMaxAmount: number;
  denseChannelCap: number;
  computeUnitLimit: number;
};

type MultilateralCandidateEvaluation = {
  definition: MultilateralScenarioDefinition;
  attempt: MultilateralSearchAttempt;
  preparedRound: MultilateralPreparedRound;
  successfulCandidates: EvaluatedMultilateralCandidate[];
};

type EvaluatedMultilateralCandidate = {
  attempt: MultilateralSearchAttempt;
  preparedRound: MultilateralPreparedRound;
};

type MultilateralSearchResult = {
  best: EvaluatedMultilateralCandidate;
  successfulCandidates: EvaluatedMultilateralCandidate[];
};

function loadConfigFile(
  repoRoot: string,
  rawPath: string | undefined
): Record<string, string> {
  const configPath = resolveInputPath(
    repoRoot,
    rawPath ?? path.join("config", "ryvo-protocol-demo.env")
  );
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function parseBooleanOption(
  rawValue: string | undefined,
  fallback = false
): boolean {
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${rawValue}`);
}

function parseIntegerOption(
  rawValue: string | undefined,
  fallback: number,
  label: string,
  minimum = 0
): number {
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseNameListOption(rawValue: string | undefined): string[] | null {
  if (rawValue === undefined || rawValue.trim() === "") {
    return null;
  }
  const names = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return names.length > 0 ? names : null;
}

function parseFloatOption(
  rawValue: string | undefined,
  fallback: number,
  label: string,
  minimum = 0
): number {
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${label} must be a number >= ${minimum}`);
  }
  return parsed;
}

function parseDepositPlan(
  rawValue: string | undefined
): Record<string, number> {
  if (!rawValue || rawValue.trim() === "") {
    return { ...DEFAULT_DEPOSIT_PLAN };
  }
  const parsed = JSON.parse(rawValue);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RYVO_DEMO_DEPOSIT_PLAN_JSON must be a JSON object");
  }
  const depositPlan: Record<string, number> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Deposit amount for ${name} must be a number >= 0`);
    }
    depositPlan[name] = value;
  }
  return depositPlan;
}

function maybeTranslateWslPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("//wsl.localhost/Ubuntu/")) {
    return `/${normalized.slice("//wsl.localhost/Ubuntu/".length)}`;
  }
  if (normalized.startsWith("//wsl$/Ubuntu/")) {
    return `/${normalized.slice("//wsl$/Ubuntu/".length)}`;
  }
  return normalized;
}

function resolveInputPath(repoRoot: string, rawPath: string): string {
  const translated = maybeTranslateWslPath(rawPath);
  if (fs.existsSync(translated)) {
    return translated;
  }
  const candidate = path.isAbsolute(translated)
    ? translated
    : path.join(repoRoot, translated);
  return candidate;
}

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  const repoRoot = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) continue;
    const trimmed = value.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex >= 0) {
      args.set(trimmed.slice(0, eqIndex), trimmed.slice(eqIndex + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(trimmed, next);
      i += 1;
    } else {
      args.set(trimmed, "true");
    }
  }
  if (args.has("help")) {
    console.log(
      "Usage: npx ts-node scripts/ryvo-protocol-demo.ts [--config-file config/ryvo-protocol-demo.env] [--wallet-count 6] [--token-id 1] [--mint <pubkey>] [--symbol USDC] [--wallet-manifest config/ryvo-protocol-demo-wallets.json] [--reuse-manifest config/ryvo-protocol-demo-last-run.json]"
    );
    process.exit(0);
  }
  const configFilePath =
    args.get("config-file") ??
    process.env.RYVO_DEMO_CONFIG_FILE ??
    path.join("config", "ryvo-protocol-demo.env");
  const configValues = loadConfigFile(repoRoot, configFilePath);
  const getValue = (cliName: string, envName: string): string | undefined =>
    args.get(cliName) ?? process.env[envName] ?? configValues[envName];
  const walletCount = parseIntegerOption(
    getValue("wallet-count", "RYVO_DEMO_WALLET_COUNT"),
    DEFAULT_WALLET_COUNT,
    "wallet-count",
    MIN_WALLET_COUNT
  );
  if (!Number.isInteger(walletCount) || walletCount < MIN_WALLET_COUNT) {
    throw new Error(`wallet-count must be an integer >= ${MIN_WALLET_COUNT}`);
  }
  if (walletCount > MAX_WALLET_COUNT) {
    throw new Error(`wallet-count must be <= ${MAX_WALLET_COUNT}`);
  }
  const tokenIdRaw =
    getValue("token-id", "RYVO_DEMO_TOKEN_ID") ?? `${DEFAULT_TOKEN_ID}`;
  const tokenId = Number.parseInt(tokenIdRaw, 10);
  const tokenMint = new PublicKey(
    getValue("mint", "RYVO_DEMO_MINT") ?? DEFAULT_USDC_MINT
  );
  const tokenSymbol =
    getValue("symbol", "RYVO_DEMO_SYMBOL") ?? DEFAULT_TOKEN_SYMBOL;
  const solPerWallet = parseFloatOption(
    getValue("sol-per-wallet", "RYVO_DEMO_SOL_PER_WALLET"),
    DEFAULT_SOL_PER_WALLET,
    "sol-per-wallet"
  );
  const tokensPerWallet = parseFloatOption(
    getValue("tokens-per-wallet", "RYVO_DEMO_TOKENS_PER_WALLET"),
    DEFAULT_USDC_PER_WALLET,
    "tokens-per-wallet"
  );
  const walletManifestPath =
    getValue("wallet-manifest", "RYVO_DEMO_WALLET_MANIFEST") ??
    DEFAULT_WALLET_MANIFEST_PATH;
  const blsSearchResultsLogPath =
    getValue("bls-search-log", "RYVO_DEMO_BLS_SEARCH_LOG") ??
    DEFAULT_BLS_SEARCH_RESULTS_LOG_PATH;
  const blsInternalBalanceTarget = parseFloatOption(
    getValue(
      "bls-internal-balance-target",
      "RYVO_DEMO_BLS_INTERNAL_BALANCE_TARGET"
    ),
    DEFAULT_BLS_INTERNAL_BALANCE_TARGET,
    "RYVO_DEMO_BLS_INTERNAL_BALANCE_TARGET",
    0
  );
  const blsRandomSeed =
    getValue("bls-random-seed", "RYVO_DEMO_BLS_RANDOM_SEED") ??
    DEFAULT_BLS_RANDOM_SEED;
  const blsRandomMinAmount = parseFloatOption(
    getValue("bls-random-min-amount", "RYVO_DEMO_BLS_RANDOM_MIN_AMOUNT"),
    DEFAULT_BLS_RANDOM_MIN_AMOUNT,
    "RYVO_DEMO_BLS_RANDOM_MIN_AMOUNT",
    0
  );
  const blsRandomMaxAmount = parseFloatOption(
    getValue("bls-random-max-amount", "RYVO_DEMO_BLS_RANDOM_MAX_AMOUNT"),
    DEFAULT_BLS_RANDOM_MAX_AMOUNT,
    "RYVO_DEMO_BLS_RANDOM_MAX_AMOUNT",
    blsRandomMinAmount
  );
  const blsMaxDenseChannels = parseIntegerOption(
    getValue("bls-max-dense-channels", "RYVO_DEMO_BLS_MAX_DENSE_CHANNELS"),
    DEFAULT_BLS_MAX_DENSE_CHANNELS,
    "RYVO_DEMO_BLS_MAX_DENSE_CHANNELS",
    1
  );
  const blsComputeUnitLimit = parseIntegerOption(
    getValue("bls-compute-unit-limit", "RYVO_DEMO_BLS_COMPUTE_UNIT_LIMIT"),
    DEFAULT_BLS_COMPUTE_UNIT_LIMIT,
    "RYVO_DEMO_BLS_COMPUTE_UNIT_LIMIT",
    200_000
  );
  const reuseManifestPath =
    getValue("reuse-manifest", "RYVO_DEMO_REUSE_MANIFEST") ?? null;
  const skipFunding = parseBooleanOption(
    getValue("skip-funding", "RYVO_DEMO_SKIP_FUNDING"),
    false
  );
  const skipParticipantInit = parseBooleanOption(
    getValue("skip-participant-init", "RYVO_DEMO_SKIP_PARTICIPANT_INIT"),
    false
  );
  const skipDeposits = parseBooleanOption(
    getValue("skip-deposits", "RYVO_DEMO_SKIP_DEPOSITS"),
    false
  );
  const skipMaxChannels = parseBooleanOption(
    getValue("skip-max-channels", "RYVO_DEMO_SKIP_MAX_CHANNELS"),
    false
  );
  return {
    configFilePath,
    walletCount,
    activeWalletNames: parseNameListOption(
      getValue("active-wallets", "RYVO_DEMO_ACTIVE_WALLETS")
    ),
    tokenId,
    tokenMint,
    tokenSymbol,
    solPerWallet,
    tokensPerWallet,
    walletManifestPath,
    blsSearchResultsLogPath,
    blsInternalBalanceTarget,
    blsRandomSeed,
    blsRandomMinAmount,
    blsRandomMaxAmount,
    blsMaxDenseChannels,
    blsComputeUnitLimit,
    reuseManifestPath,
    skipFunding,
    skipParticipantInit,
    skipDeposits,
    skipMaxChannels,
    depositPlan: parseDepositPlan(
      getValue("deposit-plan-json", "RYVO_DEMO_DEPOSIT_PLAN_JSON")
    ),
    singleCommitmentCount: parseIntegerOption(
      getValue("single-commitment-count", "RYVO_DEMO_SINGLE_COMMITMENT_COUNT"),
      DEFAULT_SINGLE_COMMITMENT_COUNT,
      "RYVO_DEMO_SINGLE_COMMITMENT_COUNT",
      1
    ),
    singleCommitmentAmount: parseFloatOption(
      getValue(
        "single-commitment-amount",
        "RYVO_DEMO_SINGLE_COMMITMENT_AMOUNT"
      ),
      DEFAULT_SINGLE_COMMITMENT_AMOUNT,
      "RYVO_DEMO_SINGLE_COMMITMENT_AMOUNT",
      0
    ),
    singleCommitmentLogEvery: parseIntegerOption(
      getValue(
        "single-commitment-log-every",
        "RYVO_DEMO_SINGLE_COMMITMENT_LOG_EVERY"
      ),
      DEFAULT_SINGLE_COMMITMENT_LOG_EVERY,
      "RYVO_DEMO_SINGLE_COMMITMENT_LOG_EVERY",
      1
    ),
    batchCommitmentBatchCount: parseIntegerOption(
      getValue(
        "batch-commitment-batch-count",
        "RYVO_DEMO_BATCH_COMMITMENT_BATCH_COUNT"
      ),
      DEFAULT_BATCH_COMMITMENT_BATCH_COUNT,
      "RYVO_DEMO_BATCH_COMMITMENT_BATCH_COUNT",
      1
    ),
    batchCommitmentBatchSize: parseIntegerOption(
      getValue(
        "batch-commitment-batch-size",
        "RYVO_DEMO_BATCH_COMMITMENT_BATCH_SIZE"
      ),
      DEFAULT_BATCH_COMMITMENT_BATCH_SIZE,
      "RYVO_DEMO_BATCH_COMMITMENT_BATCH_SIZE",
      1
    ),
    batchCommitmentAmount: parseFloatOption(
      getValue("batch-commitment-amount", "RYVO_DEMO_BATCH_COMMITMENT_AMOUNT"),
      DEFAULT_BATCH_COMMITMENT_AMOUNT,
      "RYVO_DEMO_BATCH_COMMITMENT_AMOUNT",
      0
    ),
    batchCommitmentLogEvery: parseIntegerOption(
      getValue(
        "batch-commitment-log-every",
        "RYVO_DEMO_BATCH_COMMITMENT_LOG_EVERY"
      ),
      DEFAULT_BATCH_COMMITMENT_LOG_EVERY,
      "RYVO_DEMO_BATCH_COMMITMENT_LOG_EVERY",
      1
    ),
    unilateralPayeeACommitmentCount: parseIntegerOption(
      getValue(
        "unilateral-payee-a-commitments",
        "RYVO_DEMO_UNILATERAL_PAYEE_A_COMMITMENTS"
      ),
      DEFAULT_UNILATERAL_PAYEE_A_COMMITMENT_COUNT,
      "RYVO_DEMO_UNILATERAL_PAYEE_A_COMMITMENTS",
      1
    ),
    unilateralPayeeBCommitmentCount: parseIntegerOption(
      getValue(
        "unilateral-payee-b-commitments",
        "RYVO_DEMO_UNILATERAL_PAYEE_B_COMMITMENTS"
      ),
      DEFAULT_UNILATERAL_PAYEE_B_COMMITMENT_COUNT,
      "RYVO_DEMO_UNILATERAL_PAYEE_B_COMMITMENTS",
      1
    ),
    unilateralAmountPerCommitment: parseFloatOption(
      getValue("unilateral-amount", "RYVO_DEMO_UNILATERAL_AMOUNT"),
      DEFAULT_UNILATERAL_AMOUNT_PER_COMMITMENT,
      "RYVO_DEMO_UNILATERAL_AMOUNT",
      0
    ),
    unilateralLockAmount: parseFloatOption(
      getValue("unilateral-lock-amount", "RYVO_DEMO_UNILATERAL_LOCK_AMOUNT"),
      DEFAULT_UNILATERAL_LOCK_AMOUNT,
      "RYVO_DEMO_UNILATERAL_LOCK_AMOUNT",
      0
    ),
    bilateralForwardCommitmentCount: parseIntegerOption(
      getValue(
        "bilateral-forward-commitments",
        "RYVO_DEMO_BILATERAL_FORWARD_COMMITMENTS"
      ),
      DEFAULT_BILATERAL_FORWARD_COMMITMENT_COUNT,
      "RYVO_DEMO_BILATERAL_FORWARD_COMMITMENTS",
      1
    ),
    bilateralReverseCommitmentCount: parseIntegerOption(
      getValue(
        "bilateral-reverse-commitments",
        "RYVO_DEMO_BILATERAL_REVERSE_COMMITMENTS"
      ),
      DEFAULT_BILATERAL_REVERSE_COMMITMENT_COUNT,
      "RYVO_DEMO_BILATERAL_REVERSE_COMMITMENTS",
      1
    ),
    bilateralAmountPerCommitment: parseFloatOption(
      getValue("bilateral-amount", "RYVO_DEMO_BILATERAL_AMOUNT"),
      DEFAULT_BILATERAL_AMOUNT_PER_COMMITMENT,
      "RYVO_DEMO_BILATERAL_AMOUNT",
      0
    ),
    multilateralEdgeCommitmentCount: parseIntegerOption(
      getValue(
        "multilateral-edge-commitments",
        "RYVO_DEMO_MULTILATERAL_EDGE_COMMITMENTS"
      ),
      DEFAULT_MULTILATERAL_EDGE_COMMITMENT_COUNT,
      "RYVO_DEMO_MULTILATERAL_EDGE_COMMITMENTS",
      1
    ),
    multilateralAmountPerCommitment: parseFloatOption(
      getValue("multilateral-amount", "RYVO_DEMO_MULTILATERAL_AMOUNT"),
      DEFAULT_MULTILATERAL_AMOUNT_PER_COMMITMENT,
      "RYVO_DEMO_MULTILATERAL_AMOUNT",
      0
    ),
  };
}

function inferNetwork(rpcEndpoint: string): SupportedNetwork {
  if (rpcEndpoint.includes("mainnet")) return "mainnet";
  if (rpcEndpoint.includes("devnet")) return "devnet";
  if (rpcEndpoint.includes("testnet")) return "testnet";
  if (rpcEndpoint.includes("127.0.0.1") || rpcEndpoint.includes("localhost")) {
    return "localnet";
  }
  return "localnet";
}

function findTokenRegistryPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_REGISTRY_SEED)],
    programId
  )[0];
}

function findGlobalConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_CONFIG_SEED)],
    programId
  )[0];
}

function u32Le(value: number): Buffer {
  return new anchor.BN(value).toArrayLike(Buffer, "le", 4);
}

function u64Le(value: number | bigint): Buffer {
  return new anchor.BN(value.toString()).toArrayLike(Buffer, "le", 8);
}

function participantBucketIdForParticipantId(participantId: number): number {
  return Math.floor(participantId / PARTICIPANT_BUCKET_SLOT_COUNT);
}

function participantBucketSlotIndex(participantId: number): number {
  return participantId % PARTICIPANT_BUCKET_SLOT_COUNT;
}

function ownerIndexBucketIdForOwner(owner: PublicKey): number {
  const digest = createHash("sha256").update(owner.toBuffer()).digest();
  return digest.readUInt32LE(0) % OWNER_INDEX_BUCKET_COUNT;
}

function findParticipantBucketPda(
  programId: PublicKey,
  participantId: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(PARTICIPANT_BUCKET_SEED),
      u32Le(participantBucketIdForParticipantId(participantId)),
    ],
    programId
  )[0];
}

function findOwnerIndexBucketPda(
  programId: PublicKey,
  owner: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(OWNER_INDEX_BUCKET_SEED),
      u32Le(ownerIndexBucketIdForOwner(owner)),
    ],
    programId
  )[0];
}

function pairOrdinal(
  lowerParticipantId: number,
  higherParticipantId: number
): bigint {
  const higher = BigInt(higherParticipantId);
  return (higher * (higher - 1n)) / 2n + BigInt(lowerParticipantId);
}

function channelBucketIdForPair(payerId: number, payeeId: number): number {
  const { lowerParticipantId, higherParticipantId } =
    getCanonicalChannelParticipants(payerId, payeeId);
  return Number(
    pairOrdinal(lowerParticipantId, higherParticipantId) /
      BigInt(CHANNEL_BUCKET_SLOT_COUNT)
  );
}

function channelBucketSlotIndexForPair(
  payerId: number,
  payeeId: number
): number {
  const { lowerParticipantId, higherParticipantId } =
    getCanonicalChannelParticipants(payerId, payeeId);
  return Number(
    pairOrdinal(lowerParticipantId, higherParticipantId) %
      BigInt(CHANNEL_BUCKET_SLOT_COUNT)
  );
}

function findChannelPda(
  programId: PublicKey,
  payerId: number,
  payeeId: number,
  tokenId: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(CHANNEL_BUCKET_SEED),
      new anchor.BN(tokenId).toArrayLike(Buffer, "le", 2),
      u64Le(channelBucketIdForPair(payerId, payeeId)),
    ],
    programId
  )[0];
}

function normalizeChannelBucketState(
  channelBucket: any,
  payerId: number,
  payeeId: number
) {
  return normalizeSharedChannelBucketState(
    channelBucket,
    payerId,
    payeeId,
    channelBucketSlotIndexForPair
  );
}

async function fetchDirectionalChannelState(
  program: Program<RyvoProtocol>,
  channelPda: PublicKey,
  payerId: number,
  payeeId: number
) {
  const pairChannel = await fetchRawChannelBucketState(
    program,
    channelPda,
    payerId,
    payeeId
  );
  return normalizeDirectionalChannelState(pairChannel, payerId, payeeId);
}

function deriveWalletBlsKeypair(wallet: Keypair): {
  secretScalar: bigint;
  publicKeyCompressed: Buffer;
} {
  const keypair = createBlsKeypairFromSeed(
    Buffer.concat([BLS_DEMO_KEY_DERIVATION_TAG, Buffer.from(wallet.secretKey)])
  );
  return {
    secretScalar: keypair.secretScalar,
    publicKeyCompressed: keypair.publicKeyCompressed,
  };
}

function signBlsMessage(
  wallet: Pick<DemoWallet, "blsSecretScalar">,
  message: Buffer | Uint8Array
): Buffer {
  return signSharedBlsMessage(
    { secretScalar: wallet.blsSecretScalar },
    message
  );
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

function sha256Bytes(data: Buffer | Uint8Array): number[] {
  return [...createHash("sha256").update(data).digest()];
}

function encodeCompactU64(value: bigint): number[] {
  if (value < 0n) {
    throw new Error("Compact values must be unsigned");
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0n);
  return bytes;
}

function signEd25519Message(message: Buffer, signer: Keypair): Buffer {
  const seed = signer.secretKey.slice(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  return Buffer.from(cryptoSign(null, message, privateKey));
}

function buildOrderedParticipantPairs<T>(participants: T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (let offset = 1; offset < participants.length; offset += 1) {
    for (
      let payerIndex = 0;
      payerIndex < participants.length;
      payerIndex += 1
    ) {
      pairs.push([
        participants[payerIndex],
        participants[(payerIndex + offset) % participants.length],
      ]);
    }
  }
  return pairs;
}

function buildBoundedDenseGraphPairs<T>(
  participants: T[],
  maxDirectedChannels: number
): Array<[T, T]> {
  const cappedMaxChannels = Math.min(
    maxDirectedChannels,
    participants.length * Math.max(0, participants.length - 1)
  );
  const selectedPairs: Array<[T, T]> = [];
  const seenPairKeys = new Set<string>();
  const appendPair = (payerIndex: number, payeeIndex: number): void => {
    if (
      payerIndex < 0 ||
      payeeIndex < 0 ||
      payerIndex >= participants.length ||
      payeeIndex >= participants.length ||
      payerIndex === payeeIndex
    ) {
      return;
    }
    const pairKey = `${payerIndex}->${payeeIndex}`;
    if (
      seenPairKeys.has(pairKey) ||
      selectedPairs.length >= cappedMaxChannels
    ) {
      return;
    }
    seenPairKeys.add(pairKey);
    selectedPairs.push([participants[payerIndex], participants[payeeIndex]]);
  };

  if (participants.length === 2) {
    appendPair(0, 1);
    appendPair(1, 0);
  } else if (participants.length >= 3) {
    appendPair(0, 1);
    appendPair(1, 2);
    appendPair(2, 0);
    for (
      let participantCount = 4;
      participantCount <= participants.length;
      participantCount += 1
    ) {
      appendPair(participantCount - 2, participantCount - 1);
      appendPair(participantCount - 1, 0);
    }
  }

  for (const [payer, payee] of buildOrderedParticipantPairs(participants)) {
    const payerIndex = participants.indexOf(payer);
    const payeeIndex = participants.indexOf(payee);
    appendPair(payerIndex, payeeIndex);
    if (selectedPairs.length >= cappedMaxChannels) {
      break;
    }
  }

  return selectedPairs;
}

function multilateralEdgeKey(
  payerParticipantId: number,
  payeeParticipantId: number
): string {
  return `${payerParticipantId}->${payeeParticipantId}`;
}

function deterministicRawChannelAmount(params: {
  seed: string;
  scenarioId: string;
  payer: DemoWallet;
  payee: DemoWallet;
  decimals: number;
  minAmount: number;
  maxAmount: number;
}): number {
  const minRaw = toRawAmount(params.minAmount, params.decimals);
  const maxRaw = toRawAmount(params.maxAmount, params.decimals);
  if (maxRaw <= minRaw) {
    return minRaw;
  }

  const digest = createHash("sha256")
    .update(params.seed)
    .update(":")
    .update(params.scenarioId)
    .update(":")
    .update(String(params.payer.participantId))
    .update("->")
    .update(String(params.payee.participantId))
    .digest();
  const span = BigInt(maxRaw - minRaw + 1);
  const offset = Number(
    BigInt(`0x${digest.subarray(0, 8).toString("hex")}`) % span
  );
  return minRaw + offset;
}

async function appendBlsSearchResult(
  outputPath: string,
  content: Record<string, unknown>
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(content)}\n`, "utf8");
}

function createBatchEd25519Instruction(
  signer: Keypair,
  messages: Buffer[]
): TransactionInstruction {
  const headerSize = 2 + 14 * messages.length;
  const blockSize = 32 + 64;
  const totalMessagesSize = messages.reduce((sum, msg) => sum + msg.length, 0);
  const blockStart = headerSize;
  const messageStart = blockStart + messages.length * blockSize;
  const data = Buffer.alloc(messageStart + totalMessagesSize);
  data[0] = messages.length;
  data[1] = 0;
  let runningMessageOffset = messageStart;
  for (let i = 0; i < messages.length; i += 1) {
    const entryOffset = 2 + i * 14;
    const publicKeyOffset = blockStart + i * blockSize;
    const signatureOffset = publicKeyOffset + 32;
    const signature = signEd25519Message(messages[i], signer);
    data.writeUInt16LE(signatureOffset, entryOffset);
    data.writeUInt16LE(0xffff, entryOffset + 2);
    data.writeUInt16LE(publicKeyOffset, entryOffset + 4);
    data.writeUInt16LE(0xffff, entryOffset + 6);
    data.writeUInt16LE(runningMessageOffset, entryOffset + 8);
    data.writeUInt16LE(messages[i].length, entryOffset + 10);
    data.writeUInt16LE(0xffff, entryOffset + 12);
    Buffer.from(signer.publicKey.toBytes()).copy(data, publicKeyOffset);
    signature.copy(data, signatureOffset);
    messages[i].copy(data, runningMessageOffset);
    runningMessageOffset += messages[i].length;
  }
  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

function createMultiSigEd25519Instruction(
  signers: Keypair[],
  message: Buffer
): TransactionInstruction {
  const headerSize = 2 + 14 * signers.length;
  const blockSize = 32 + 64;
  const messageOffset = headerSize + signers.length * blockSize;
  const data = Buffer.alloc(messageOffset + message.length);
  data[0] = signers.length;
  data[1] = 0;
  for (let i = 0; i < signers.length; i += 1) {
    const entryOffset = 2 + i * 14;
    const publicKeyOffset = headerSize + i * blockSize;
    const signatureOffset = publicKeyOffset + 32;
    const signature = signEd25519Message(message, signers[i]);
    data.writeUInt16LE(signatureOffset, entryOffset);
    data.writeUInt16LE(0xffff, entryOffset + 2);
    data.writeUInt16LE(publicKeyOffset, entryOffset + 4);
    data.writeUInt16LE(0xffff, entryOffset + 6);
    data.writeUInt16LE(messageOffset, entryOffset + 8);
    data.writeUInt16LE(message.length, entryOffset + 10);
    data.writeUInt16LE(0xffff, entryOffset + 12);
    Buffer.from(signers[i].publicKey.toBytes()).copy(data, publicKeyOffset);
    signature.copy(data, signatureOffset);
  }
  message.copy(data, messageOffset);
  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

function createMultiMessageEd25519Instruction(
  entries: { signer: Keypair; message: Buffer }[]
): TransactionInstruction {
  const headerSize = 2 + 14 * entries.length;
  let cursor = headerSize;
  const buffers: Buffer[] = [];
  const rows: Array<{
    signatureOffset: number;
    publicKeyOffset: number;
    messageOffset: number;
    messageLength: number;
  }> = [];

  for (const entry of entries) {
    const publicKeyOffset = cursor;
    const signatureOffset = publicKeyOffset + 32;
    const messageOffset = signatureOffset + 64;
    const signature = signEd25519Message(entry.message, entry.signer);

    buffers.push(
      Buffer.from(entry.signer.publicKey.toBytes()),
      Buffer.from(signature),
      entry.message
    );
    rows.push({
      signatureOffset,
      publicKeyOffset,
      messageOffset,
      messageLength: entry.message.length,
    });
    cursor = messageOffset + entry.message.length;
  }

  const data = Buffer.alloc(cursor);
  data[0] = entries.length;
  data[1] = 0;

  rows.forEach((row, index) => {
    const headerOffset = 2 + index * 14;
    data.writeUInt16LE(row.signatureOffset, headerOffset);
    data.writeUInt16LE(0xffff, headerOffset + 2);
    data.writeUInt16LE(row.publicKeyOffset, headerOffset + 4);
    data.writeUInt16LE(0xffff, headerOffset + 6);
    data.writeUInt16LE(row.messageOffset, headerOffset + 8);
    data.writeUInt16LE(row.messageLength, headerOffset + 10);
    data.writeUInt16LE(0xffff, headerOffset + 12);
  });

  let writeOffset = headerSize;
  for (const buffer of buffers) {
    buffer.copy(data, writeOffset);
    writeOffset += buffer.length;
  }

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

function createCommitmentMessage(params: {
  payerId: number;
  payeeId: number;
  committedAmount?: number;
  amount?: number;
  tokenId: number;
  messageDomain: Buffer | Uint8Array;
}): Buffer {
  const committedAmount = params.committedAmount ?? params.amount;
  if (committedAmount === undefined) {
    throw new Error(
      "createCommitmentMessage requires committedAmount (or amount alias)"
    );
  }
  return Buffer.concat([
    Buffer.from([0x01, 0x05]),
    Buffer.from(params.messageDomain),
    Buffer.from([0x00]),
    Buffer.from(encodeCompactU64(BigInt(params.payerId))),
    Buffer.from(encodeCompactU64(BigInt(params.payeeId))),
    new anchor.BN(params.tokenId).toArrayLike(Buffer, "le", 2),
    Buffer.from(encodeCompactU64(BigInt(committedAmount))),
  ]);
}

function createClearingRoundMessage(params: {
  tokenId: number;
  messageDomain: Buffer | Uint8Array;
  blocks: ParticipantBlockSpec[];
  version?: number;
}): Buffer {
  const dynamicParts: number[] = [];
  for (const block of params.blocks) {
    dynamicParts.push(...encodeCompactU64(BigInt(block.participantId)));
    dynamicParts.push(block.entries.length & 0xff);
    for (const entry of block.entries) {
      dynamicParts.push(entry.payeeRef & 0xff);
      dynamicParts.push(...encodeCompactU64(BigInt(entry.targetCumulative)));
    }
  }

  return Buffer.concat([
    Buffer.from([0x02, params.version ?? 0x04]),
    Buffer.from(params.messageDomain),
    new anchor.BN(params.tokenId).toArrayLike(Buffer, "le", 2),
    Buffer.from([params.blocks.length & 0xff]),
    Buffer.from(dynamicParts),
  ]);
}

function toRawAmount(amount: number, decimals: number): number {
  const raw = Math.round(amount * 10 ** decimals);
  if (!Number.isSafeInteger(raw)) {
    throw new Error(`Amount ${amount} is not safely representable`);
  }
  return raw;
}

function formatAmount(rawAmount: number | bigint, decimals: number): string {
  const raw = rawAmount.toString();
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fractional = padded.slice(padded.length - decimals).replace(/0+$/g, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : whole;
}

function formatUsd(amount: number): string {
  if (amount >= 1000) {
    return `$${amount.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (amount >= 1) {
    return `$${amount.toFixed(2)}`;
  }
  if (amount >= 0.01) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(6)}`;
}

function trimHex(value: string, visible = 10): string {
  if (value.length <= visible * 2 + 3) {
    return value;
  }
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function formatCompressionRatio(value: number): string {
  if (!Number.isFinite(value)) {
    return "inf";
  }
  if (value >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (value >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function buildSignedCommitmentPreview(params: {
  messageDomain: Buffer;
  decimals: number;
  tokenSymbol: string;
  inputs: SignedCommitmentPreviewInput[];
}): SignedCommitmentPreview {
  if (params.inputs.length === 0) {
    throw new Error("At least one commitment preview input is required");
  }

  const entries = params.inputs.map((input) => {
    const message = createCommitmentMessage({
      payerId: input.payer.participantId,
      payeeId: input.payee.participantId,
      committedAmount: input.committedAmount,
      tokenId: input.tokenId,
      messageDomain: params.messageDomain,
    });
    return {
      signedBy: input.payer.name,
      payload: {
        kind: 0x01,
        version: 0x04,
        messageDomain: trimHex(params.messageDomain.toString("hex")),
        flags: 0,
        payer: input.payer.name,
        payee: input.payee.name,
        payerId: input.payer.participantId,
        payeeId: input.payee.participantId,
        tokenId: input.tokenId,
        committedAmount: `${formatAmount(
          input.committedAmount,
          params.decimals
        )} ${params.tokenSymbol}`,
      },
      signature: trimHex(
        `0x${signEd25519Message(message, input.payer.keypair).toString("hex")}`
      ),
    };
  });

  return {
    example: entries[0],
    signatures: entries.map((entry) => entry.signature),
  };
}

function buildCommitmentBundlePayloadPreview(params: {
  messageDomain: Buffer;
  decimals: number;
  tokenId: number;
  tokenSymbol: string;
  payee: DemoWallet;
  inputs: SignedCommitmentPreviewInput[];
}): CommitmentBundlePayloadPreview {
  return {
    kind: 0x01,
    version: 0x04,
    messageDomain: trimHex(params.messageDomain.toString("hex")),
    payee: params.payee.name,
    payeeId: params.payee.participantId,
    tokenId: params.tokenId,
    token: params.tokenSymbol,
    entryCount: params.inputs.length,
    entries: params.inputs.map((input) => {
      const message = createCommitmentMessage({
        payerId: input.payer.participantId,
        payeeId: input.payee.participantId,
        committedAmount: input.committedAmount,
        tokenId: input.tokenId,
        messageDomain: params.messageDomain,
      });
      return {
        signedBy: input.payer.name,
        payerId: input.payer.participantId,
        committedAmount: `${formatAmount(
          input.committedAmount,
          params.decimals
        )} ${params.tokenSymbol}`,
        signature: trimHex(
          `0x${signEd25519Message(message, input.payer.keypair).toString(
            "hex"
          )}`
        ),
      };
    }),
  };
}

function buildClearingRoundPayloadPreview(params: {
  messageDomain: Buffer;
  tokenId: number;
  tokenSymbol: string;
  decimals: number;
  blocks: ClearingRoundPreviewBlockInput[];
  version?: number;
  aggregateSignature?: Buffer | Uint8Array;
}): ClearingRoundPayloadPreview {
  const activeBlocks = params.blocks.filter(
    (block) => block.entries.length > 0
  );
  const message = createClearingRoundMessage({
    tokenId: params.tokenId,
    messageDomain: params.messageDomain,
    version: params.version,
    blocks: params.blocks.map((block) => ({
      participantId: block.participant.participantId,
      entries: block.entries.map((entry) => ({
        payeeRef: entry.payeeRef,
        targetCumulative: entry.targetCumulative,
      })),
    })),
  });

  return {
    kind: 0x02,
    version: params.version ?? 0x04,
    messageDomain: trimHex(params.messageDomain.toString("hex")),
    tokenId: params.tokenId,
    token: params.tokenSymbol,
    participantCount: params.blocks.length,
    channelCount: params.blocks.reduce(
      (sum, block) => sum + block.entries.length,
      0
    ),
    cosignedBy: activeBlocks.map((block) => block.participant.name),
    participantBlocks: params.blocks.map((block) => ({
      participant: block.participant.name,
      participantId: block.participant.participantId,
      entryCount: block.entries.length,
      entries: block.entries.map((entry) => ({
        channel: `${block.participant.name}->${entry.payee.name}`,
        payeeRef: entry.payeeRef,
        targetCumulative: `${formatAmount(
          entry.targetCumulative,
          params.decimals
        )} ${params.tokenSymbol}`,
      })),
    })),
    signatures: params.aggregateSignature
      ? [trimHex(`0x${Buffer.from(params.aggregateSignature).toString("hex")}`)]
      : activeBlocks.map((block) =>
          trimHex(
            `0x${signEd25519Message(
              message,
              block.participant.keypair
            ).toString("hex")}`
          )
        ),
  };
}

function logJsonBlock(label: string, value: unknown): void {
  logStep(label);
  const json = JSON.stringify(value, null, 2);
  for (const line of json.split("\n")) {
    logStep(`    ${line}`);
  }
}

function logSignedCommitmentPreview(preview: SignedCommitmentPreview): void {
  logJsonBlock("  Example signed commitment payload:", preview.example);
  logStep(
    `  Example commitment signatures: [${preview.signatures.join(", ")}]`
  );
}

function logCommitmentBundlePayloadPreview(
  preview: CommitmentBundlePayloadPreview
): void {
  logJsonBlock("  What buyers sign before bundle settlement:", preview);
}

function logClearingRoundPayloadPreview(
  preview: ClearingRoundPayloadPreview
): void {
  logJsonBlock("  What agents co-sign in the clearing round:", preview);
}

function logCapacityMeasurement(
  label: string,
  measurement: {
    participantCount: number;
    channelCount: number;
    messageBytes: number;
    authEnvelopeBytes: number;
    serializedTxBytes: number;
    remainingBytes: number;
    participantBucketCount?: number;
    channelBucketCount?: number;
    dynamicWritableAccountCount?: number;
    fits?: boolean;
  }
): void {
  const bucketSummary =
    measurement.dynamicWritableAccountCount === undefined
      ? ""
      : `, bucket locks ${measurement.dynamicWritableAccountCount} (${measurement.participantBucketCount} participant + ${measurement.channelBucketCount} channel)`;
  logStep(
    `${label}: ${measurement.participantCount} participants, ${measurement.channelCount} channels, ${measurement.serializedTxBytes}/${LEGACY_PACKET_DATA_SIZE} bytes ` +
      `(${
        measurement.fits === false
          ? `${Math.abs(measurement.remainingBytes)} bytes over limit`
          : `${measurement.remainingBytes} bytes headroom`
      }, round message ${measurement.messageBytes} bytes, auth envelope ${
        measurement.authEnvelopeBytes
      } bytes${bucketSummary})`
  );
}

function determineMultilateralSearchTargets(
  summary: ClearingRoundCapacitySummary,
  availableParticipants: number
): MultilateralSearchTarget {
  const balancedParticipantCount = Math.max(
    3,
    Math.min(summary.blsV0AltCycle.participantCount, availableParticipants)
  );
  const balancedChannelCount = Math.min(
    summary.blsV0AltCycle.channelCount,
    balancedParticipantCount * (balancedParticipantCount - 1)
  );
  const overallParticipantCount = Math.max(
    3,
    Math.min(summary.blsV0AltOverall.participantCount, availableParticipants)
  );
  const overallChannelCount = Math.min(
    summary.blsV0AltOverall.channelCount,
    overallParticipantCount * (overallParticipantCount - 1)
  );

  return {
    balanced: {
      participantCount: balancedParticipantCount,
      channelCount: balancedChannelCount,
    },
    overall: {
      participantCount: overallParticipantCount,
      channelCount: overallChannelCount,
    },
  };
}

function logClearingRoundCapacityAnalysis(
  programId: PublicKey,
  summary: ClearingRoundCapacitySummary,
  maxParticipantScenario: MultilateralScenarioResult,
  maxChannelScenario: MultilateralScenarioResult
): void {
  const requestedMaxParticipantsV0Alt = measureClearingRoundCapacity({
    programId,
    mode: "hypothetical-bls-v0-alt",
    participantCount:
      maxParticipantScenario.benchmark.requestedShape?.participantCount ??
      maxParticipantScenario.benchmark.participantCount,
    channelCount:
      maxParticipantScenario.benchmark.requestedShape?.channelCount ??
      maxParticipantScenario.benchmark.channelCount,
  });
  const liveMaxParticipantsV0Alt = measureClearingRoundCapacity({
    programId,
    mode: "hypothetical-bls-v0-alt",
    participantCount:
      maxParticipantScenario.benchmark.achievedShape?.participantCount ??
      maxParticipantScenario.benchmark.participantCount,
    channelCount:
      maxParticipantScenario.benchmark.achievedShape?.channelCount ??
      maxParticipantScenario.settledChannelCount,
  });
  const requestedMaxChannelsV0Alt = measureClearingRoundCapacity({
    programId,
    mode: "hypothetical-bls-v0-alt",
    participantCount:
      maxChannelScenario.benchmark.requestedShape?.participantCount ??
      maxChannelScenario.benchmark.participantCount,
    channelCount:
      maxChannelScenario.benchmark.requestedShape?.channelCount ??
      maxChannelScenario.benchmark.channelCount,
  });
  const liveMaxChannelsV0Alt = measureClearingRoundCapacity({
    programId,
    mode: "hypothetical-bls-v0-alt",
    participantCount:
      maxChannelScenario.benchmark.achievedShape?.participantCount ??
      maxChannelScenario.benchmark.participantCount,
    channelCount:
      maxChannelScenario.benchmark.achievedShape?.channelCount ??
      maxChannelScenario.settledChannelCount,
  });

  logSection("Clearing Round Capacity");
  logStep(
    "The live devnet submission path is now BLS-backed v0 + ALT: one shared clearing-round message, one aggregate signature, inline BLS keys in participant buckets, and bucketed channel-state updates."
  );
  logStep(
    "These numbers model bucket locks as participant buckets plus channel buckets, then show what the demo actually executed on devnet."
  );
  logCapacityMeasurement(
    "BLS v0 + ALT balanced ceiling",
    summary.blsV0AltCycle
  );
  logCapacityMeasurement(
    "BLS v0 + ALT overall ceiling",
    summary.blsV0AltOverall
  );
  logCapacityMeasurement(
    "Live BLS max-participants request",
    requestedMaxParticipantsV0Alt
  );
  logCapacityMeasurement(
    "Live BLS max-participants executed",
    liveMaxParticipantsV0Alt
  );
  logCapacityMeasurement(
    "Live BLS max-channels request",
    requestedMaxChannelsV0Alt
  );
  logCapacityMeasurement(
    "Live BLS max-channels executed",
    liveMaxChannelsV0Alt
  );
  if (
    maxParticipantScenario.benchmark.participantCount !==
      summary.blsV0AltCycle.participantCount ||
    maxChannelScenario.benchmark.channelCount !==
      summary.blsV0AltOverall.channelCount
  ) {
    logStep(
      "The live devnet run found a smaller executable shape than the raw BLS byte model in at least one path, which means runtime/compute overhead is now the next scaling constraint after bucketed account compression."
    );
  } else {
    logStep(
      "The live devnet run matched the current BLS byte model for both the max-participants and max-channels showcase rounds."
    );
  }
  logStep(
    `BLS-only bucketed byte model: balanced v0 + ALT rounds fit ${summary.blsV0AltCycle.participantCount} participants / ${summary.blsV0AltCycle.channelCount} channels, and overall v0 + ALT rounds fit ${summary.blsV0AltOverall.participantCount} participants / ${summary.blsV0AltOverall.channelCount} directed channels before byte limits.`
  );
}

function createBenchmarkScenario(params: {
  id: DemoBenchmarkScenario["id"];
  title: string;
  settlementMode: DemoBenchmarkScenario["settlementMode"];
  participantCount: number;
  channelCount: number;
  underlyingPaymentCount: number;
  grossValueRaw: number;
  decimals: number;
  tokenSymbol: string;
  signatures: string[];
  serializedTransactionBytes: number[];
  signedMessageBytes: number;
  signatureCount: number;
  participantBalanceWrites: number;
  channelLaneWrites: number;
  notes?: string[];
  requestedShape?: BenchmarkShape;
  achievedShape?: BenchmarkShape;
}): DemoBenchmarkScenario {
  const savings = computeSavingsMetrics({
    underlyingPaymentCount: params.underlyingPaymentCount,
    settlementTransactionCount: params.signatures.length,
  });

  return {
    id: params.id,
    title: params.title,
    settlementMode: params.settlementMode,
    participantCount: params.participantCount,
    channelCount: params.channelCount,
    underlyingPaymentCount: params.underlyingPaymentCount,
    grossValueRaw: params.grossValueRaw.toString(),
    grossValueFormatted: `${formatAmount(
      params.grossValueRaw,
      params.decimals
    )} ${params.tokenSymbol}`,
    settlementTransactionCount: params.signatures.length,
    signatures: params.signatures,
    explorerLinks: params.signatures.map((signature) => explorerUrl(signature)),
    serializedTransactionBytes: params.serializedTransactionBytes,
    totalSerializedTransactionBytes: params.serializedTransactionBytes.reduce(
      (sum, value) => sum + value,
      0
    ),
    signedMessageBytes: params.signedMessageBytes,
    signatureCount: params.signatureCount,
    participantBalanceWrites: params.participantBalanceWrites,
    channelLaneWrites: params.channelLaneWrites,
    baselineModel: savings.baselineModel,
    savings,
    notes: params.notes ?? [],
    requestedShape: params.requestedShape,
    achievedShape: params.achievedShape,
  };
}

function logSavingsComparison(
  totalCommitments: number,
  ryvoTransactionCount: number,
  ryvoDescription: string
): void {
  const x402Cost = totalCommitments * X402_SOLANA_COST_PER_TX_USD;
  const ryvoCost = ryvoTransactionCount * X402_SOLANA_COST_PER_TX_USD;
  const savings = x402Cost - ryvoCost;
  const savedTransactions = totalCommitments - ryvoTransactionCount;
  const reductionPercent = (savedTransactions / totalCommitments) * 100;
  const compressionRatio = totalCommitments / ryvoTransactionCount;

  logStep(
    `  Traditional x402-style onchain baseline: ${totalCommitments.toLocaleString(
      "en-US"
    )} txs ~= ${formatUsd(x402Cost)} at ${formatUsd(
      X402_SOLANA_COST_PER_TX_USD
    )}/tx`
  );
  logStep(
    `  Ryvo settlement path: ${ryvoTransactionCount.toLocaleString(
      "en-US"
    )} tx${
      ryvoTransactionCount === 1 ? "" : "s"
    } (${ryvoDescription}) ~= ${formatUsd(ryvoCost)}`
  );
  logStep(
    `  Estimated savings: ${formatUsd(
      savings
    )}, ${savedTransactions.toLocaleString(
      "en-US"
    )} fewer txs, ${reductionPercent.toFixed(
      5
    )}% reduction, ${formatCompressionRatio(compressionRatio)}x compression`
  );
}

function logSection(title: string): void {
  console.log("");
  console.log("=".repeat(80));
  console.log(title);
  console.log("=".repeat(80));
}

function logStep(message: string): void {
  console.log(`[demo] ${message}`);
}

function explorerUrl(signature: string): string {
  return buildExplorerUrl(signature, "devnet");
}

function buildBlsExecutionInstructions(
  computeUnitLimit: number,
  mainInstruction: TransactionInstruction
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.requestHeapFrame({
      bytes: 256 * 1024,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnitLimit,
    }),
    mainInstruction,
  ];
}

function readRawU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function readRawU64Bn(data: Buffer, offset: number): anchor.BN {
  return new anchor.BN(data.readBigUInt64LE(offset).toString());
}

function readRawI64Bn(data: Buffer, offset: number): anchor.BN {
  return new anchor.BN(data.readBigInt64LE(offset).toString());
}

function readRawPubkey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

async function fetchAccountData(
  connection: Connection,
  pubkey: PublicKey,
  label: string
): Promise<Buffer> {
  const accountInfo = await connection.getAccountInfo(pubkey, "confirmed");
  if (!accountInfo || !(accountInfo.data instanceof Buffer)) {
    throw new Error(`Missing ${label} account data for ${pubkey.toString()}`);
  }
  return accountInfo.data;
}

class ChannelBucketSlotNotInitializedError extends Error {
  constructor(slotIndex: number, payerId: number, payeeId: number) {
    super(
      `Channel bucket slot ${slotIndex} is not initialized for ${payerId}->${payeeId}`
    );
    this.name = "ChannelBucketSlotNotInitializedError";
  }
}

function isChannelBucketSlotNotInitializedError(error: unknown): boolean {
  return error instanceof ChannelBucketSlotNotInitializedError;
}

function formatDecodeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function verifyRawChannelBucketHeader(
  data: Buffer,
  expectedBucketId: number,
  expectedTokenId?: number
): number {
  if (data.length < CHANNEL_BUCKET_SPACE) {
    throw new Error(
      `channel bucket data is too short: ${data.length} bytes, expected at least ${CHANNEL_BUCKET_SPACE}`
    );
  }
  if (
    !data
      .subarray(0, CHANNEL_BUCKET_DISCRIMINATOR.length)
      .equals(CHANNEL_BUCKET_DISCRIMINATOR)
  ) {
    throw new Error("channel bucket discriminator does not match v2 layout");
  }

  const actualTokenId = data.readUInt16LE(CHANNEL_BUCKET_TOKEN_ID_OFFSET);
  const actualBucketId = data.readBigUInt64LE(CHANNEL_BUCKET_ID_OFFSET);
  if (actualBucketId !== BigInt(expectedBucketId)) {
    throw new Error(
      `channel bucket id mismatch: expected ${expectedBucketId}, got ${actualBucketId.toString()}`
    );
  }
  if (expectedTokenId !== undefined && actualTokenId !== expectedTokenId) {
    throw new Error(
      `channel bucket token mismatch: expected ${expectedTokenId}, got ${actualTokenId}`
    );
  }

  return actualTokenId;
}

function readRawParticipantBucketSlot(data: Buffer, participantId: number) {
  const slotsDataOffset = 13;
  const slotSize = 1079;
  const slotOffset =
    slotsDataOffset + participantBucketSlotIndex(participantId) * slotSize;
  const initialized = data[slotOffset] !== 0;
  const actualParticipantId = data.readUInt32LE(slotOffset + 33);
  if (!initialized || actualParticipantId !== participantId) {
    throw new Error(`Participant slot ${participantId} is not initialized`);
  }

  const tokenBalances = Array.from({ length: 16 }, (_, index) => {
    const offset = slotOffset + 135 + index * 59;
    return {
      initialized: data[offset] !== 0,
      tokenId: data.readUInt16LE(offset + 1),
      availableBalance: readRawU64Bn(data, offset + 3),
      withdrawingBalance: readRawU64Bn(data, offset + 11),
      withdrawalUnlockAt: readRawI64Bn(data, offset + 19),
      withdrawalDestination: readRawPubkey(data, offset + 27),
    };
  });

  return {
    initialized,
    owner: readRawPubkey(data, slotOffset + 1),
    participantId: actualParticipantId,
    inboundChannelPolicy: data[slotOffset + 37],
    blsSchemeVersion: data[slotOffset + 38],
    blsPubkeyCompressed: Array.from(
      data.subarray(slotOffset + 39, slotOffset + 135)
    ),
    tokenBalances,
  };
}

function readRawDirectionalLaneState(data: Buffer, laneOffset: number) {
  return {
    initialized:
      data[laneOffset + CHANNEL_BUCKET_LANE_INITIALIZED_OFFSET] !== 0,
    settledCumulative: readRawU64Bn(data, laneOffset + 1),
    lockedBalance: readRawU64Bn(data, laneOffset + 9),
    authorizedSigner: readRawPubkey(data, laneOffset + 17),
    pendingUnlockAmount: readRawU64Bn(data, laneOffset + 49),
    unlockRequestedAt: readRawI64Bn(data, laneOffset + 57),
    pendingAuthorizedSigner: readRawPubkey(data, laneOffset + 65),
    authorizedSignerUpdateRequestedAt: readRawI64Bn(data, laneOffset + 97),
  };
}

function readRawChannelBucketState(
  data: Buffer,
  payerId: number,
  payeeId: number
) {
  const { lowerParticipantId, higherParticipantId } =
    getCanonicalChannelParticipants(payerId, payeeId);
  const tokenId = verifyRawChannelBucketHeader(
    data,
    channelBucketIdForPair(payerId, payeeId)
  );
  const slotIndex = channelBucketSlotIndexForPair(payerId, payeeId);
  const slotOffset =
    CHANNEL_BUCKET_SLOTS_OFFSET + slotIndex * CHANNEL_BUCKET_SLOT_SIZE;
  const initialized =
    data[slotOffset + CHANNEL_BUCKET_SLOT_INITIALIZED_OFFSET] !== 0;
  const actualLowerParticipantId = data.readUInt32LE(
    slotOffset + CHANNEL_BUCKET_SLOT_LOWER_PARTICIPANT_ID_OFFSET
  );
  const actualHigherParticipantId = data.readUInt32LE(
    slotOffset + CHANNEL_BUCKET_SLOT_HIGHER_PARTICIPANT_ID_OFFSET
  );
  if (!initialized) {
    throw new ChannelBucketSlotNotInitializedError(slotIndex, payerId, payeeId);
  }
  if (
    actualLowerParticipantId !== lowerParticipantId ||
    actualHigherParticipantId !== higherParticipantId
  ) {
    throw new Error(
      `channel bucket slot ${slotIndex} mismatch: expected ${lowerParticipantId}-${higherParticipantId}, got ${actualLowerParticipantId}-${actualHigherParticipantId}`
    );
  }

  return {
    tokenId,
    lowerParticipantId,
    higherParticipantId,
    lowerToHigher: readRawDirectionalLaneState(
      data,
      slotOffset + CHANNEL_BUCKET_LOWER_TO_HIGHER_LANE_OFFSET
    ),
    higherToLower: readRawDirectionalLaneState(
      data,
      slotOffset + CHANNEL_BUCKET_HIGHER_TO_LOWER_LANE_OFFSET
    ),
  };
}

async function fetchRawChannelBucketState(
  program: Program<RyvoProtocol>,
  channelPda: PublicKey,
  payerId: number,
  payeeId: number
) {
  const data = await fetchAccountData(
    program.provider.connection,
    channelPda,
    "channel bucket"
  );
  return readRawChannelBucketState(data, payerId, payeeId);
}

function readRawParticipantBucketTokenBalance(
  data: Buffer,
  participantId: number,
  tokenId: number
): { available: bigint; withdrawing: bigint } {
  const bucketIdOffset = 8;
  const slotsDataOffset = 13;
  const slotSize = 1079;
  const slotInitializedOffset = 0;
  const slotParticipantIdOffset = 33;
  const tokenBalancesOffset = 135;
  const tokenBalanceCount = 16;
  const tokenBalanceEntrySize = 59;
  const tokenBalanceInitializedOffset = 0;
  const tokenBalanceTokenIdOffset = 1;
  const tokenBalanceAvailableOffset = 3;
  const tokenBalanceWithdrawingOffset = 11;

  const expectedBucketId = participantBucketIdForParticipantId(participantId);
  const actualBucketId = data.readUInt32LE(bucketIdOffset);
  if (actualBucketId !== expectedBucketId) {
    throw new Error(
      `Participant bucket id mismatch: expected ${expectedBucketId}, got ${actualBucketId}`
    );
  }

  const slotIndex = participantBucketSlotIndex(participantId);
  const slotOffset = slotsDataOffset + slotIndex * slotSize;
  const isInitialized = data[slotOffset + slotInitializedOffset] !== 0;
  const actualParticipantId = data.readUInt32LE(
    slotOffset + slotParticipantIdOffset
  );
  if (!isInitialized || actualParticipantId !== participantId) {
    throw new Error(
      `Participant bucket slot ${slotIndex} is not initialized for participant ${participantId}`
    );
  }

  let cursor = slotOffset + tokenBalancesOffset;
  for (let index = 0; index < tokenBalanceCount; index += 1) {
    const initialized = data[cursor + tokenBalanceInitializedOffset] !== 0;
    const entryTokenId = data.readUInt16LE(cursor + tokenBalanceTokenIdOffset);
    if (initialized && entryTokenId === tokenId) {
      return {
        available: readRawU64(data, cursor + tokenBalanceAvailableOffset),
        withdrawing: readRawU64(data, cursor + tokenBalanceWithdrawingOffset),
      };
    }
    cursor += tokenBalanceEntrySize;
  }

  return {
    available: 0n,
    withdrawing: 0n,
  };
}

function readRawChannelBucketLaneState(
  data: Buffer,
  payerId: number,
  payeeId: number
): {
  settledCumulative: bigint;
  lockedBalance: bigint;
} {
  const { lowerParticipantId, higherParticipantId } =
    getCanonicalChannelParticipants(payerId, payeeId);

  const expectedBucketId = channelBucketIdForPair(payerId, payeeId);
  verifyRawChannelBucketHeader(data, expectedBucketId);

  const slotIndex = channelBucketSlotIndexForPair(payerId, payeeId);
  const slotOffset =
    CHANNEL_BUCKET_SLOTS_OFFSET + slotIndex * CHANNEL_BUCKET_SLOT_SIZE;
  const isInitialized =
    data[slotOffset + CHANNEL_BUCKET_SLOT_INITIALIZED_OFFSET] !== 0;
  const actualLowerParticipantId = data.readUInt32LE(
    slotOffset + CHANNEL_BUCKET_SLOT_LOWER_PARTICIPANT_ID_OFFSET
  );
  const actualHigherParticipantId = data.readUInt32LE(
    slotOffset + CHANNEL_BUCKET_SLOT_HIGHER_PARTICIPANT_ID_OFFSET
  );
  if (!isInitialized) {
    throw new ChannelBucketSlotNotInitializedError(slotIndex, payerId, payeeId);
  }
  if (
    actualLowerParticipantId !== lowerParticipantId ||
    actualHigherParticipantId !== higherParticipantId
  ) {
    throw new Error(
      `channel bucket slot ${slotIndex} mismatch: expected ${lowerParticipantId}-${higherParticipantId}, got ${actualLowerParticipantId}-${actualHigherParticipantId}`
    );
  }

  const laneOffset =
    payerId < payeeId
      ? CHANNEL_BUCKET_LOWER_TO_HIGHER_LANE_OFFSET
      : CHANNEL_BUCKET_HIGHER_TO_LOWER_LANE_OFFSET;
  const laneBaseOffset = slotOffset + laneOffset;
  return {
    settledCumulative: readRawU64(
      data,
      laneBaseOffset + CHANNEL_BUCKET_LANE_SETTLED_CUMULATIVE_OFFSET
    ),
    lockedBalance: readRawU64(
      data,
      laneBaseOffset + CHANNEL_BUCKET_LANE_LOCKED_BALANCE_OFFSET
    ),
  };
}

async function fetchAccountInfosByKey(
  connection: Connection,
  pubkeys: PublicKey[]
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const chunkSize = 100;
  for (let offset = 0; offset < pubkeys.length; offset += chunkSize) {
    const chunk = pubkeys.slice(offset, offset + chunkSize);
    const accounts = await connection.getMultipleAccountsInfo(
      chunk,
      "confirmed"
    );
    accounts.forEach((accountInfo, index) => {
      if (!accountInfo || !(accountInfo.data instanceof Buffer)) {
        throw new Error(
          `Missing account data for ${chunk[
            index
          ].toString()} during RPC verification`
        );
      }
      result.set(chunk[index].toString(), accountInfo.data);
    });
  }
  return result;
}

async function verifyMultilateralStateViaRpc(
  connection: Connection,
  tokenId: number,
  preparedRound: MultilateralPreparedRound,
  participantBalancesBefore: Array<{
    participant: DemoWallet;
    balance: TokenBalanceView;
  }>,
  participantBalancesAfter: Array<{
    participant: DemoWallet;
    balance: TokenBalanceView;
  }>,
  channelEdgesAfter: Array<
    MultilateralChannelEdge & {
      afterChannel: any;
    }
  >
): Promise<RpcSettlementVerification> {
  const participantBucketAccounts = await fetchAccountInfosByKey(
    connection,
    preparedRound.participants.map((participant) => participant.participantPda)
  );
  const channelBucketAccounts = await fetchAccountInfosByKey(
    connection,
    preparedRound.edges.map((edge) => edge.channelPda)
  );

  const participantChecks = participantBalancesAfter.map(
    ({ participant, balance }, index) => {
      const rawAccount = participantBucketAccounts.get(
        participant.participantPda.toString()
      );
      if (!rawAccount) {
        throw new Error(
          `Missing participant bucket ${participant.participantPda.toString()} during RPC verification`
        );
      }
      const rawBalance = readRawParticipantBucketTokenBalance(
        rawAccount,
        participant.participantId,
        tokenId
      );
      return {
        name: participant.name,
        participantPda: participant.participantPda,
        beforeAvailable: BigInt(
          participantBalancesBefore[index].balance.available
        ),
        afterAnchorAvailable: BigInt(balance.available),
        afterRpcAvailable: rawBalance.available,
        beforeWithdrawing: BigInt(
          participantBalancesBefore[index].balance.withdrawing
        ),
        afterAnchorWithdrawing: BigInt(balance.withdrawing),
        afterRpcWithdrawing: rawBalance.withdrawing,
        matchesAnchor:
          BigInt(balance.available) === rawBalance.available &&
          BigInt(balance.withdrawing) === rawBalance.withdrawing,
      };
    }
  );

  const channelChecks = channelEdgesAfter.map(
    ({ payer, payee, channelPda, channel, afterChannel }) => {
      const rawAccount = channelBucketAccounts.get(channelPda.toString());
      if (!rawAccount) {
        throw new Error(
          `Missing channel bucket ${channelPda.toString()} during RPC verification`
        );
      }
      const rawChannel = readRawChannelBucketLaneState(
        rawAccount,
        payer.participantId,
        payee.participantId
      );
      return {
        channelLabel: `${payer.name}->${payee.name}`,
        channelPda,
        beforeSettledCumulative: BigInt(channel.settledCumulative.toNumber()),
        afterAnchorSettledCumulative: BigInt(
          afterChannel.settledCumulative.toNumber()
        ),
        afterRpcSettledCumulative: rawChannel.settledCumulative,
        matchesAnchor:
          BigInt(afterChannel.settledCumulative.toNumber()) ===
          rawChannel.settledCumulative,
      };
    }
  );

  return {
    participantChecks,
    channelChecks,
  };
}

function logRpcSettlementVerification(
  verification: RpcSettlementVerification,
  decimals: number,
  tokenSymbol: string
): void {
  const participantMismatches = verification.participantChecks.filter(
    (check) => !check.matchesAnchor
  );
  const channelMismatches = verification.channelChecks.filter(
    (check) => !check.matchesAnchor
  );

  logSection("RPC Verification");
  logStep(
    `Decoded ${verification.participantChecks.length} participant bucket slots and ${verification.channelChecks.length} channel bucket lanes directly from RPC account bytes`
  );

  verification.participantChecks.forEach((check) => {
    logStep(
      `  RPC ${
        check.name
      } ${check.participantPda.toString()}: available ${formatAmount(
        check.beforeAvailable,
        decimals
      )} -> ${formatAmount(
        check.afterRpcAvailable,
        decimals
      )} ${tokenSymbol} (Anchor ${formatAmount(
        check.afterAnchorAvailable,
        decimals
      )}, match=${check.matchesAnchor ? "yes" : "no"})`
    );
  });

  const channelChecksToLog =
    verification.channelChecks.length <= 12
      ? verification.channelChecks
      : verification.channelChecks.slice(0, 12);
  channelChecksToLog.forEach((check) => {
    logStep(
      `  RPC ${
        check.channelLabel
      } ${check.channelPda.toString()}: settled cumulative ${formatAmount(
        check.beforeSettledCumulative,
        decimals
      )} -> ${formatAmount(
        check.afterRpcSettledCumulative,
        decimals
      )} ${tokenSymbol} (Anchor ${formatAmount(
        check.afterAnchorSettledCumulative,
        decimals
      )}, match=${check.matchesAnchor ? "yes" : "no"})`
    );
  });
  if (verification.channelChecks.length > channelChecksToLog.length) {
    logStep(
      `  ... ${
        verification.channelChecks.length - channelChecksToLog.length
      } additional channels omitted from console output; all were RPC-verified`
    );
  }

  if (participantMismatches.length > 0 || channelMismatches.length > 0) {
    throw new Error(
      `RPC verification mismatch: ${participantMismatches.length} participant mismatches, ${channelMismatches.length} channel mismatches`
    );
  }

  logStep(
    "RPC verification passed: raw account bytes matched the reported BLS settlement state"
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConfirmationTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name.includes("TransactionExpiredTimeoutError") ||
    error.message.includes("was not confirmed in 30.00 seconds")
  );
}

function extractTimedOutSignature(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const match = error.message.match(
    /Check signature ([1-9A-HJ-NP-Za-km-z]{32,88})/
  );
  return match?.[1] ?? null;
}

async function waitForConfirmedSignature(
  connection: Connection,
  signature: string,
  label: string,
  timeoutMs = 120_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) {
      throw new Error(
        `${label} landed on-chain but failed: ${JSON.stringify(status.err)}`
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      logStep(
        `${label} recovered after RPC confirmation lag (${signature}, ${status.confirmationStatus})`
      );
      return signature;
    }
    await sleepMs(1_000);
  }

  throw new Error(
    `${label} exceeded the local confirmation timeout and never reached confirmed/finalized status for signature ${signature}`
  );
}

async function recoverTimedOutRpcSignature(
  connection: Connection,
  error: unknown,
  label: string
): Promise<string | null> {
  if (!isConfirmationTimeoutError(error)) {
    return null;
  }
  const signature = extractTimedOutSignature(error);
  if (!signature) {
    return null;
  }
  logStep(
    `${label} hit Anchor's 30s confirmation timeout; polling RPC directly for ${signature}`
  );
  return waitForConfirmedSignature(connection, signature, label);
}

async function fetchSerializedTransactionBytes(
  connection: Connection,
  signature: string
): Promise<number> {
  const response = await (connection as any)._rpcRequest("getTransaction", [
    signature,
    {
      commitment: "confirmed",
      encoding: "base64",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  const encoded = response?.result?.transaction;
  if (!Array.isArray(encoded) || typeof encoded[0] !== "string") {
    throw new Error(`Unable to fetch raw transaction bytes for ${signature}`);
  }
  return Buffer.from(encoded[0], "base64").length;
}

async function selectFeeSponsor(
  connection: Connection,
  candidates: Keypair[]
): Promise<Keypair> {
  const uniqueCandidates = new Map<string, Keypair>();
  for (const candidate of candidates) {
    uniqueCandidates.set(candidate.publicKey.toBase58(), candidate);
  }

  let bestCandidate: Keypair | null = null;
  let bestBalance = -1;
  for (const candidate of uniqueCandidates.values()) {
    const balance = await connection.getBalance(
      candidate.publicKey,
      "confirmed"
    );
    if (balance > bestBalance) {
      bestBalance = balance;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    throw new Error("No fee sponsor candidates were provided");
  }

  return bestCandidate;
}

async function parseProgramEvents(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  signature: string
): Promise<{ name: string; data: any }[]> {
  const transaction = await provider.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = transaction?.meta?.logMessages ?? [];
  const parser = new anchor.EventParser(program.programId, program.coder);
  return [...parser.parseLogs(logs)];
}

async function estimateSerializedTransactionBytes(
  connection: Connection,
  feePayer: Keypair,
  transaction: anchor.web3.Transaction,
  extraSigners: Keypair[]
): Promise<number> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = feePayer.publicKey;
  transaction.recentBlockhash = blockhash;
  transaction.partialSign(feePayer);
  if (extraSigners.length > 0) {
    transaction.partialSign(...extraSigners);
  }
  return transaction.serialize({
    requireAllSignatures: true,
    verifySignatures: false,
  }).length;
}

async function sendLegacyTransaction(
  connection: Connection,
  feePayer: Keypair,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = []
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    recentBlockhash: blockhash,
  }).add(...instructions);
  transaction.sign(feePayer, ...extraSigners);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      preflightCommitment: "confirmed",
    }
  );
  try {
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
  } catch (error) {
    if (!isConfirmationTimeoutError(error)) {
      throw error;
    }
    await waitForConfirmedSignature(
      connection,
      signature,
      "Legacy transaction"
    );
  }
  return signature;
}

async function createLookupTableForAddresses(
  connection: Connection,
  authority: Keypair,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount> {
  const recentSlotBackoffs = [5, 10, 20, 40];
  let lookupTableAddress: PublicKey | null = null;
  let created = false;
  let lastError: unknown = null;

  for (const backoff of recentSlotBackoffs) {
    const finalizedSlot = await connection.getSlot("finalized");
    const recentSlot = Math.max(0, finalizedSlot - backoff);
    const [createIx, candidateLookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: authority.publicKey,
        payer: payer.publicKey,
        recentSlot,
      });
    lookupTableAddress = candidateLookupTableAddress;

    try {
      await sendLegacyTransaction(
        connection,
        payer,
        [createIx],
        payer.publicKey.equals(authority.publicKey) ? [] : [authority]
      );
      created = true;
      break;
    } catch (error) {
      lastError = error;
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      if (!message.includes("not a recent slot")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (!created || !lookupTableAddress) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to create lookup table with a recent finalized slot");
  }

  const chunkSize = 20;
  let lastExtendObservedSlot = await connection.getSlot("confirmed");
  for (let offset = 0; offset < addresses.length; offset += chunkSize) {
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      authority: authority.publicKey,
      payer: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses: addresses.slice(offset, offset + chunkSize),
    });
    await sendLegacyTransaction(
      connection,
      payer,
      [extendIx],
      payer.publicKey.equals(authority.publicKey) ? [] : [authority]
    );
    lastExtendObservedSlot = await connection.getSlot("confirmed");
  }

  // Newly extended lookup-table addresses are not reliably usable until the
  // cluster advances beyond the slot that observed the last extension.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const currentSlot = await connection.getSlot("confirmed");
    if (currentSlot > lastExtendObservedSlot) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const lookupTable = (
    await connection.getAddressLookupTable(lookupTableAddress, {
      commitment: "confirmed",
    })
  ).value;
  if (!lookupTable) {
    throw new Error("Lookup table was created but could not be fetched");
  }
  return lookupTable;
}

async function createLookupTablesForAddresses(
  connection: Connection,
  authority: Keypair,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount[]> {
  const uniqueAddresses = Array.from(
    new Map(addresses.map((address) => [address.toString(), address])).values()
  );
  const lookupTables: AddressLookupTableAccount[] = [];
  const maxAddressesPerTable = 256;

  for (
    let offset = 0;
    offset < uniqueAddresses.length;
    offset += maxAddressesPerTable
  ) {
    lookupTables.push(
      await createLookupTableForAddresses(
        connection,
        authority,
        payer,
        uniqueAddresses.slice(offset, offset + maxAddressesPerTable)
      )
    );
  }

  return lookupTables;
}

async function estimateVersionedTransactionBytes(params: {
  connection: Connection;
  feePayer: Keypair;
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  extraSigners?: Keypair[];
}): Promise<number> {
  const { blockhash } = await params.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: params.feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: params.instructions,
  }).compileToV0Message(params.lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([params.feePayer, ...(params.extraSigners ?? [])]);
  return transaction.serialize().length;
}

async function simulateVersionedTransaction(params: {
  connection: Connection;
  feePayer: Keypair;
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  extraSigners?: Keypair[];
}): Promise<{
  ok: boolean;
  error: string | null;
  logs: string[];
}> {
  return withRpcRetry("simulate versioned transaction", async () => {
    const { blockhash } = await params.connection.getLatestBlockhash(
      "confirmed"
    );
    const message = new TransactionMessage({
      payerKey: params.feePayer.publicKey,
      recentBlockhash: blockhash,
      instructions: params.instructions,
    }).compileToV0Message(params.lookupTables);
    const transaction = new VersionedTransaction(message);
    transaction.sign([params.feePayer, ...(params.extraSigners ?? [])]);
    const simulation = await params.connection.simulateTransaction(
      transaction,
      {
        commitment: "confirmed",
        sigVerify: true,
      }
    );
    return {
      ok: simulation.value.err == null,
      error:
        simulation.value.err == null
          ? null
          : JSON.stringify(simulation.value.err),
      logs: simulation.value.logs ?? [],
    };
  });
}

async function getTransactionErrorLogs(
  connection: Connection,
  error: unknown
): Promise<string[]> {
  if (error instanceof SendTransactionError) {
    try {
      return await error.getLogs(connection);
    } catch {
      return error.logs ?? error.transactionError.logs ?? [];
    }
  }

  const maybeLogs =
    (error as any)?.logs ??
    (error as any)?.transactionError?.logs ??
    (error as any)?.data?.logs;
  return Array.isArray(maybeLogs) ? maybeLogs : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientRpcError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket") ||
    message.includes("429") ||
    message.includes("too many requests")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withRpcRetry<T>(
  label: string,
  operation: () => Promise<T>,
  maxAttempts = 4
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientRpcError(error) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = 400 * attempt;
      logStep(
        `${label} RPC attempt ${attempt}/${maxAttempts} failed transiently (${errorMessage(
          error
        )}); retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after ${maxAttempts} attempts`);
}

async function enrichTransactionError(
  connection: Connection,
  error: unknown
): Promise<Error> {
  const logs = await getTransactionErrorLogs(connection, error);
  const message = errorMessage(error);
  const enriched = new Error(
    logs.length > 0
      ? `${message}\nFull transaction logs:\n${JSON.stringify(logs, null, 2)}`
      : message
  );
  (enriched as any).cause = error;
  (enriched as any).logs = logs;
  return enriched;
}

async function sendVersionedTransaction(params: {
  connection: Connection;
  feePayer: Keypair;
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  extraSigners?: Keypair[];
  skipPreflight?: boolean;
}): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await withRpcRetry(
    "get latest blockhash",
    () => params.connection.getLatestBlockhash("confirmed")
  );
  const message = new TransactionMessage({
    payerKey: params.feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: params.instructions,
  }).compileToV0Message(params.lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([params.feePayer, ...(params.extraSigners ?? [])]);
  const serializedTransaction = transaction.serialize();
  try {
    const signature = await withRpcRetry("send raw transaction", () =>
      params.connection.sendRawTransaction(serializedTransaction, {
        preflightCommitment: "confirmed",
        skipPreflight: params.skipPreflight ?? false,
      })
    );
    const confirmation = await withRpcRetry("confirm transaction", () =>
      params.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      )
    );
    if (confirmation.value.err) {
      const failedTransaction = await withRpcRetry(
        "fetch failed transaction logs",
        () =>
          params.connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          }),
        2
      ).catch(() => null);
      const error = new Error(
        `Transaction ${signature} failed after submission: ${JSON.stringify(
          confirmation.value.err
        )}`
      );
      (error as any).logs = failedTransaction?.meta?.logMessages ?? [];
      throw error;
    }
    return signature;
  } catch (error) {
    throw await enrichTransactionError(params.connection, error);
  }
}

function getParticipantTokenBalance(
  participant: any,
  tokenId: number
): TokenBalanceView {
  const balance = participant.tokenBalances.find(
    (entry: any) => entry.tokenId === tokenId
  );
  return {
    available: balance?.availableBalance?.toNumber?.() ?? 0,
    withdrawing: balance?.withdrawingBalance?.toNumber?.() ?? 0,
  };
}

async function fetchParticipantById(
  program: Program<RyvoProtocol>,
  participantId: number
) {
  const participantPda = findParticipantBucketPda(
    program.programId,
    participantId
  );
  const slot = readRawParticipantBucketSlot(
    await fetchAccountData(
      program.provider.connection,
      participantPda,
      "participant bucket"
    ),
    participantId
  );
  return {
    participant: normalizeParticipantBucketSlot(slot),
    participantPda,
  };
}

async function fetchParticipantByOwner(
  program: Program<RyvoProtocol>,
  owner: PublicKey
) {
  const ownerIndexPda = findOwnerIndexBucketPda(program.programId, owner);
  const ownerIndexBucket = await (
    program.account as any
  ).ownerIndexBucket.fetch(ownerIndexPda);
  const ownerSlot = ownerIndexBucket.slots.find(
    (slot: any) =>
      slot.initialized && new PublicKey(slot.owner.toString()).equals(owner)
  );
  if (!ownerSlot) {
    throw new Error(`Participant owner ${owner.toString()} is not indexed`);
  }
  return fetchParticipantById(program, ownerSlot.participantId);
}

async function fetchInternalBalance(
  program: Program<RyvoProtocol>,
  wallet: DemoWallet,
  tokenId: number
): Promise<TokenBalanceView> {
  const { participant, participantPda } = await fetchParticipantByOwner(
    program,
    wallet.keypair.publicKey
  );
  const participantOwner = new PublicKey(participant.owner.toString());
  if (!participantOwner.equals(wallet.keypair.publicKey)) {
    throw new Error(
      `Participant owner mismatch for ${
        wallet.name
      }: on-chain owner ${participantOwner.toString()} does not match wallet ${wallet.keypair.publicKey.toString()}`
    );
  }
  wallet.participantPda = participantPda;
  wallet.participantId = participant.participantId;
  return getParticipantTokenBalance(participant, tokenId);
}

async function fetchExternalBalance(
  provider: anchor.AnchorProvider,
  tokenAccount: PublicKey
): Promise<bigint> {
  return (await getAccount(provider.connection, tokenAccount)).amount;
}

async function saveRunManifest(
  outputPath: string,
  content: Record<string, unknown>
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

function serializeWalletForManifest(wallet: DemoWallet): DemoManifestWallet {
  return {
    name: wallet.name,
    publicKey: wallet.keypair.publicKey.toString(),
    participantId: wallet.participantId >= 0 ? wallet.participantId : undefined,
    participantPda: wallet.participantPda.equals(PublicKey.default)
      ? undefined
      : wallet.participantPda.toString(),
    tokenAccount: wallet.tokenAccount.equals(PublicKey.default)
      ? undefined
      : wallet.tokenAccount.toString(),
    secretPath: wallet.secretPath,
  };
}

function walletNameForIndex(index: number): string {
  return DEMO_WALLET_BASE_NAMES[index] ?? `Agent${index + 1}`;
}

function walletIndexFromSecretPath(secretPath: string): number | null {
  const match = path.basename(secretPath).match(/^(\d+)-/);
  if (!match) {
    return null;
  }
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index - 1 : null;
}

function walletNameFromSecretPath(secretPath: string): string {
  const walletIndex = walletIndexFromSecretPath(secretPath);
  if (walletIndex !== null) {
    return walletNameForIndex(walletIndex);
  }

  const fileStem = path.basename(secretPath, ".json").replace(/^\d+-/, "");
  return fileStem.length > 0
    ? fileStem
        .split("-")
        .filter(Boolean)
        .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
        .join("")
    : "Agent";
}

function compareManifestWallets(
  left: DemoManifestWallet,
  right: DemoManifestWallet
): number {
  const leftIndex = walletIndexFromSecretPath(left.secretPath);
  const rightIndex = walletIndexFromSecretPath(right.secretPath);
  if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  if (leftIndex !== null && rightIndex === null) {
    return -1;
  }
  if (leftIndex === null && rightIndex !== null) {
    return 1;
  }
  return left.name.localeCompare(right.name);
}

function mergeExistingWalletManifestEntries(
  outputPath: string,
  walletEntries: DemoManifestWallet[]
): DemoManifestWallet[] {
  if (!fs.existsSync(outputPath)) {
    return walletEntries;
  }

  let existingManifest: Partial<DemoRunManifest> | null = null;
  try {
    existingManifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch {
    return walletEntries;
  }
  if (!Array.isArray(existingManifest?.wallets)) {
    return walletEntries;
  }

  const merged = [...walletEntries];
  const seen = new Set(
    walletEntries.map((entry) => entry.publicKey || entry.secretPath)
  );
  for (const existingEntry of existingManifest.wallets) {
    const identity = existingEntry.publicKey || existingEntry.secretPath;
    if (!identity || seen.has(identity)) {
      continue;
    }
    merged.push(existingEntry);
    seen.add(identity);
  }

  return merged.sort(compareManifestWallets);
}

async function saveWalletManifest(
  outputPath: string,
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  deployer: Keypair,
  tokenId: number,
  tokenSymbol: string,
  tokenMint: PublicKey,
  decimals: number,
  vaultTokenAccount: PublicKey,
  feeRecipient: PublicKey,
  wallets: DemoWallet[],
  runId: string,
  reusedFromManifest: string | null
): Promise<void> {
  const walletEntries = mergeExistingWalletManifestEntries(
    outputPath,
    wallets.map(serializeWalletForManifest)
  );
  await saveRunManifest(outputPath, {
    runId,
    network: inferNetwork(provider.connection.rpcEndpoint),
    rpcEndpoint: provider.connection.rpcEndpoint,
    programId: program.programId.toString(),
    deployer: deployer.publicKey.toString(),
    token: {
      id: tokenId,
      symbol: tokenSymbol,
      mint: tokenMint.toString(),
      decimals,
      vaultTokenAccount: vaultTokenAccount.toString(),
    },
    feeRecipient: feeRecipient.toString(),
    reusedFromManifest,
    generatedAt: new Date().toISOString(),
    wallets: walletEntries,
  });
}

function shouldLogProgress(
  completed: number,
  total: number,
  frequency: number
): boolean {
  return completed === total || completed === 1 || completed % frequency === 0;
}

function createSessionNonce(offset: number): number {
  return Math.floor(Date.now() / 1000) + offset;
}

function loadKeypair(secretPath: string): Keypair {
  const secretKey = Uint8Array.from(
    JSON.parse(fs.readFileSync(secretPath, "utf8"))
  );
  return Keypair.fromSecretKey(secretKey);
}

async function createWalletFiles(
  count: number,
  repoRoot: string
): Promise<PreparedWalletSet> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const walletDir = path.join(repoRoot, "keys", "ryvo-protocol-demo", runId);
  fs.mkdirSync(walletDir, { recursive: true });
  const wallets: DemoWallet[] = [];
  for (let index = 0; index < count; index += 1) {
    const keypair = Keypair.generate();
    const name = walletNameForIndex(index);
    const fileName = `${String(index + 1).padStart(
      2,
      "0"
    )}-${name.toLowerCase()}.json`;
    const secretPath = path.join(walletDir, fileName);
    fs.writeFileSync(secretPath, JSON.stringify(Array.from(keypair.secretKey)));
    const blsKeypair = deriveWalletBlsKeypair(keypair);
    wallets.push({
      name,
      keypair,
      secretPath,
      participantPda: PublicKey.default,
      participantId: -1,
      tokenAccount: PublicKey.default,
      blsSecretScalar: blsKeypair.secretScalar,
      blsPublicKeyCompressed: blsKeypair.publicKeyCompressed,
    });
  }
  return { runId, walletDir, wallets, source: "created" };
}

function loadWalletFromManifestEntry(
  entry: DemoManifestWallet,
  repoRoot: string
): DemoWallet {
  const secretPath = resolveInputPath(repoRoot, entry.secretPath);
  if (!fs.existsSync(secretPath)) {
    throw new Error(`Wallet secret file not found: ${secretPath}`);
  }
  const keypair = loadKeypair(secretPath);
  if (entry.publicKey && entry.publicKey !== keypair.publicKey.toString()) {
    throw new Error(
      `Manifest public key mismatch for ${entry.name}: expected ${
        entry.publicKey
      }, found ${keypair.publicKey.toString()}`
    );
  }
  const blsKeypair = deriveWalletBlsKeypair(keypair);
  return {
    name: entry.name,
    keypair,
    secretPath,
    // Re-derive participant state from the current program at runtime.
    participantPda: PublicKey.default,
    participantId: -1,
    tokenAccount: entry.tokenAccount
      ? new PublicKey(entry.tokenAccount)
      : PublicKey.default,
    blsSecretScalar: blsKeypair.secretScalar,
    blsPublicKeyCompressed: blsKeypair.publicKeyCompressed,
  };
}

function expandManifestWalletsFromDirectory(
  manifestWallets: DemoManifestWallet[],
  walletCount: number,
  repoRoot: string
): DemoManifestWallet[] {
  if (manifestWallets.length >= walletCount || manifestWallets.length === 0) {
    return manifestWallets;
  }

  const firstSecretPath = resolveInputPath(
    repoRoot,
    manifestWallets[0].secretPath
  );
  const walletDir = path.dirname(firstSecretPath);
  if (!fs.existsSync(walletDir)) {
    return manifestWallets;
  }

  const knownSecretPaths = new Set(
    manifestWallets.map((entry) => resolveInputPath(repoRoot, entry.secretPath))
  );
  const expanded = [...manifestWallets];
  const candidateSecretPaths = fs
    .readdirSync(walletDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => path.join(walletDir, fileName))
    .sort((left, right) =>
      compareManifestWallets(
        {
          name: walletNameFromSecretPath(left),
          publicKey: "",
          secretPath: left,
        },
        {
          name: walletNameFromSecretPath(right),
          publicKey: "",
          secretPath: right,
        }
      )
    );

  for (const secretPath of candidateSecretPaths) {
    if (expanded.length >= walletCount) {
      break;
    }
    if (knownSecretPaths.has(secretPath)) {
      continue;
    }
    const keypair = loadKeypair(secretPath);
    expanded.push({
      name: walletNameFromSecretPath(secretPath),
      publicKey: keypair.publicKey.toString(),
      secretPath,
    });
    knownSecretPaths.add(secretPath);
  }

  return expanded.sort(compareManifestWallets);
}

async function loadWalletsFromManifest(
  manifestPath: string,
  walletCount: number,
  repoRoot: string
): Promise<PreparedWalletSet> {
  const resolvedManifestPath = resolveInputPath(repoRoot, manifestPath);
  const manifest = JSON.parse(
    fs.readFileSync(resolvedManifestPath, "utf8")
  ) as DemoRunManifest;

  const manifestWallets = expandManifestWalletsFromDirectory(
    Array.isArray(manifest.wallets) ? manifest.wallets : [],
    walletCount,
    repoRoot
  );

  if (manifestWallets.length < walletCount) {
    throw new Error(
      `Manifest ${resolvedManifestPath} only contains ${
        manifest.wallets?.length ?? 0
      } wallets and only ${
        manifestWallets.length
      } could be recovered from the wallet directory, but ${walletCount} are required`
    );
  }

  const wallets: DemoWallet[] = manifestWallets
    .slice(0, walletCount)
    .map((entry) => loadWalletFromManifestEntry(entry, repoRoot));

  return {
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    walletDir: path.dirname(wallets[0].secretPath),
    wallets,
    source: "manifest",
    manifestPath: resolvedManifestPath,
  };
}

function resolveDefaultWalletManifestPath(
  repoRoot: string,
  walletManifestPath: string
): string {
  return resolveInputPath(repoRoot, walletManifestPath);
}

async function prepareDemoWallets(
  options: CliOptions,
  repoRoot: string
): Promise<PreparedWalletSet> {
  if (options.reuseManifestPath) {
    return loadWalletsFromManifest(
      options.reuseManifestPath,
      options.walletCount,
      repoRoot
    );
  }

  const defaultManifestPath = resolveDefaultWalletManifestPath(
    repoRoot,
    options.walletManifestPath
  );
  if (fs.existsSync(defaultManifestPath)) {
    return loadWalletsFromManifest(
      defaultManifestPath,
      options.walletCount,
      repoRoot
    );
  }

  return createWalletFiles(options.walletCount, repoRoot);
}

function selectActiveWallets(
  wallets: DemoWallet[],
  activeWalletNames: string[] | null
): DemoWallet[] {
  if (!activeWalletNames || activeWalletNames.length === 0) {
    return wallets;
  }

  const byName = new Map(wallets.map((wallet) => [wallet.name, wallet]));
  const selected = activeWalletNames.map((name) => {
    const wallet = byName.get(name);
    if (!wallet) {
      throw new Error(
        `Active wallet '${name}' was not found in the loaded manifest`
      );
    }
    return wallet;
  });

  if (selected.length < 6) {
    throw new Error(
      `At least 6 active wallets are required, but only ${selected.length} were configured`
    );
  }

  return selected;
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

async function ensureProgramReady(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  options: CliOptions
): Promise<{
  chainId: number;
  messageDomain: Buffer;
  feeRecipient: PublicKey;
  vaultTokenAccount: PublicKey;
  decimals: number;
}> {
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const tokenRegistryPda = findTokenRegistryPda(program.programId);
  const globalConfig = await program.account.globalConfig.fetch(
    globalConfigPda
  );
  const tokenRegistry = await program.account.tokenRegistry.fetch(
    tokenRegistryPda
  );
  const tokenEntry = tokenRegistry.tokens.find(
    (entry: any) => entry.id === options.tokenId
  );
  if (!tokenEntry) {
    throw new Error(
      `Token id ${options.tokenId} is not allowlisted on-chain. Run deployment with RYVO_ALLOWLIST_TOKENS first.`
    );
  }
  const onChainMint = new PublicKey(tokenEntry.mint.toString());
  if (!onChainMint.equals(options.tokenMint)) {
    throw new Error(
      `Token id ${
        options.tokenId
      } points to ${onChainMint.toString()}, not ${options.tokenMint.toString()}`
    );
  }
  const mintInfo = await getMint(provider.connection, options.tokenMint);
  return {
    chainId: globalConfig.chainId,
    messageDomain: Buffer.from(globalConfig.messageDomain),
    feeRecipient: new PublicKey(globalConfig.feeRecipient.toString()),
    vaultTokenAccount: findVaultTokenAccountPda(
      program.programId,
      options.tokenId
    ),
    decimals: mintInfo.decimals,
  };
}

async function fundDemoWallets(
  provider: anchor.AnchorProvider,
  deployer: Keypair,
  wallets: DemoWallet[],
  mint: PublicKey,
  decimals: number,
  solPerWallet: number,
  tokensPerWallet: number
): Promise<void> {
  const rawTokensPerWallet = BigInt(toRawAmount(tokensPerWallet, decimals));
  const targetLamports = Math.round(solPerWallet * LAMPORTS_PER_SOL);
  const deployerTokenAccount = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      deployer,
      mint,
      deployer.publicKey
    )
  ).address;
  const deployerTokenBalance = (
    await getAccount(provider.connection, deployerTokenAccount)
  ).amount;
  const requiredTokenBalance = rawTokensPerWallet * BigInt(wallets.length);
  if (deployerTokenBalance < requiredTokenBalance) {
    throw new Error(
      `Deployer token account ${deployerTokenAccount.toString()} only holds ${formatAmount(
        deployerTokenBalance,
        decimals
      )}, but ${formatAmount(
        requiredTokenBalance,
        decimals
      )} is required to seed ${wallets.length} wallets.`
    );
  }

  for (const wallet of wallets) {
    logStep(
      `Ensuring ${wallet.name} has ${solPerWallet} SOL and ${tokensPerWallet} tokens`
    );
    const currentLamports = await provider.connection.getBalance(
      wallet.keypair.publicKey,
      "confirmed"
    );
    if (currentLamports < targetLamports) {
      const solSignature = await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: deployer.publicKey,
            toPubkey: wallet.keypair.publicKey,
            lamports: targetLamports - currentLamports,
          })
        ),
        [deployer]
      );
      logStep(`  SOL top-up: ${solSignature}`);
    } else {
      logStep(
        `  SOL already sufficient: ${
          currentLamports / LAMPORTS_PER_SOL
        } available`
      );
    }

    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      deployer,
      mint,
      wallet.keypair.publicKey
    );
    wallet.tokenAccount = tokenAccount.address;

    const currentTokenBalance = (
      await getAccount(provider.connection, tokenAccount.address)
    ).amount;
    if (currentTokenBalance < rawTokensPerWallet) {
      const tokenSignature = await transfer(
        provider.connection,
        deployer,
        deployerTokenAccount,
        tokenAccount.address,
        deployer,
        rawTokensPerWallet - currentTokenBalance
      );
      logStep(`  Token top-up: ${tokenSignature}`);
    } else {
      logStep(
        `  Token balance already sufficient: ${formatAmount(
          currentTokenBalance,
          decimals
        )}`
      );
    }
  }
}

async function ensureWalletTokenAccounts(
  provider: anchor.AnchorProvider,
  deployer: Keypair,
  wallets: DemoWallet[],
  mint: PublicKey
): Promise<void> {
  for (const wallet of wallets) {
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      deployer,
      mint,
      wallet.keypair.publicKey
    );
    wallet.tokenAccount = tokenAccount.address;
  }
}

async function ensureParticipants(
  program: Program<RyvoProtocol>,
  feeRecipient: PublicKey,
  wallets: DemoWallet[],
  skipInitialization: boolean
): Promise<void> {
  for (const wallet of wallets) {
    try {
      const { participant, participantPda } = await fetchParticipantByOwner(
        program,
        wallet.keypair.publicKey
      );
      wallet.participantPda = participantPda;
      const participantOwner = new PublicKey(participant.owner.toString());
      if (!participantOwner.equals(wallet.keypair.publicKey)) {
        throw new Error(
          `Participant PDA ${wallet.participantPda.toString()} belongs to ${participantOwner.toString()}, not ${wallet.keypair.publicKey.toString()}`
        );
      }
      wallet.participantId = participant.participantId;
      logStep(`Reused ${wallet.name} as participant ${wallet.participantId}`);
    } catch {
      if (skipInitialization) {
        throw new Error(
          `Participant ${wallet.name} is not initialized on-chain, but RYVO_DEMO_SKIP_PARTICIPANT_INIT is enabled`
        );
      }
      const globalConfigAccount = await program.account.globalConfig.fetch(
        findGlobalConfigPda(program.programId)
      );
      const participantId = Number(globalConfigAccount.nextParticipantId);
      wallet.participantPda = findParticipantBucketPda(
        program.programId,
        participantId
      );
      const signature = await program.methods
        .initializeParticipant(
          participantBucketIdForParticipantId(participantId),
          ownerIndexBucketIdForOwner(wallet.keypair.publicKey)
        )
        .accounts({
          globalConfig: findGlobalConfigPda(program.programId),
          participantBucket: wallet.participantPda,
          ownerIndexBucket: findOwnerIndexBucketPda(
            program.programId,
            wallet.keypair.publicKey
          ),
          feeRecipient,
          owner: wallet.keypair.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([wallet.keypair])
        .rpc();
      const { participant } = await fetchParticipantById(
        program,
        participantId
      );
      wallet.participantId = participant.participantId;
      logStep(
        `Registered ${wallet.name} as participant ${wallet.participantId} (${signature})`
      );
    }
  }
}

async function ensureParticipantBlsKeys(
  program: Program<RyvoProtocol>,
  messageDomain: Buffer,
  wallets: DemoWallet[]
): Promise<void> {
  logSection("Participant BLS Keys");
  const globalConfig = findGlobalConfigPda(program.programId);

  for (const wallet of wallets) {
    if (wallet.participantId < 0) {
      throw new Error(
        `Cannot register a BLS key for ${wallet.name} before participant initialization`
      );
    }

    const { participant } = await fetchParticipantById(
      program,
      wallet.participantId
    );
    const participantWithInlineBls = participant as any;
    const registeredSchemeVersion = Number(
      participantWithInlineBls.blsSchemeVersion ?? 0
    );
    const registeredPubkey = Buffer.from(
      participantWithInlineBls.blsPubkeyCompressed ?? []
    );
    if (
      registeredSchemeVersion === 1 &&
      registeredPubkey.equals(wallet.blsPublicKeyCompressed)
    ) {
      logStep(
        `Reused ${wallet.name}'s inline BLS key registration on participant ${wallet.participantId}`
      );
      continue;
    }
    if (registeredSchemeVersion !== 0) {
      throw new Error(
        `Unsupported BLS scheme version ${registeredSchemeVersion} already registered for ${wallet.name}`
      );
    }

    const popMessage = createBlsRegistrationMessage({
      participantId: wallet.participantId,
      owner: wallet.keypair.publicKey,
      blsPubkeyCompressed: wallet.blsPublicKeyCompressed,
      messageDomain,
    });
    const popSignatureCompressed = signBlsMessage(wallet, popMessage);
    const signature = await program.methods
      .registerParticipantBlsKey(
        [...wallet.blsPublicKeyCompressed],
        [...popSignatureCompressed]
      )
      .accounts({
        globalConfig,
        participantBucket: wallet.participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(
          program.programId,
          wallet.keypair.publicKey
        ),
        owner: wallet.keypair.publicKey,
      } as any)
      .signers([wallet.keypair])
      .rpc();

    logStep(
      `Registered ${wallet.name}'s BLS key for participant ${wallet.participantId} (${signature})`
    );
  }
}

async function depositForWallet(
  program: Program<RyvoProtocol>,
  wallet: DemoWallet,
  tokenId: number,
  amount: number,
  vaultTokenAccount: PublicKey
): Promise<string> {
  if (wallet.participantId < 0) {
    const { participant, participantPda } = await fetchParticipantByOwner(
      program,
      wallet.keypair.publicKey
    );
    wallet.participantId = participant.participantId;
    wallet.participantPda = participantPda;
  } else {
    wallet.participantPda = findParticipantBucketPda(
      program.programId,
      wallet.participantId
    );
  }
  try {
    return await program.methods
      .deposit(tokenId, new anchor.BN(amount))
      .accounts({
        tokenRegistry: findTokenRegistryPda(program.programId),
        globalConfig: findGlobalConfigPda(program.programId),
        participantBucket: wallet.participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(
          program.programId,
          wallet.keypair.publicKey
        ),
        ownerTokenAccount: wallet.tokenAccount,
        vaultTokenAccount,
        owner: wallet.keypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([wallet.keypair])
      .rpc();
  } catch (error) {
    throw new Error(
      `Deposit failed for ${
        wallet.name
      } (owner=${wallet.keypair.publicKey.toString()}, participantPda=${wallet.participantPda.toString()}, tokenAccount=${wallet.tokenAccount.toString()}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function ensureDeposits(
  program: Program<RyvoProtocol>,
  wallets: DemoWallet[],
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  vaultTokenAccount: PublicKey,
  depositPlan: Record<string, number>,
  skipDeposits: boolean
): Promise<void> {
  logSection("Deposits");
  if (skipDeposits) {
    logStep("Skipping deposits and reusing current internal balances");
    return;
  }

  for (const wallet of wallets) {
    const targetAmount = depositPlan[wallet.name] ?? 0;
    if (targetAmount <= 0) {
      continue;
    }

    const targetRaw = toRawAmount(targetAmount, decimals);
    const currentBalance = await fetchInternalBalance(program, wallet, tokenId);
    if (currentBalance.available >= targetRaw) {
      logStep(
        `${wallet.name} already has ${formatAmount(
          currentBalance.available,
          decimals
        )} ${tokenSymbol} internally`
      );
      continue;
    }

    const topUpAmount = targetRaw - currentBalance.available;
    const signature = await depositForWallet(
      program,
      wallet,
      tokenId,
      topUpAmount,
      vaultTokenAccount
    );
    logStep(
      `${wallet.name} deposited ${formatAmount(
        topUpAmount,
        decimals
      )} ${tokenSymbol} (${signature})`
    );
  }
}

async function ensureMinimumInternalBalances(
  program: Program<RyvoProtocol>,
  wallets: DemoWallet[],
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  vaultTokenAccount: PublicKey,
  minimumRawByParticipantId: Map<number, number>
): Promise<void> {
  logSection("BLS Round Liquidity Check");
  for (const wallet of wallets) {
    const requiredRaw =
      minimumRawByParticipantId.get(wallet.participantId) ?? 0;
    if (requiredRaw <= 0) {
      continue;
    }

    const currentBalance = await fetchInternalBalance(program, wallet, tokenId);
    if (currentBalance.available >= requiredRaw) {
      logStep(
        `${wallet.name} already covers the BLS round minimum (${formatAmount(
          currentBalance.available,
          decimals
        )} / ${formatAmount(requiredRaw, decimals)} ${tokenSymbol})`
      );
      continue;
    }

    const topUpAmount = requiredRaw - currentBalance.available;
    const signature = await depositForWallet(
      program,
      wallet,
      tokenId,
      topUpAmount,
      vaultTokenAccount
    );
    logStep(
      `${wallet.name} topped up ${formatAmount(
        topUpAmount,
        decimals
      )} ${tokenSymbol} for the BLS clearing round (${signature})`
    );
  }
}

async function ensureTargetInternalBalances(
  program: Program<RyvoProtocol>,
  wallets: DemoWallet[],
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  vaultTokenAccount: PublicKey,
  targetAmount: number
): Promise<void> {
  logSection("BLS Base Liquidity");
  const targetRaw = toRawAmount(targetAmount, decimals);
  for (const wallet of wallets) {
    const currentBalance = await fetchInternalBalance(program, wallet, tokenId);
    if (currentBalance.available >= targetRaw) {
      logStep(
        `${wallet.name} already holds ${formatAmount(
          currentBalance.available,
          decimals
        )} / ${formatAmount(targetRaw, decimals)} ${tokenSymbol} internally`
      );
      continue;
    }

    const topUpAmount = targetRaw - currentBalance.available;
    const signature = await depositForWallet(
      program,
      wallet,
      tokenId,
      topUpAmount,
      vaultTokenAccount
    );
    logStep(
      `${wallet.name} topped up ${formatAmount(
        topUpAmount,
        decimals
      )} ${tokenSymbol} to reach the reusable BLS base balance (${signature})`
    );
  }
}

async function ensureDenseGraphChannels(
  program: Program<RyvoProtocol>,
  participants: DemoWallet[],
  tokenId: number,
  maxDirectedChannels: number
): Promise<MultilateralChannelEdge[]> {
  logSection("BLS Dense Graph Setup");
  const orderedPairs = buildBoundedDenseGraphPairs(
    participants,
    maxDirectedChannels
  );
  const edges: MultilateralChannelEdge[] = [];
  let createdCount = 0;

  for (let index = 0; index < orderedPairs.length; index += 1) {
    const [payer, payee] = orderedPairs[index];
    const channelPda = findChannelPda(
      program.programId,
      payer.participantId,
      payee.participantId,
      tokenId
    );
    const existingAccount = await program.provider.connection.getAccountInfo(
      channelPda
    );
    const channelPdaResolved = await ensureChannel(
      program,
      payer,
      payee,
      tokenId,
      false
    );
    if (!existingAccount) {
      createdCount += 1;
    }
    const channel = await fetchDirectionalChannelState(
      program,
      channelPdaResolved,
      payer.participantId,
      payee.participantId
    );
    edges.push({
      payer,
      payee,
      channelPda: channelPdaResolved,
      channel,
    });

    if (
      index === orderedPairs.length - 1 ||
      (index + 1) % 50 === 0 ||
      index === 0
    ) {
      logStep(
        `Prepared ${index + 1}/${
          orderedPairs.length
        } directed channels (${createdCount} created, ${
          index + 1 - createdCount
        } reused)`
      );
    }
  }

  return edges;
}

async function ensureChannel(
  program: Program<RyvoProtocol>,
  payer: DemoWallet,
  payee: DemoWallet,
  tokenId: number,
  logCreation = true
): Promise<PublicKey> {
  const channelPda = findChannelPda(
    program.programId,
    payer.participantId,
    payee.participantId,
    tokenId
  );
  const { lowerParticipantId, higherParticipantId } =
    getCanonicalChannelParticipants(payer.participantId, payee.participantId);
  const existingAccount = await program.provider.connection.getAccountInfo(
    channelPda,
    "confirmed"
  );
  if (existingAccount) {
    try {
      const existingPairChannel = readRawChannelBucketState(
        Buffer.isBuffer(existingAccount.data)
          ? existingAccount.data
          : Buffer.from(existingAccount.data),
        payer.participantId,
        payee.participantId
      );
      if (existingPairChannel.tokenId !== tokenId) {
        throw new Error(
          `channel bucket token mismatch: expected ${tokenId}, got ${existingPairChannel.tokenId}`
        );
      }
      const existingChannel = normalizeDirectionalChannelState(
        existingPairChannel,
        payer.participantId,
        payee.participantId
      );
      if (existingChannel.initialized) {
        return channelPda;
      }
    } catch (error) {
      if (!isChannelBucketSlotNotInitializedError(error)) {
        throw new Error(
          `Channel ${channelPda.toString()} for ${payer.name} -> ${
            payee.name
          } (token ${tokenId}) already exists on-chain but could not be decoded by the current program layout: ${formatDecodeError(
            error
          )}. Use a fresh wallet manifest or rotate participants before rerunning the demo.`
        );
      }
    }
  }
  const createChannelCall = program.methods
    .createChannel(
      tokenId,
      lowerParticipantId,
      higherParticipantId,
      new anchor.BN(
        channelBucketIdForPair(payer.participantId, payee.participantId)
      ),
      null as any
    )
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      payerBucket: payer.participantPda,
      payeeBucket: payee.participantPda,
      ownerIndexBucket: findOwnerIndexBucketPda(
        program.programId,
        payer.keypair.publicKey
      ),
      payeeOwner: payee.keypair.publicKey,
      channelBucket: channelPda,
      owner: payer.keypair.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([payer.keypair, payee.keypair]);
  let signature: string;
  try {
    signature = await createChannelCall.rpc();
  } catch (error) {
    const recoveredSignature = await recoverTimedOutRpcSignature(
      program.provider.connection,
      error,
      `Create channel ${payer.name} -> ${payee.name}`
    );
    if (!recoveredSignature) {
      throw error;
    }
    signature = recoveredSignature;
  }
  if (logCreation) {
    logStep(
      `Created channel ${payer.name} -> ${payee.name} for token ${tokenId} (${signature})`
    );
  }
  return channelPda;
}

async function ensureLockedChannelFunds(
  program: Program<RyvoProtocol>,
  payer: DemoWallet,
  payee: DemoWallet,
  tokenId: number,
  channelPda: PublicKey,
  targetLockedRaw: number,
  tokenSymbol: string,
  decimals: number
): Promise<void> {
  const channel = await fetchDirectionalChannelState(
    program,
    channelPda,
    payer.participantId,
    payee.participantId
  );
  const currentLocked = channel.lockedBalance.toNumber();
  if (currentLocked >= targetLockedRaw) {
    logStep(
      `${payer.name}->${payee.name} already has ${formatAmount(
        currentLocked,
        decimals
      )} ${tokenSymbol} locked`
    );
    return;
  }

  const lockDelta = targetLockedRaw - currentLocked;
  const signature = await program.methods
    .lockChannelFunds(tokenId, payee.participantId, new anchor.BN(lockDelta))
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      payerBucket: payer.participantPda,
      channelBucket: channelPda,
      ownerIndexBucket: findOwnerIndexBucketPda(
        program.programId,
        payer.keypair.publicKey
      ),
      owner: payer.keypair.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([payer.keypair])
    .rpc();
  logStep(
    `${payer.name} locked ${formatAmount(
      lockDelta,
      decimals
    )} ${tokenSymbol} into ${payer.name}->${payee.name} (${signature})`
  );
}

async function logScenarioEvents(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  signature: string
): Promise<void> {
  const events = await parseProgramEvents(provider, program, signature);
  if (events.length === 0) {
    logStep("  No Anchor events parsed from transaction logs.");
    return;
  }
  for (const event of events) {
    logStep(`  Event ${event.name}: ${JSON.stringify(event.data)}`);
  }
}

async function runSingleCommitmentScenario(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  payer: DemoWallet,
  payee: DemoWallet,
  commitmentCount: number,
  amountPerCommitment: number,
  logEvery: number
): Promise<ScenarioResult> {
  logSection("Scenario 1/5 - Latest Commitment Settlement");
  const channelPda = await ensureChannel(program, payer, payee, tokenId);
  const channelBefore = await fetchDirectionalChannelState(
    program,
    channelPda,
    payer.participantId,
    payee.participantId
  );
  const payerBefore = await fetchInternalBalance(program, payer, tokenId);
  const payeeBefore = await fetchInternalBalance(program, payee, tokenId);
  const rawAmount = toRawAmount(amountPerCommitment, decimals);
  const totalUnderlyingPayments = commitmentCount;
  const priorSettledAmount = channelBefore.settledCumulative.toNumber();
  const finalCommittedAmount =
    priorSettledAmount + rawAmount * totalUnderlyingPayments;
  const signedCommitmentPreview = buildSignedCommitmentPreview({
    messageDomain,
    decimals,
    tokenSymbol,
    inputs: [
      {
        payer,
        payee,
        committedAmount: finalCommittedAmount,
        tokenId,
      },
    ],
  });
  const message = createCommitmentMessage({
    payerId: channelBefore.payerId,
    payeeId: channelBefore.payeeId,
    committedAmount: finalCommittedAmount,
    tokenId,
    messageDomain,
  });
  const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: payer.keypair.secretKey,
    message,
  });
  const latestSignature = await program.methods
    .settleIndividual()
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      globalConfig: findGlobalConfigPda(program.programId),
      submitter: payee.keypair.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts([
      ...uniqueWritableMetasForPubkeys([
        payer.participantPda,
        payee.participantPda,
      ]),
      { pubkey: channelPda, isSigner: false, isWritable: true },
    ])
    .preInstructions([ed25519Instruction])
    .signers([payee.keypair])
    .rpc();
  const serializedTxBytes = await fetchSerializedTransactionBytes(
    provider.connection,
    latestSignature
  );
  if (shouldLogProgress(1, 1, logEvery)) {
    logStep(
      `  Settled the latest cumulative commitment in 1 tx (latest tx: ${latestSignature})`
    );
  }

  const channelAfter = await fetchDirectionalChannelState(
    program,
    channelPda,
    payer.participantId,
    payee.participantId
  );
  const payerAfter = await fetchInternalBalance(program, payer, tokenId);
  const payeeAfter = await fetchInternalBalance(program, payee, tokenId);
  logStep(
    `${payer.name} sent ${totalUnderlyingPayments.toLocaleString(
      "en-US"
    )} offchain payments to ${payee.name} at ${formatAmount(
      rawAmount,
      decimals
    )} ${tokenSymbol} each`
  );
  logStep(
    `${payee.name} settled the latest cumulative commitment for ${formatAmount(
      rawAmount * totalUnderlyingPayments,
      decimals
    )} ${tokenSymbol} in 1 onchain tx`
  );
  logSignedCommitmentPreview(signedCommitmentPreview);
  logSavingsComparison(
    totalUnderlyingPayments,
    1,
    "1 latest commitment settlement"
  );
  logStep(
    `  ${payer.name} internal: ${formatAmount(
      payerBefore.available,
      decimals
    )} -> ${formatAmount(payerAfter.available, decimals)}`
  );
  logStep(
    `  ${payee.name} internal: ${formatAmount(
      payeeBefore.available,
      decimals
    )} -> ${formatAmount(payeeAfter.available, decimals)}`
  );
  logStep(
    `  Channel settled cumulative: ${formatAmount(
      channelBefore.settledCumulative.toNumber(),
      decimals
    )} -> ${formatAmount(channelAfter.settledCumulative.toNumber(), decimals)}`
  );
  logStep(`  Explorer: ${explorerUrl(latestSignature)}`);
  await logScenarioEvents(provider, program, latestSignature);
  return {
    primarySignature: latestSignature,
    benchmark: createBenchmarkScenario({
      id: "singleCommitment",
      title: "Scenario 1/5 - Latest Commitment Settlement",
      settlementMode: "latest-commitment",
      participantCount: 2,
      channelCount: 1,
      underlyingPaymentCount: totalUnderlyingPayments,
      grossValueRaw: rawAmount * totalUnderlyingPayments,
      decimals,
      tokenSymbol,
      signatures: [latestSignature],
      serializedTransactionBytes: [serializedTxBytes],
      signedMessageBytes: message.length,
      signatureCount: 1,
      participantBalanceWrites: 2,
      channelLaneWrites: 1,
      notes: [
        "One latest cumulative commitment replaces exact-payment settlement on the hot path.",
      ],
    }),
  };
}

async function runBatchCommitmentScenario(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  payers: DemoWallet[],
  payee: DemoWallet,
  batchCount: number,
  batchSize: number,
  amountPerCommitment: number,
  logEvery: number
): Promise<ScenarioResult> {
  logSection("Scenario 2/5 - Commitment Bundle Settlement");
  const selectedPayers = payers.slice(0, batchCount);
  const rawAmount = toRawAmount(amountPerCommitment, decimals);
  const totalUnderlyingPayments = selectedPayers.length * batchSize;
  const bundleTxCount = Math.max(
    1,
    Math.ceil(selectedPayers.length / MAX_BUNDLE_CHANNELS_PER_TX)
  );
  const payeeBefore = await fetchInternalBalance(program, payee, tokenId);
  const payerBalancesBefore = await Promise.all(
    selectedPayers.map((payer) => fetchInternalBalance(program, payer, tokenId))
  );
  const channelsBefore = await Promise.all(
    selectedPayers.map(async (payer, index) => {
      const channelPda = await ensureChannel(program, payer, payee, tokenId);
      const channel = await fetchDirectionalChannelState(
        program,
        channelPda,
        payer.participantId,
        payee.participantId
      );
      return {
        payer,
        channelPda,
        channel,
        committedAmount:
          channel.settledCumulative.toNumber() + rawAmount * batchSize,
      };
    })
  );
  const commitmentBundlePreview = buildCommitmentBundlePayloadPreview({
    messageDomain,
    decimals,
    tokenId,
    tokenSymbol,
    payee,
    inputs: channelsBefore.map(({ payer, channel, committedAmount }) => ({
      payer,
      payee,
      committedAmount,
      tokenId,
    })),
  });
  const channelChunks: (typeof channelsBefore)[] = [];
  for (
    let index = 0;
    index < channelsBefore.length;
    index += MAX_BUNDLE_CHANNELS_PER_TX
  ) {
    channelChunks.push(
      channelsBefore.slice(index, index + MAX_BUNDLE_CHANNELS_PER_TX)
    );
  }

  const signatures: string[] = [];
  for (let chunkIndex = 0; chunkIndex < channelChunks.length; chunkIndex += 1) {
    const chunk = channelChunks[chunkIndex];
    const bundleEntries = chunk.map(({ payer, channel, committedAmount }) => ({
      signer: payer.keypair,
      message: createCommitmentMessage({
        payerId: channel.payerId,
        payeeId: channel.payeeId,
        committedAmount,
        tokenId,
        messageDomain,
      }),
    }));
    const chunkSignature = await program.methods
      .settleCommitmentBundle(bundleEntries.length)
      .accounts({
        tokenRegistry: findTokenRegistryPda(program.programId),
        globalConfig: findGlobalConfigPda(program.programId),
        submitter: payee.keypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .remainingAccounts([
        ...uniqueWritableMetasForPubkeys([
          payee.participantPda,
          ...chunk.map(({ payer }) => payer.participantPda),
        ]),
        ...uniqueWritableMetasForPubkeys(
          chunk.map(({ channelPda }) => channelPda)
        ),
      ])
      .preInstructions([createMultiMessageEd25519Instruction(bundleEntries)])
      .signers([payee.keypair])
      .rpc();
    signatures.push(chunkSignature);
    if (shouldLogProgress(chunkIndex + 1, channelChunks.length, logEvery)) {
      logStep(
        `  Settled bundle chunk ${chunkIndex + 1}/${channelChunks.length} (${
          chunk.length
        } channels, latest tx: ${chunkSignature})`
      );
    }
  }

  const totalAmount = rawAmount * totalUnderlyingPayments;
  const channelsAfter = await Promise.all(
    channelsBefore.map(async ({ payer, channelPda }) =>
      fetchDirectionalChannelState(
        program,
        channelPda,
        payer.participantId,
        payee.participantId
      )
    )
  );
  const payerBalancesAfter = await Promise.all(
    selectedPayers.map((payer) => fetchInternalBalance(program, payer, tokenId))
  );
  const payeeAfter = await fetchInternalBalance(program, payee, tokenId);
  logStep(
    `${
      selectedPayers.length
    } buyers streamed ${totalUnderlyingPayments.toLocaleString(
      "en-US"
    )} offchain payments to ${
      payee.name
    }, one latest commitment per unilateral channel`
  );
  logStep(
    `${payee.name} settled those ${
      selectedPayers.length
    } channel commitments in ${bundleTxCount} bundle tx${
      bundleTxCount === 1 ? "" : "s"
    } for ${formatAmount(totalAmount, decimals)} at ${formatAmount(
      rawAmount,
      decimals
    )} ${tokenSymbol} per underlying payment`
  );
  logStep(
    `  Each latest commitment represented ${batchSize} offchain payments`
  );
  logCommitmentBundlePayloadPreview(commitmentBundlePreview);
  logSavingsComparison(
    totalUnderlyingPayments,
    bundleTxCount,
    `${bundleTxCount} bundled commitment settlement tx${
      bundleTxCount === 1 ? "" : "s"
    }`
  );
  selectedPayers.forEach((payer, index) => {
    logStep(
      `  ${payer.name} internal: ${formatAmount(
        payerBalancesBefore[index].available,
        decimals
      )} -> ${formatAmount(payerBalancesAfter[index].available, decimals)}`
    );
  });
  logStep(
    `  ${payee.name} internal: ${formatAmount(
      payeeBefore.available,
      decimals
    )} -> ${formatAmount(payeeAfter.available, decimals)}`
  );
  channelsBefore.forEach(({ payer, channel }, index) => {
    logStep(
      `  Channel ${payer.name}->${
        payee.name
      } settled cumulative: ${formatAmount(
        channel.settledCumulative.toNumber(),
        decimals
      )} -> ${formatAmount(
        channelsAfter[index].settledCumulative.toNumber(),
        decimals
      )}`
    );
  });
  const serializedTransactionBytes = await Promise.all(
    signatures.map((signature) =>
      fetchSerializedTransactionBytes(provider.connection, signature)
    )
  );
  const latestSignature = signatures[signatures.length - 1];
  logStep(`  Explorer: ${explorerUrl(latestSignature)}`);
  await logScenarioEvents(provider, program, latestSignature);
  return {
    primarySignature: latestSignature,
    benchmark: createBenchmarkScenario({
      id: "batchCommitment",
      title: "Scenario 2/5 - Commitment Bundle Settlement",
      settlementMode: "bundle",
      participantCount: selectedPayers.length + 1,
      channelCount: selectedPayers.length,
      underlyingPaymentCount: totalUnderlyingPayments,
      grossValueRaw: totalAmount,
      decimals,
      tokenSymbol,
      signatures,
      serializedTransactionBytes,
      signedMessageBytes: channelsBefore.reduce(
        (sum, { channel, committedAmount }) =>
          sum +
          createCommitmentMessage({
            payerId: channel.payerId,
            payeeId: channel.payeeId,
            committedAmount,
            tokenId,
            messageDomain,
          }).length,
        0
      ),
      signatureCount: channelsBefore.length,
      participantBalanceWrites: selectedPayers.length + 1,
      channelLaneWrites: channelsBefore.length,
      notes: [
        "Many unilateral latest commitments settle in payee-side bundle transactions.",
      ],
    }),
  };
}

async function runAtomicRoutedClearingScenario(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  payer: DemoWallet,
  middleman: DemoWallet,
  recipient: DemoWallet,
  routeAmount: number,
  vaultTokenAccount: PublicKey
): Promise<ScenarioResult> {
  logSection("Scenario 3/6 - Atomic Routed BLS Clearing");
  const routeRaw = toRawAmount(routeAmount, decimals);
  await ensureMinimumInternalBalances(
    program,
    [payer],
    tokenId,
    tokenSymbol,
    decimals,
    vaultTokenAccount,
    new Map([[payer.participantId, routeRaw]])
  );

  const payerToMiddlePda = await ensureChannel(
    program,
    payer,
    middleman,
    tokenId
  );
  await ensureLockedChannelFunds(
    program,
    payer,
    middleman,
    tokenId,
    payerToMiddlePda,
    routeRaw,
    tokenSymbol,
    decimals
  );
  const middleToRecipientPda = await ensureChannel(
    program,
    middleman,
    recipient,
    tokenId
  );

  const payerToMiddleBefore = await fetchDirectionalChannelState(
    program,
    payerToMiddlePda,
    payer.participantId,
    middleman.participantId
  );
  const middleToRecipientBefore = await fetchDirectionalChannelState(
    program,
    middleToRecipientPda,
    middleman.participantId,
    recipient.participantId
  );
  const balancesBefore = await Promise.all(
    [payer, middleman, recipient].map((wallet) =>
      fetchInternalBalance(program, wallet, tokenId)
    )
  );

  const roundBlocks: ClearingRoundPreviewBlockInput[] = [
    {
      participant: payer,
      entries: [
        {
          payeeRef: 1,
          payee: middleman,
          targetCumulative:
            payerToMiddleBefore.settledCumulative.toNumber() + routeRaw,
        },
      ],
    },
    {
      participant: middleman,
      entries: [
        {
          payeeRef: 2,
          payee: recipient,
          targetCumulative:
            middleToRecipientBefore.settledCumulative.toNumber() + routeRaw,
        },
      ],
    },
    {
      participant: recipient,
      entries: [],
    },
  ];
  const message = createClearingRoundMessage({
    tokenId,
    messageDomain,
    version: BLS_CLEARING_ROUND_MESSAGE_VERSION,
    blocks: roundBlocks.map((block) => ({
      participantId: block.participant.participantId,
      entries: block.entries.map((entry) => ({
        payeeRef: entry.payeeRef,
        targetCumulative: entry.targetCumulative,
      })),
    })),
  });
  const aggregateSignatureCompressed = aggregateBlsSignatures(
    [payer, middleman].map((wallet) => signBlsMessage(wallet, message))
  );
  const clearingRoundPreview = buildClearingRoundPayloadPreview({
    messageDomain,
    tokenId,
    tokenSymbol,
    decimals,
    blocks: roundBlocks,
    version: BLS_CLEARING_ROUND_MESSAGE_VERSION,
    aggregateSignature: aggregateSignatureCompressed,
  });
  const remainingAccounts = [
    ...uniqueWritableMetasForPubkeys([
      payer.participantPda,
      middleman.participantPda,
      recipient.participantPda,
    ]),
    ...uniqueWritableMetasForPubkeys([payerToMiddlePda, middleToRecipientPda]),
  ];
  const signature = await program.methods
    .settleClearingRound(message, [...aggregateSignatureCompressed])
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      globalConfig: findGlobalConfigPda(program.programId),
      submitter: middleman.keypair.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts(remainingAccounts)
    .preInstructions([
      ComputeBudgetProgram.requestHeapFrame({
        bytes: 256 * 1024,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({
        units: DEFAULT_BLS_COMPUTE_UNIT_LIMIT,
      }),
    ])
    .signers([middleman.keypair])
    .rpc();

  const serializedTxBytes = await fetchSerializedTransactionBytes(
    provider.connection,
    signature
  );
  const balancesAfter = await Promise.all(
    [payer, middleman, recipient].map((wallet) =>
      fetchInternalBalance(program, wallet, tokenId)
    )
  );
  const payerToMiddleAfter = await fetchDirectionalChannelState(
    program,
    payerToMiddlePda,
    payer.participantId,
    middleman.participantId
  );
  const middleToRecipientAfter = await fetchDirectionalChannelState(
    program,
    middleToRecipientPda,
    middleman.participantId,
    recipient.participantId
  );

  if (balancesAfter[1].available !== balancesBefore[1].available) {
    throw new Error(
      "Atomic routed clearing invariant failed: middleman internal balance changed"
    );
  }
  if (balancesAfter[2].available - balancesBefore[2].available !== routeRaw) {
    throw new Error(
      "Atomic routed clearing invariant failed: recipient did not receive the routed amount"
    );
  }

  logStep(
    `${payer.name} routed ${formatAmount(
      routeRaw,
      decimals
    )} ${tokenSymbol} to ${recipient.name} through ${middleman.name}`
  );
  logStep(
    `${payer.name} and ${middleman.name} signed the same clearing-round message; ${recipient.name} only received`
  );
  logStep(
    `${middleman.name} did not pre-lock liquidity to ${recipient.name}; the incoming and outgoing legs netted atomically in one settlement`
  );
  logClearingRoundPayloadPreview(clearingRoundPreview);
  logStep(
    `  ${payer.name} internal: ${formatAmount(
      balancesBefore[0].available,
      decimals
    )} -> ${formatAmount(balancesAfter[0].available, decimals)}`
  );
  logStep(
    `  ${middleman.name} internal: ${formatAmount(
      balancesBefore[1].available,
      decimals
    )} -> ${formatAmount(balancesAfter[1].available, decimals)}`
  );
  logStep(
    `  ${recipient.name} internal: ${formatAmount(
      balancesBefore[2].available,
      decimals
    )} -> ${formatAmount(balancesAfter[2].available, decimals)}`
  );
  logStep(
    `  ${payer.name}->${middleman.name} settled cumulative: ${formatAmount(
      payerToMiddleBefore.settledCumulative.toNumber(),
      decimals
    )} -> ${formatAmount(
      payerToMiddleAfter.settledCumulative.toNumber(),
      decimals
    )}; locked: ${formatAmount(
      payerToMiddleBefore.lockedBalance.toNumber(),
      decimals
    )} -> ${formatAmount(
      payerToMiddleAfter.lockedBalance.toNumber(),
      decimals
    )}`
  );
  logStep(
    `  ${middleman.name}->${recipient.name} settled cumulative: ${formatAmount(
      middleToRecipientBefore.settledCumulative.toNumber(),
      decimals
    )} -> ${formatAmount(
      middleToRecipientAfter.settledCumulative.toNumber(),
      decimals
    )}; locked: ${formatAmount(
      middleToRecipientBefore.lockedBalance.toNumber(),
      decimals
    )} -> ${formatAmount(
      middleToRecipientAfter.lockedBalance.toNumber(),
      decimals
    )}`
  );
  logSavingsComparison(2, 1, "1 atomic routed clearing round");
  logStep(`  Explorer: ${explorerUrl(signature)}`);
  await logScenarioEvents(provider, program, signature);

  return {
    primarySignature: signature,
    benchmark: createBenchmarkScenario({
      id: "atomicRoutedClearing",
      title: "Scenario 3/6 - Atomic Routed BLS Clearing",
      settlementMode: "atomic-routed-clearing",
      participantCount: 3,
      channelCount: 2,
      underlyingPaymentCount: 2,
      grossValueRaw: routeRaw * 2,
      decimals,
      tokenSymbol,
      signatures: [signature],
      serializedTransactionBytes: [serializedTxBytes],
      signedMessageBytes: message.length,
      signatureCount: 1,
      participantBalanceWrites: 1,
      channelLaneWrites: 2,
      notes: [
        "Only the buyer and middleman sign because they have outgoing channel entries; the final recipient is passive.",
        "The middleman channel to the final recipient advances without pre-locked collateral because the incoming leg covers the outgoing leg in the same atomic round.",
      ],
    }),
  };
}

async function runMultilateralClearingScenario(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  participants: DemoWallet[],
  channelCount: number,
  edgeCommitmentCount: number,
  amountPerCommitment: number,
  scenarioId: string,
  scenarioTitle: string
): Promise<MultilateralScenarioResult> {
  if (participants.length < 3) {
    throw new Error("Multilateral clearing requires at least 3 participants");
  }
  if (channelCount < participants.length) {
    throw new Error(
      "Multilateral clearing scenario requires at least one directed channel per participant"
    );
  }

  logSection(scenarioTitle);
  const orderedPairs = buildOrderedParticipantPairs(participants);
  if (channelCount > orderedPairs.length) {
    throw new Error(
      `Requested ${channelCount} directed channels but only ${orderedPairs.length} unique participant pairs exist`
    );
  }
  const participantBalancesBefore = await Promise.all(
    participants.map(async (participant) => ({
      participant,
      balance: await fetchInternalBalance(program, participant, tokenId),
    }))
  );
  const candidateChannelCounts = Array.from(
    { length: channelCount - participants.length + 1 },
    (_, index) => channelCount - index
  );
  let channelEdges: Array<{
    payer: DemoWallet;
    payee: DemoWallet;
    channelPda: PublicKey;
    channel: any;
  }> | null = null;
  let roundBlocks: ClearingRoundPreviewBlockInput[] | null = null;
  let clearingRoundPreview: ClearingRoundPayloadPreview | null = null;
  let actualV0AltTxBytes: number | null = null;
  let signature: string | null = null;
  let lastAttemptError: unknown = null;
  const rawAmountPerCommitment = toRawAmount(amountPerCommitment, decimals);
  const submitter = participants[0];
  const providerPayer = (provider.wallet as any).payer as Keypair | undefined;
  const sponsor = await selectFeeSponsor(provider.connection, [
    ...(providerPayer ? [providerPayer] : []),
    ...participants.map((participant) => participant.keypair),
  ]);
  const extraSigners = sponsor.publicKey.equals(submitter.keypair.publicKey)
    ? []
    : [submitter.keypair];
  const grossAmount = rawAmountPerCommitment * edgeCommitmentCount;
  if (!sponsor.publicKey.equals(submitter.keypair.publicKey)) {
    logStep(
      `Using ${sponsor.publicKey.toString()} as the fee sponsor for the multilateral round while ${
        submitter.name
      } remains the signed submitter`
    );
  }

  for (const candidateChannelCount of candidateChannelCounts) {
    const selectedPairs = orderedPairs.slice(0, candidateChannelCount);
    const candidateChannelEdges = await Promise.all(
      selectedPairs.map(async ([payer, payee]) => {
        const channelPda = await ensureChannel(program, payer, payee, tokenId);
        const channel = await fetchDirectionalChannelState(
          program,
          channelPda,
          payer.participantId,
          payee.participantId
        );
        return {
          payer,
          payee,
          channelPda,
          channel,
        };
      })
    );
    const candidateRoundBlocks: ClearingRoundPreviewBlockInput[] =
      participants.map((participant) => ({
        participant,
        entries: candidateChannelEdges
          .filter(
            (edge) => edge.payer.participantId === participant.participantId
          )
          .map((edge) => ({
            payeeRef: participants.findIndex(
              (candidate) =>
                candidate.participantId === edge.payee.participantId
            ),
            payee: edge.payee,
            targetCumulative:
              edge.channel.settledCumulative.toNumber() + grossAmount,
          })),
      }));
    const minimumRawByParticipantId = new Map<number, number>();
    for (const block of candidateRoundBlocks) {
      const requiredRaw = block.entries.reduce((sum, entry) => {
        const edge = candidateChannelEdges.find(
          (candidate) =>
            candidate.payer.participantId === block.participant.participantId &&
            candidate.payee.participantId ===
              participants[entry.payeeRef]?.participantId
        );
        if (!edge) {
          throw new Error("Unable to resolve clearing-round liquidity target");
        }
        const delta =
          entry.targetCumulative - edge.channel.settledCumulative.toNumber();
        const uncoveredDelta =
          delta - Math.min(edge.channel.lockedBalance.toNumber(), delta);
        return sum + uncoveredDelta;
      }, 0);
      minimumRawByParticipantId.set(
        block.participant.participantId,
        requiredRaw
      );
    }
    await ensureMinimumInternalBalances(
      program,
      participants,
      tokenId,
      tokenSymbol,
      decimals,
      findVaultTokenAccountPda(program.programId, tokenId),
      minimumRawByParticipantId
    );
    const message = createClearingRoundMessage({
      tokenId,
      messageDomain,
      version: BLS_CLEARING_ROUND_MESSAGE_VERSION,
      blocks: candidateRoundBlocks.map((block) => ({
        participantId: block.participant.participantId,
        entries: block.entries.map((entry) => ({
          payeeRef: entry.payeeRef,
          targetCumulative: entry.targetCumulative,
        })),
      })),
    });
    const activeRoundParticipants = candidateRoundBlocks
      .filter((block) => block.entries.length > 0)
      .map((block) => block.participant);
    const aggregateSignatureCompressed = aggregateBlsSignatures(
      activeRoundParticipants.map((participant) =>
        signBlsMessage(participant, message)
      )
    );
    const participantBucketAccounts = uniqueWritableMetasForPubkeys(
      participants.map((participant) => participant.participantPda)
    );
    const channelBucketAccounts = uniqueWritableMetasForPubkeys(
      candidateRoundBlocks.flatMap((block) =>
        block.entries.map((entry) => {
          const edge = candidateChannelEdges.find(
            (candidate) =>
              candidate.payer.participantId ===
                block.participant.participantId &&
              candidate.payee.participantId ===
                participants[entry.payeeRef]?.participantId
          );
          if (!edge) {
            throw new Error("Unable to resolve clearing-round channel account");
          }
          return edge.channelPda;
        })
      )
    );
    const remainingAccounts = [
      ...participantBucketAccounts,
      ...channelBucketAccounts,
    ];
    const clearingRoundInstruction = await program.methods
      .settleClearingRound(message, [...aggregateSignatureCompressed])
      .accounts({
        tokenRegistry: findTokenRegistryPda(program.programId),
        globalConfig: findGlobalConfigPda(program.programId),
        submitter: submitter.keypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .remainingAccounts(remainingAccounts)
      .instruction();
    const lookupTable = await createLookupTableForAddresses(
      provider.connection,
      submitter.keypair,
      sponsor,
      [
        findTokenRegistryPda(program.programId),
        findGlobalConfigPda(program.programId),
        SYSVAR_INSTRUCTIONS_PUBKEY,
        ...uniquePubkeys([
          ...participants.map((participant) => participant.participantPda),
          ...candidateChannelEdges.map((edge) => edge.channelPda),
        ]),
      ]
    );

    try {
      const candidateTxBytes = await estimateVersionedTransactionBytes({
        connection: provider.connection,
        feePayer: sponsor,
        instructions: [clearingRoundInstruction],
        lookupTables: [lookupTable],
        extraSigners,
      });
      const candidateSignature = await sendVersionedTransaction({
        connection: provider.connection,
        feePayer: sponsor,
        instructions: [clearingRoundInstruction],
        lookupTables: [lookupTable],
        extraSigners,
      });

      channelEdges = candidateChannelEdges;
      roundBlocks = candidateRoundBlocks;
      clearingRoundPreview = buildClearingRoundPayloadPreview({
        messageDomain,
        tokenId,
        tokenSymbol,
        decimals,
        blocks: candidateRoundBlocks,
        version: BLS_CLEARING_ROUND_MESSAGE_VERSION,
        aggregateSignature: aggregateSignatureCompressed,
      });
      actualV0AltTxBytes = candidateTxBytes;
      signature = candidateSignature;
      break;
    } catch (error) {
      lastAttemptError = error;
      if (candidateChannelCount === participants.length) {
        throw error;
      }
    }
  }

  if (
    !channelEdges ||
    !roundBlocks ||
    !clearingRoundPreview ||
    actualV0AltTxBytes === null ||
    !signature
  ) {
    throw lastAttemptError instanceof Error
      ? lastAttemptError
      : new Error("Unable to settle any multilateral clearing round shape");
  }

  const totalUnderlyingCommitments = edgeCommitmentCount * channelEdges.length;
  const totalGrossRouted = grossAmount * channelEdges.length;
  const signedCommitmentPreview = buildSignedCommitmentPreview({
    messageDomain,
    decimals,
    tokenSymbol,
    inputs: channelEdges
      .slice(0, Math.min(SIGNED_COMMITMENT_PREVIEW_COUNT, channelEdges.length))
      .map(({ payer, payee, channel }) => ({
        payer,
        payee,
        committedAmount:
          channel.settledCumulative.toNumber() + rawAmountPerCommitment,
        tokenId,
      })),
  });
  const participantBalancesAfter = await Promise.all(
    participants.map(async (participant) => ({
      participant,
      balance: await fetchInternalBalance(program, participant, tokenId),
    }))
  );
  const channelEdgesAfter = await Promise.all(
    channelEdges.map(async (edge) => ({
      ...edge,
      afterChannel: await fetchDirectionalChannelState(
        program,
        edge.channelPda,
        edge.payer.participantId,
        edge.payee.participantId
      ),
    }))
  );
  const incomingByPayee = new Map<
    number,
    { incomingCount: number; payers: Set<number> }
  >();
  for (const block of roundBlocks) {
    for (const entry of block.entries) {
      const current = incomingByPayee.get(entry.payee.participantId) ?? {
        incomingCount: 0,
        payers: new Set<number>(),
      };
      current.incomingCount += 1;
      current.payers.add(block.participant.participantId);
      incomingByPayee.set(entry.payee.participantId, current);
    }
  }
  const equivalentBundleTxCount = incomingByPayee.size;
  const batchSettlementParticipantWrites = [...incomingByPayee.values()].reduce(
    (sum, stat) => sum + stat.payers.size + 1,
    0
  );
  const multilateralParticipantBalanceWrites = participantBalancesBefore.reduce(
    (sum, { balance }, index) =>
      sum +
      (balance.available === participantBalancesAfter[index].balance.available
        ? 0
        : 1),
    0
  );
  if (channelEdges.length < channelCount) {
    logStep(
      `Requested a ${participants.length}-agent / ${channelCount}-channel flagship round, but the current cluster executed ${channelEdges.length} channels successfully. Falling back to the largest live shape.`
    );
  }
  logStep(
    `Flagship multilateral clearing example: ${edgeCommitmentCount.toLocaleString(
      "en-US"
    )} offchain micropayments on each of ${
      channelEdges.length
    } directed channels, ${totalUnderlyingCommitments.toLocaleString(
      "en-US"
    )} total`
  );
  logStep(
    `Gross value routed: ${formatAmount(
      grossAmount,
      decimals
    )} ${tokenSymbol} per channel, ${formatAmount(
      totalGrossRouted,
      decimals
    )} ${tokenSymbol} total at ${formatAmount(
      rawAmountPerCommitment,
      decimals
    )} each`
  );
  logStep(
    `Equivalent bundle-settlement baseline: ${
      channelEdges.length
    } latest commitments grouped into ${equivalentBundleTxCount} payee-side bundle tx${
      equivalentBundleTxCount === 1 ? "" : "s"
    }, ${batchSettlementParticipantWrites} participant balance writes, ${
      channelEdges.length
    } channel-state updates`
  );
  logStep(
    `BLS multilateral compression vs bundle settlement: ${formatCompressionRatio(
      equivalentBundleTxCount
    )}x fewer settlement txs (${equivalentBundleTxCount} -> 1), ${formatCompressionRatio(
      channelEdges.length
    )}x fewer signed payloads at final settlement (${
      channelEdges.length
    } -> 1 aggregate signature), ${formatCompressionRatio(
      participants.length
    )}x signer-envelope compression (${
      participants.length
    } participant signatures -> 1 aggregate signature), ${
      multilateralParticipantBalanceWrites === 0
        ? `participant balance writes eliminated (${batchSettlementParticipantWrites} -> 0)`
        : `${formatCompressionRatio(
            batchSettlementParticipantWrites /
              multilateralParticipantBalanceWrites
          )}x fewer participant balance writes (${batchSettlementParticipantWrites} -> ${multilateralParticipantBalanceWrites})`
    }`
  );
  logStep(
    `Channel-state writes today: no compression yet (${channelEdges.length} -> ${channelEdges.length}); every unilateral channel still advances in the round.`
  );
  logStep(
    "Net settlement flows submitted onchain: none (perfect multi-party offset)"
  );
  logStep(
    `Result: balances stay flat while all ${channelEdges.length} unilateral channels advance to their latest cumulative commitments`
  );
  logStep(
    `${participants.length}-agent graph compressed into 1 BLS-signed multilateral clearing round`
  );
  logStep(
    `  Actual serialized tx size (BLS v0 + ALT, self-funded): ${actualV0AltTxBytes}/${LEGACY_PACKET_DATA_SIZE} bytes`
  );
  logSignedCommitmentPreview(signedCommitmentPreview);
  logClearingRoundPayloadPreview(clearingRoundPreview);
  logSavingsComparison(
    totalUnderlyingCommitments,
    1,
    "1 multilateral clearing round"
  );
  participantBalancesBefore.forEach(({ participant, balance }, index) => {
    logStep(
      `  ${participant.name} internal: ${formatAmount(
        balance.available,
        decimals
      )} -> ${formatAmount(
        participantBalancesAfter[index].balance.available,
        decimals
      )}`
    );
  });
  const channelSamples = channelEdgesAfter
    .slice(0, Math.min(4, channelEdgesAfter.length))
    .map(
      ({ payer, payee, channel, afterChannel }) =>
        `${payer.name}->${payee.name} ${formatAmount(
          channel.settledCumulative.toNumber(),
          decimals
        )} -> ${formatAmount(
          afterChannel.settledCumulative.toNumber(),
          decimals
        )}`
    )
    .join("; ");
  logStep(
    `  Channel states: ${channelEdgesAfter.length} channels advanced; sample ${channelSamples}`
  );
  logStep(`  Explorer: ${explorerUrl(signature)}`);
  await logScenarioEvents(provider, program, signature);
  const achievedShape: BenchmarkShape = {
    participantCount: participants.length,
    channelCount: channelEdges.length,
  };
  const requestedShape: BenchmarkShape = {
    participantCount: participants.length,
    channelCount,
  };
  return {
    primarySignature: signature,
    benchmark: createBenchmarkScenario({
      id: scenarioId,
      title: scenarioTitle,
      settlementMode: "multilateral-clearing",
      participantCount: participants.length,
      channelCount: channelEdges.length,
      underlyingPaymentCount: totalUnderlyingCommitments,
      grossValueRaw: totalGrossRouted,
      decimals,
      tokenSymbol,
      signatures: [signature],
      serializedTransactionBytes: [actualV0AltTxBytes],
      signedMessageBytes: createClearingRoundMessage({
        tokenId,
        messageDomain,
        version: BLS_CLEARING_ROUND_MESSAGE_VERSION,
        blocks: roundBlocks.map((block) => ({
          participantId: block.participant.participantId,
          entries: block.entries.map((entry) => ({
            payeeRef: entry.payeeRef,
            targetCumulative: entry.targetCumulative,
          })),
        })),
      }).length,
      signatureCount: 1,
      participantBalanceWrites: multilateralParticipantBalanceWrites,
      channelLaneWrites: channelEdges.length,
      requestedShape,
      achievedShape,
      notes: [
        `BLS aggregated ${
          roundBlocks.filter((block) => block.entries.length > 0).length
        } active participant cosignatures into one on-chain signature envelope.`,
        "Channel-state writes still scale with included channels, so BLS mostly expands the byte budget rather than removing per-channel work.",
      ],
    }),
    settledChannelCount: channelEdges.length,
  };
}

async function runLargestExecutableMultilateralScenario(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  participants: DemoWallet[],
  target: BenchmarkShape,
  edgeCommitmentCount: number,
  amountPerCommitment: number,
  scenarioId: string,
  scenarioTitle: string
): Promise<MultilateralScenarioResult> {
  if (participants.length < 3) {
    throw new Error("At least three funded participants are required");
  }

  const candidateShapes: BenchmarkShape[] = [];
  const pushCandidate = (shape: BenchmarkShape): void => {
    if (
      shape.participantCount < 3 ||
      shape.participantCount > participants.length ||
      shape.channelCount < shape.participantCount
    ) {
      return;
    }
    if (
      !candidateShapes.some(
        (candidate) =>
          candidate.participantCount === shape.participantCount &&
          candidate.channelCount === shape.channelCount
      )
    ) {
      candidateShapes.push(shape);
    }
  };

  const cappedTarget: BenchmarkShape = {
    participantCount: Math.min(target.participantCount, participants.length),
    channelCount: Math.min(
      target.channelCount,
      Math.min(target.participantCount, participants.length) *
        (Math.min(target.participantCount, participants.length) - 1)
    ),
  };
  pushCandidate(cappedTarget);
  for (
    let channelCandidate = cappedTarget.channelCount - 1;
    channelCandidate >= cappedTarget.participantCount;
    channelCandidate -= 1
  ) {
    pushCandidate({
      participantCount: cappedTarget.participantCount,
      channelCount: channelCandidate,
    });
  }
  for (
    let participantCount = cappedTarget.participantCount - 1;
    participantCount >= 3;
    participantCount -= 1
  ) {
    pushCandidate({
      participantCount,
      channelCount: Math.min(
        cappedTarget.channelCount,
        participantCount * (participantCount - 1)
      ),
    });
  }

  let lastError: unknown = null;
  for (const shape of candidateShapes) {
    try {
      return await runMultilateralClearingScenario(
        provider,
        program,
        messageDomain,
        tokenId,
        tokenSymbol,
        decimals,
        participants.slice(0, shape.participantCount),
        shape.channelCount,
        edgeCommitmentCount,
        amountPerCommitment,
        scenarioId,
        scenarioTitle
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to find an executable multilateral clearing shape");
}

async function prepareMultilateralSearchContext(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  messageDomain: Buffer,
  tokenId: number,
  tokenSymbol: string,
  decimals: number,
  wallets: DemoWallet[],
  vaultTokenAccount: PublicKey,
  options: CliOptions,
  runId: string
): Promise<MultilateralSearchContext> {
  await ensureTargetInternalBalances(
    program,
    wallets,
    tokenId,
    tokenSymbol,
    decimals,
    vaultTokenAccount,
    options.blsInternalBalanceTarget
  );

  const completeGraphEdges = await ensureDenseGraphChannels(
    program,
    wallets,
    tokenId,
    options.blsMaxDenseChannels
  );
  const providerPayer = (provider.wallet as any).payer as Keypair | undefined;
  const sponsor = await selectFeeSponsor(provider.connection, [
    ...(providerPayer ? [providerPayer] : []),
    ...wallets.map((wallet) => wallet.keypair),
  ]);
  const submitter = wallets[0];
  const extraSigners = sponsor.publicKey.equals(submitter.keypair.publicKey)
    ? []
    : [submitter.keypair];

  const lookupTables = await createLookupTablesForAddresses(
    provider.connection,
    submitter.keypair,
    sponsor,
    [
      findTokenRegistryPda(program.programId),
      findGlobalConfigPda(program.programId),
      SYSVAR_INSTRUCTIONS_PUBKEY,
      ...wallets.map((wallet) => wallet.participantPda),
      ...completeGraphEdges.map((edge) => edge.channelPda),
    ]
  );

  logSection("BLS Search Setup");
  logStep(
    `Prepared ${wallets.length} participants, ${
      completeGraphEdges.length
    } directed channels (cap ${options.blsMaxDenseChannels}), and ${
      lookupTables.length
    } lookup table${lookupTables.length === 1 ? "" : "s"} for the BLS search`
  );
  logStep(
    `BLS search results log: ${resolveInputPath(
      process.cwd(),
      options.blsSearchResultsLogPath
    )}`
  );

  return {
    fullParticipants: wallets,
    completeGraphEdges,
    lookupTables,
    sponsor,
    extraSigners,
    decimals,
    tokenId,
    tokenSymbol,
    messageDomain,
    edgeCommitmentCount: options.multilateralEdgeCommitmentCount,
    resultsLogPath: resolveInputPath(
      process.cwd(),
      options.blsSearchResultsLogPath
    ),
    runId,
    scenarioSeed: options.blsRandomSeed,
    randomMinAmount: options.blsRandomMinAmount,
    randomMaxAmount: options.blsRandomMaxAmount,
    denseChannelCap: options.blsMaxDenseChannels,
    computeUnitLimit: options.blsComputeUnitLimit,
  };
}

function selectMultilateralEdgesForCandidate(
  context: MultilateralSearchContext,
  definition: MultilateralScenarioDefinition,
  candidateValue: number
): MultilateralEdgeSelection {
  const edgeByKey = new Map(
    context.completeGraphEdges.map((edge) => [
      multilateralEdgeKey(edge.payer.participantId, edge.payee.participantId),
      edge,
    ])
  );

  if (definition.mode === "max-participants") {
    const participants = definition.fullParticipantSet.slice(0, candidateValue);
    const edges = participants.map((payer, index) => {
      const payee = participants[(index + 1) % participants.length];
      const edge = edgeByKey.get(
        multilateralEdgeKey(payer.participantId, payee.participantId)
      );
      if (!edge) {
        throw new Error(
          `Missing dense-graph edge for ${payer.name} -> ${payee.name}`
        );
      }
      return edge;
    });
    return {
      participants,
      edges,
    };
  }

  const participantIds = new Set(
    definition.fullParticipantSet.map(
      (participant) => participant.participantId
    )
  );
  const eligibleEdges = context.completeGraphEdges.filter(
    (edge) =>
      participantIds.has(edge.payer.participantId) &&
      participantIds.has(edge.payee.participantId)
  );
  return {
    participants: definition.fullParticipantSet,
    edges: eligibleEdges.slice(0, candidateValue),
  };
}

function maxSupportedPrefixRingParticipantCount(
  context: MultilateralSearchContext,
  definition: MultilateralScenarioDefinition
): number {
  const requestedUpperBound = Math.min(
    definition.upperBound,
    definition.fullParticipantSet.length
  );
  const edgeKeys = new Set(
    context.completeGraphEdges.map((edge) =>
      multilateralEdgeKey(edge.payer.participantId, edge.payee.participantId)
    )
  );
  let maxSupported = 0;
  for (
    let participantCount = definition.lowerBound;
    participantCount <= requestedUpperBound;
    participantCount += 1
  ) {
    const participants = definition.fullParticipantSet.slice(
      0,
      participantCount
    );
    const ringSupported = participants.every((payer, index) => {
      const payee = participants[(index + 1) % participants.length];
      return edgeKeys.has(
        multilateralEdgeKey(payer.participantId, payee.participantId)
      );
    });
    if (!ringSupported) {
      break;
    }
    maxSupported = participantCount;
  }
  return maxSupported;
}

function uniqueWritableMetasForPubkeys(
  pubkeys: PublicKey[]
): Array<{ pubkey: PublicKey; isSigner: false; isWritable: true }> {
  const seenPairAccounts = new Set<string>();
  const metas: Array<{
    pubkey: PublicKey;
    isSigner: false;
    isWritable: true;
  }> = [];
  for (const pubkey of pubkeys) {
    const pairKey = pubkey.toString();
    if (seenPairAccounts.has(pairKey)) {
      continue;
    }
    seenPairAccounts.add(pairKey);
    metas.push({
      pubkey,
      isSigner: false,
      isWritable: true,
    });
  }
  return metas;
}

function uniquePubkeys(pubkeys: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const unique: PublicKey[] = [];
  for (const pubkey of pubkeys) {
    const key = pubkey.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pubkey);
  }
  return unique;
}

async function prepareMultilateralRound(
  program: Program<RyvoProtocol>,
  context: MultilateralSearchContext,
  definition: MultilateralScenarioDefinition,
  selection: MultilateralEdgeSelection
): Promise<MultilateralPreparedRound> {
  const participantIndexById = new Map(
    selection.participants.map((participant, index) => [
      participant.participantId,
      index,
    ])
  );
  const orderedEdges = [...selection.edges].sort((left, right) => {
    const leftPayerIndex =
      participantIndexById.get(left.payer.participantId) ??
      Number.MAX_SAFE_INTEGER;
    const rightPayerIndex =
      participantIndexById.get(right.payer.participantId) ??
      Number.MAX_SAFE_INTEGER;
    if (leftPayerIndex !== rightPayerIndex) {
      return leftPayerIndex - rightPayerIndex;
    }

    const leftPayeeIndex =
      participantIndexById.get(left.payee.participantId) ??
      Number.MAX_SAFE_INTEGER;
    const rightPayeeIndex =
      participantIndexById.get(right.payee.participantId) ??
      Number.MAX_SAFE_INTEGER;
    return leftPayeeIndex - rightPayeeIndex;
  });
  const roundBlocksByParticipantId = new Map<
    number,
    ClearingRoundPreviewBlockInput
  >(
    selection.participants.map((participant) => [
      participant.participantId,
      {
        participant,
        entries: [],
      },
    ])
  );
  let totalGrossRouted = 0;

  for (const edge of orderedEdges) {
    const payeeRef = participantIndexById.get(edge.payee.participantId);
    if (payeeRef === undefined) {
      throw new Error(
        `Payee ${edge.payee.name} is missing from the candidate participant set`
      );
    }
    const obligationRaw = deterministicRawChannelAmount({
      seed: context.scenarioSeed,
      scenarioId: definition.scenarioId,
      payer: edge.payer,
      payee: edge.payee,
      decimals: context.decimals,
      minAmount: context.randomMinAmount,
      maxAmount: context.randomMaxAmount,
    });
    totalGrossRouted += obligationRaw;
    roundBlocksByParticipantId.get(edge.payer.participantId)?.entries.push({
      payeeRef,
      payee: edge.payee,
      targetCumulative:
        edge.channel.settledCumulative.toNumber() + obligationRaw,
    });
  }

  const roundBlocks = selection.participants.map((participant) => {
    const block = roundBlocksByParticipantId.get(participant.participantId);
    if (!block) {
      throw new Error(
        `Candidate participant ${participant.name} is missing from round blocks`
      );
    }
    return block;
  });
  const message = createClearingRoundMessage({
    tokenId: context.tokenId,
    messageDomain: context.messageDomain,
    version: BLS_CLEARING_ROUND_MESSAGE_VERSION,
    blocks: roundBlocks.map((block) => ({
      participantId: block.participant.participantId,
      entries: block.entries.map((entry) => ({
        payeeRef: entry.payeeRef,
        targetCumulative: entry.targetCumulative,
      })),
    })),
  });
  const activeRoundParticipants = roundBlocks
    .filter((block) => block.entries.length > 0)
    .map((block) => block.participant);
  const aggregateSignatureCompressed = aggregateBlsSignatures(
    activeRoundParticipants.map((participant) =>
      signBlsMessage(participant, message)
    )
  );
  const remainingAccounts = [
    ...uniqueWritableMetasForPubkeys(
      selection.participants.map((participant) => participant.participantPda)
    ),
    ...uniqueWritableMetasForPubkeys(
      orderedEdges.map((edge) => edge.channelPda)
    ),
  ];
  const submitter = selection.participants[0];
  const instruction = await program.methods
    .settleClearingRound(message, [...aggregateSignatureCompressed])
    .accounts({
      tokenRegistry: findTokenRegistryPda(program.programId),
      globalConfig: findGlobalConfigPda(program.programId),
      submitter: submitter.keypair.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts(remainingAccounts)
    .instruction();
  const clearingRoundPreview = buildClearingRoundPayloadPreview({
    messageDomain: context.messageDomain,
    tokenId: context.tokenId,
    tokenSymbol: context.tokenSymbol,
    decimals: context.decimals,
    blocks: roundBlocks,
    version: BLS_CLEARING_ROUND_MESSAGE_VERSION,
    aggregateSignature: aggregateSignatureCompressed,
  });
  const signedCommitmentPreview = buildSignedCommitmentPreview({
    messageDomain: context.messageDomain,
    decimals: context.decimals,
    tokenSymbol: context.tokenSymbol,
    inputs: orderedEdges
      .slice(0, Math.min(SIGNED_COMMITMENT_PREVIEW_COUNT, orderedEdges.length))
      .map((edge) => {
        const block = roundBlocksByParticipantId.get(edge.payer.participantId);
        const matchingEntry = block?.entries.find(
          (entry) =>
            edge.payee.participantId ===
            selection.participants[entry.payeeRef]?.participantId
        );
        return {
          payer: edge.payer,
          payee: edge.payee,
          committedAmount:
            matchingEntry?.targetCumulative ??
            edge.channel.settledCumulative.toNumber(),
          tokenId: context.tokenId,
        };
      }),
  });

  return {
    participants: selection.participants,
    edges: orderedEdges,
    roundBlocks,
    message,
    aggregateSignatureCompressed,
    instruction,
    clearingRoundPreview,
    signedCommitmentPreview,
    totalGrossRouted,
    totalUnderlyingCommitments:
      context.edgeCommitmentCount * orderedEdges.length,
  };
}

async function evaluateMultilateralCandidate(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  context: MultilateralSearchContext,
  definition: MultilateralScenarioDefinition,
  candidateValue: number
): Promise<{
  attempt: MultilateralSearchAttempt;
  preparedRound: MultilateralPreparedRound;
}> {
  const selection = selectMultilateralEdgesForCandidate(
    context,
    definition,
    candidateValue
  );
  const candidate: MultilateralCandidate = {
    participantCount: selection.participants.length,
    channelCount: selection.edges.length,
  };
  const preparedRound = await prepareMultilateralRound(
    program,
    context,
    definition,
    selection
  );
  const txBytes = await estimateVersionedTransactionBytes({
    connection: provider.connection,
    feePayer: context.sponsor,
    instructions: buildBlsExecutionInstructions(
      context.computeUnitLimit,
      preparedRound.instruction
    ),
    lookupTables: context.lookupTables,
    extraSigners: context.extraSigners,
  });
  const fitsPacket = txBytes <= LEGACY_PACKET_DATA_SIZE;
  let simulationPassed = false;
  let simulationError: string | null = null;
  let simulationLogs: string[] = [];

  if (fitsPacket) {
    const simulation = await simulateVersionedTransaction({
      connection: provider.connection,
      feePayer: context.sponsor,
      instructions: buildBlsExecutionInstructions(
        context.computeUnitLimit,
        preparedRound.instruction
      ),
      lookupTables: context.lookupTables,
      extraSigners: context.extraSigners,
    });
    simulationPassed = simulation.ok;
    simulationError = simulation.error;
    simulationLogs = simulation.logs;
  } else {
    simulationError = "packet_limit_exceeded";
  }

  const attempt: MultilateralSearchAttempt = {
    candidate,
    txBytes,
    fitsPacket,
    simulationPassed,
    simulationError,
    messageBytes: preparedRound.message.length,
    aggregateSignatureBytes: preparedRound.aggregateSignatureCompressed.length,
  };

  await appendBlsSearchResult(context.resultsLogPath, {
    timestamp: new Date().toISOString(),
    runId: context.runId,
    programId: program.programId.toString(),
    rpcEndpoint: provider.connection.rpcEndpoint,
    denseChannelCap: context.denseChannelCap,
    computeUnitLimit: context.computeUnitLimit,
    scenarioId: definition.scenarioId,
    scenarioTitle: definition.scenarioTitle,
    mode: definition.mode,
    participantCount: attempt.candidate.participantCount,
    channelCount: attempt.candidate.channelCount,
    txBytes: attempt.txBytes,
    packetLimit: LEGACY_PACKET_DATA_SIZE,
    fitsPacket: attempt.fitsPacket,
    simulationPassed: attempt.simulationPassed,
    simulationError: attempt.simulationError,
    simulationLogs:
      simulationLogs.length > 0 ? simulationLogs.slice(-12) : undefined,
    submittedLive: false,
  });

  logStep(
    `Search candidate ${attempt.candidate.participantCount} participants / ${
      attempt.candidate.channelCount
    } channels -> ${attempt.txBytes}/${LEGACY_PACKET_DATA_SIZE} bytes, ${
      attempt.simulationPassed
        ? "simulation passed"
        : `simulation failed (${attempt.simulationError})`
    }`
  );

  return {
    attempt,
    preparedRound,
  };
}

async function findLargestSimulatedCandidate(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  context: MultilateralSearchContext,
  definition: MultilateralScenarioDefinition
): Promise<MultilateralSearchResult> {
  let low = definition.lowerBound;
  let high = definition.upperBound;
  let best: EvaluatedMultilateralCandidate | null = null;
  const successfulCandidates: EvaluatedMultilateralCandidate[] = [];

  while (low <= high) {
    const candidateValue = Math.floor((low + high) / 2);
    const evaluated = await evaluateMultilateralCandidate(
      provider,
      program,
      context,
      definition,
      candidateValue
    );
    if (evaluated.attempt.fitsPacket && evaluated.attempt.simulationPassed) {
      best = evaluated;
      successfulCandidates.push(evaluated);
      low = candidateValue + 1;
    } else {
      high = candidateValue - 1;
    }
  }

  if (!best) {
    throw new Error(
      `No executable BLS candidate found for ${definition.scenarioTitle}`
    );
  }

  successfulCandidates.sort(
    (left, right) =>
      right.attempt.candidate.channelCount -
        left.attempt.candidate.channelCount ||
      right.attempt.candidate.participantCount -
        left.attempt.candidate.participantCount
  );

  return { best, successfulCandidates };
}

function isBetterMaxChannelsEvaluation(
  currentBest: MultilateralCandidateEvaluation | null,
  candidate: MultilateralCandidateEvaluation
): boolean {
  if (!currentBest) {
    return true;
  }
  if (
    candidate.attempt.candidate.channelCount !==
    currentBest.attempt.candidate.channelCount
  ) {
    return (
      candidate.attempt.candidate.channelCount >
      currentBest.attempt.candidate.channelCount
    );
  }
  return (
    candidate.attempt.candidate.participantCount >
    currentBest.attempt.candidate.participantCount
  );
}

class LiveMultilateralSubmitError extends Error {
  readonly originalError: unknown;

  constructor(attempt: MultilateralSearchAttempt, originalError: unknown) {
    super(
      `Live BLS submission failed for ${
        attempt.candidate.participantCount
      } participants / ${
        attempt.candidate.channelCount
      } channels: ${errorMessage(originalError)}`
    );
    this.name = "LiveMultilateralSubmitError";
    this.originalError = originalError;
  }
}

async function appendBlsLiveSubmitResult(params: {
  provider: anchor.AnchorProvider;
  program: Program<RyvoProtocol>;
  context: MultilateralSearchContext;
  definition: MultilateralScenarioDefinition;
  attempt: MultilateralSearchAttempt;
  liveSuccess: boolean;
  signature?: string;
  liveError?: unknown;
  liveLogs?: string[];
  finalSimulationPassed?: boolean;
  finalSimulationError?: string | null;
  finalSimulationLogs?: string[];
}): Promise<void> {
  await appendBlsSearchResult(params.context.resultsLogPath, {
    timestamp: new Date().toISOString(),
    runId: params.context.runId,
    programId: params.program.programId.toString(),
    rpcEndpoint: params.provider.connection.rpcEndpoint,
    denseChannelCap: params.context.denseChannelCap,
    computeUnitLimit: params.context.computeUnitLimit,
    scenarioId: params.definition.scenarioId,
    scenarioTitle: params.definition.scenarioTitle,
    mode: params.definition.mode,
    participantCount: params.attempt.candidate.participantCount,
    channelCount: params.attempt.candidate.channelCount,
    txBytes: params.attempt.txBytes,
    packetLimit: LEGACY_PACKET_DATA_SIZE,
    fitsPacket: params.attempt.fitsPacket,
    simulationPassed: params.attempt.simulationPassed,
    simulationError: params.attempt.simulationError,
    submittedLive: true,
    liveSuccess: params.liveSuccess,
    signature: params.signature,
    liveError:
      params.liveError === undefined
        ? undefined
        : errorMessage(params.liveError),
    liveLogs:
      params.liveLogs && params.liveLogs.length > 0
        ? params.liveLogs.slice(-12)
        : undefined,
    finalSimulationPassed: params.finalSimulationPassed,
    finalSimulationError: params.finalSimulationError,
    finalSimulationLogs:
      params.finalSimulationLogs && params.finalSimulationLogs.length > 0
        ? params.finalSimulationLogs.slice(-12)
        : undefined,
  });
}

async function submitMultilateralScenario(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  context: MultilateralSearchContext,
  definition: MultilateralScenarioDefinition,
  attempt: MultilateralSearchAttempt,
  preparedRound: MultilateralPreparedRound
): Promise<MultilateralScenarioResult> {
  logStep(
    `Selected live BLS candidate: ${attempt.candidate.participantCount} participants / ${attempt.candidate.channelCount} channels`
  );

  const participantBalancesBefore = await Promise.all(
    preparedRound.participants.map(async (participant) => ({
      participant,
      balance: await fetchInternalBalance(
        program,
        participant,
        context.tokenId
      ),
    }))
  );
  const liveInstructions = buildBlsExecutionInstructions(
    context.computeUnitLimit,
    preparedRound.instruction
  );
  let finalSimulation: {
    ok: boolean;
    error: string | null;
    logs: string[];
  };
  try {
    finalSimulation = await simulateVersionedTransaction({
      connection: provider.connection,
      feePayer: context.sponsor,
      instructions: liveInstructions,
      lookupTables: context.lookupTables,
      extraSigners: context.extraSigners,
    });
  } catch (error) {
    const logs = await getTransactionErrorLogs(provider.connection, error);
    await appendBlsLiveSubmitResult({
      provider,
      program,
      context,
      definition,
      attempt,
      liveSuccess: false,
      liveError: error,
      liveLogs: logs,
      finalSimulationPassed: false,
      finalSimulationError: errorMessage(error),
      finalSimulationLogs: logs,
    });
    throw new LiveMultilateralSubmitError(attempt, error);
  }
  if (!finalSimulation.ok) {
    const error = new Error(
      `Final live simulation failed (${finalSimulation.error})`
    );
    (error as any).logs = finalSimulation.logs;
    await appendBlsLiveSubmitResult({
      provider,
      program,
      context,
      definition,
      attempt,
      liveSuccess: false,
      liveError: error,
      liveLogs: finalSimulation.logs,
      finalSimulationPassed: false,
      finalSimulationError: finalSimulation.error,
      finalSimulationLogs: finalSimulation.logs,
    });
    throw new LiveMultilateralSubmitError(attempt, error);
  }

  let signature: string;
  try {
    signature = await sendVersionedTransaction({
      connection: provider.connection,
      feePayer: context.sponsor,
      instructions: liveInstructions,
      lookupTables: context.lookupTables,
      extraSigners: context.extraSigners,
      // BLS rounds are explicitly simulated immediately above. Skipping RPC
      // preflight avoids a second load-balanced devnet simulation from
      // disagreeing after the client has already validated the exact tx shape.
      skipPreflight: true,
    });
  } catch (error) {
    const logs = await getTransactionErrorLogs(provider.connection, error);
    await appendBlsLiveSubmitResult({
      provider,
      program,
      context,
      definition,
      attempt,
      liveSuccess: false,
      liveError: error,
      liveLogs: logs,
      finalSimulationPassed: true,
      finalSimulationError: null,
      finalSimulationLogs: finalSimulation.logs,
    });
    throw new LiveMultilateralSubmitError(attempt, error);
  }
  const participantBalancesAfter = await Promise.all(
    preparedRound.participants.map(async (participant) => ({
      participant,
      balance: await fetchInternalBalance(
        program,
        participant,
        context.tokenId
      ),
    }))
  );
  const channelEdgesAfter = await Promise.all(
    preparedRound.edges.map(async (edge) => ({
      ...edge,
      afterChannel: await fetchDirectionalChannelState(
        program,
        edge.channelPda,
        edge.payer.participantId,
        edge.payee.participantId
      ),
    }))
  );
  const edgeByKey = new Map(
    context.completeGraphEdges.map((edge) => [
      multilateralEdgeKey(edge.payer.participantId, edge.payee.participantId),
      edge,
    ])
  );
  for (const updatedEdge of channelEdgesAfter) {
    const cached = edgeByKey.get(
      multilateralEdgeKey(
        updatedEdge.payer.participantId,
        updatedEdge.payee.participantId
      )
    );
    if (cached) {
      cached.channel = updatedEdge.afterChannel;
    }
  }

  await appendBlsLiveSubmitResult({
    provider,
    program,
    context,
    definition,
    attempt,
    liveSuccess: true,
    signature,
    finalSimulationPassed: true,
    finalSimulationError: null,
  });

  const incomingByPayee = new Map<
    number,
    { incomingCount: number; payers: Set<number> }
  >();
  for (const block of preparedRound.roundBlocks) {
    for (const entry of block.entries) {
      const current = incomingByPayee.get(entry.payee.participantId) ?? {
        incomingCount: 0,
        payers: new Set<number>(),
      };
      current.incomingCount += 1;
      current.payers.add(block.participant.participantId);
      incomingByPayee.set(entry.payee.participantId, current);
    }
  }
  const equivalentBundleTxCount = incomingByPayee.size;
  const batchSettlementParticipantWrites = [...incomingByPayee.values()].reduce(
    (sum, stat) => sum + stat.payers.size + 1,
    0
  );
  const multilateralParticipantBalanceWrites = participantBalancesBefore.reduce(
    (sum, { balance }, index) =>
      sum +
      (balance.available === participantBalancesAfter[index].balance.available
        ? 0
        : 1),
    0
  );

  logStep(
    `Flagship multilateral clearing example: ${preparedRound.totalUnderlyingCommitments.toLocaleString(
      "en-US"
    )} modeled underlying micropayments collapsed into 1 BLS round across ${
      preparedRound.edges.length
    } directed channels`
  );
  logStep(
    `Gross value routed: ${formatAmount(
      preparedRound.totalGrossRouted,
      context.decimals
    )} ${context.tokenSymbol} total from deterministic obligations between ${
      context.randomMinAmount
    } and ${context.randomMaxAmount} ${context.tokenSymbol}`
  );
  logStep(
    `Equivalent bundle-settlement baseline: ${
      preparedRound.edges.length
    } latest commitments grouped into ${equivalentBundleTxCount} payee-side bundle tx${
      equivalentBundleTxCount === 1 ? "" : "s"
    }, ${batchSettlementParticipantWrites} participant balance writes, ${
      preparedRound.edges.length
    } channel-state updates`
  );
  logStep(
    `BLS multilateral compression vs bundle settlement: ${formatCompressionRatio(
      equivalentBundleTxCount
    )}x fewer settlement txs (${equivalentBundleTxCount} -> 1), ${formatCompressionRatio(
      preparedRound.edges.length
    )}x fewer signed payloads at final settlement (${
      preparedRound.edges.length
    } -> 1 aggregate signature), ${formatCompressionRatio(
      preparedRound.participants.length
    )}x signer-envelope compression (${
      preparedRound.participants.length
    } participant signatures -> 1 aggregate signature), ${
      multilateralParticipantBalanceWrites === 0
        ? `participant balance writes eliminated (${batchSettlementParticipantWrites} -> 0)`
        : `${formatCompressionRatio(
            batchSettlementParticipantWrites /
              multilateralParticipantBalanceWrites
          )}x fewer participant balance writes (${batchSettlementParticipantWrites} -> ${multilateralParticipantBalanceWrites})`
    }`
  );
  logStep(
    `Channel-state writes today: no compression yet (${preparedRound.edges.length} -> ${preparedRound.edges.length}); every unilateral channel still advances in the round.`
  );
  logStep(
    `  Actual serialized tx size (BLS v0 + ALT, self-funded): ${attempt.txBytes}/${LEGACY_PACKET_DATA_SIZE} bytes`
  );
  logSignedCommitmentPreview(preparedRound.signedCommitmentPreview);
  logClearingRoundPayloadPreview(preparedRound.clearingRoundPreview);
  logSavingsComparison(
    preparedRound.totalUnderlyingCommitments,
    1,
    "1 multilateral clearing round"
  );
  participantBalancesBefore.forEach(({ participant, balance }, index) => {
    logStep(
      `  ${participant.name} internal: ${formatAmount(
        balance.available,
        context.decimals
      )} -> ${formatAmount(
        participantBalancesAfter[index].balance.available,
        context.decimals
      )}`
    );
  });
  const channelSamples = channelEdgesAfter
    .slice(0, Math.min(4, channelEdgesAfter.length))
    .map(
      ({ payer, payee, channel, afterChannel }) =>
        `${payer.name}->${payee.name} ${formatAmount(
          channel.settledCumulative.toNumber(),
          context.decimals
        )} -> ${formatAmount(
          afterChannel.settledCumulative.toNumber(),
          context.decimals
        )}`
    )
    .join("; ");
  logStep(
    `  Channel states: ${channelEdgesAfter.length} channels advanced; sample ${channelSamples}`
  );
  logStep(`  Explorer: ${explorerUrl(signature)}`);
  await logScenarioEvents(provider, program, signature);

  return {
    primarySignature: signature,
    benchmark: createBenchmarkScenario({
      id: definition.scenarioId,
      title: definition.scenarioTitle,
      settlementMode: "multilateral-clearing",
      participantCount: preparedRound.participants.length,
      channelCount: preparedRound.edges.length,
      underlyingPaymentCount: preparedRound.totalUnderlyingCommitments,
      grossValueRaw: preparedRound.totalGrossRouted,
      decimals: context.decimals,
      tokenSymbol: context.tokenSymbol,
      signatures: [signature],
      serializedTransactionBytes: [attempt.txBytes],
      signedMessageBytes: preparedRound.message.length,
      signatureCount: 1,
      participantBalanceWrites: multilateralParticipantBalanceWrites,
      channelLaneWrites: preparedRound.edges.length,
      requestedShape: {
        participantCount:
          definition.mode === "max-participants"
            ? definition.upperBound
            : definition.fullParticipantSet.length,
        channelCount: definition.upperBound,
      },
      achievedShape: attempt.candidate,
      notes: [
        `BLS aggregated ${
          preparedRound.roundBlocks.filter((block) => block.entries.length > 0)
            .length
        } active participant cosignatures into one on-chain signature envelope.`,
        `Dense-graph search results were appended to ${context.resultsLogPath}.`,
      ],
    }),
    settledChannelCount: preparedRound.edges.length,
  };
}

async function submitLargestLiveMultilateralScenario(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  context: MultilateralSearchContext,
  definition: MultilateralScenarioDefinition,
  searchResult: MultilateralSearchResult
): Promise<MultilateralScenarioResult> {
  const candidates = [...searchResult.successfulCandidates];
  if (
    !candidates.some(
      (candidate) =>
        candidate.attempt.candidate.participantCount ===
          searchResult.best.attempt.candidate.participantCount &&
        candidate.attempt.candidate.channelCount ===
          searchResult.best.attempt.candidate.channelCount
    )
  ) {
    candidates.unshift(searchResult.best);
  }

  let lastLiveSubmitError: unknown = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (index > 0) {
      logStep(
        `Retrying BLS live submission with next smaller simulated candidate: ${candidate.attempt.candidate.participantCount} participants / ${candidate.attempt.candidate.channelCount} channels`
      );
    }

    try {
      return await submitMultilateralScenario(
        provider,
        program,
        context,
        definition,
        candidate.attempt,
        candidate.preparedRound
      );
    } catch (error) {
      if (!(error instanceof LiveMultilateralSubmitError)) {
        throw error;
      }
      lastLiveSubmitError = error.originalError;
      logStep(
        `Live BLS submit failed for ${
          candidate.attempt.candidate.participantCount
        } participants / ${
          candidate.attempt.candidate.channelCount
        } channels: ${errorMessage(error.originalError).split("\n")[0]}`
      );
    }
  }

  throw lastLiveSubmitError instanceof Error
    ? lastLiveSubmitError
    : new Error(
        `Unable to submit any simulated BLS candidate for ${definition.scenarioTitle}`
      );
}

async function runBinarySearchMultilateralScenario(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  context: MultilateralSearchContext,
  definition: MultilateralScenarioDefinition
): Promise<MultilateralScenarioResult> {
  let searchDefinition = definition;
  if (definition.mode === "max-participants") {
    const supportedUpperBound = maxSupportedPrefixRingParticipantCount(
      context,
      definition
    );
    if (supportedUpperBound < definition.lowerBound) {
      throw new Error(
        `Dense graph cap ${context.denseChannelCap} did not prepare enough prefix-ring channels for ${definition.scenarioTitle}; increase RYVO_DEMO_BLS_MAX_DENSE_CHANNELS.`
      );
    }
    if (supportedUpperBound < definition.upperBound) {
      searchDefinition = {
        ...definition,
        upperBound: supportedUpperBound,
      };
    }
  }

  logSection(searchDefinition.scenarioTitle);
  logStep(
    searchDefinition.mode === "max-participants"
      ? `Binary searching participant count from ${searchDefinition.lowerBound} to ${searchDefinition.upperBound} using one directed edge per participant`
      : `Binary searching channel count from ${searchDefinition.lowerBound} to ${searchDefinition.upperBound} over the full ${searchDefinition.fullParticipantSet.length}-participant dense graph`
  );
  if (searchDefinition.upperBound < definition.upperBound) {
    logStep(
      `Dense graph cap limited this run from ${definition.upperBound} to ${searchDefinition.upperBound} participants`
    );
  }
  if (
    !context.sponsor.publicKey.equals(
      searchDefinition.fullParticipantSet[0].keypair.publicKey
    )
  ) {
    logStep(
      `Using ${context.sponsor.publicKey.toString()} as the fee sponsor for the multilateral round while ${
        searchDefinition.fullParticipantSet[0].name
      } remains the signed submitter`
    );
  }

  const searchResult = await findLargestSimulatedCandidate(
    provider,
    program,
    context,
    searchDefinition
  );

  return submitLargestLiveMultilateralScenario(
    provider,
    program,
    context,
    searchDefinition,
    searchResult
  );
}

async function runAdaptiveMaxChannelsScenario(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  context: MultilateralSearchContext,
  scenarioId: string,
  scenarioTitle: string
): Promise<MultilateralScenarioResult> {
  logSection(scenarioTitle);
  logStep(
    `Searching max channels across participant counts from ${context.fullParticipants.length} down to 3 within the ${context.denseChannelCap}-channel dense-graph cap`
  );
  if (
    !context.sponsor.publicKey.equals(
      context.fullParticipants[0].keypair.publicKey
    )
  ) {
    logStep(
      `Using ${context.sponsor.publicKey.toString()} as the fee sponsor for the multilateral round while ${
        context.fullParticipants[0].name
      } remains the signed submitter`
    );
  }

  let best: MultilateralCandidateEvaluation | null = null;
  let lastError: unknown = null;

  for (
    let participantCount = context.fullParticipants.length;
    participantCount >= 3;
    participantCount -= 1
  ) {
    const participantSubset = context.fullParticipants.slice(
      0,
      participantCount
    );
    const participantIds = new Set(
      participantSubset.map((participant) => participant.participantId)
    );
    const eligibleEdgeCount = context.completeGraphEdges.filter(
      (edge) =>
        participantIds.has(edge.payer.participantId) &&
        participantIds.has(edge.payee.participantId)
    ).length;
    const upperBound = Math.min(context.denseChannelCap, eligibleEdgeCount);
    if (upperBound < participantCount) {
      continue;
    }
    if (best && upperBound <= best.attempt.candidate.channelCount) {
      continue;
    }

    const lowerBound = Math.max(
      participantCount,
      best ? best.attempt.candidate.channelCount + 1 : participantCount
    );
    if (lowerBound > upperBound) {
      continue;
    }

    const definition: MultilateralScenarioDefinition = {
      scenarioId,
      scenarioTitle,
      mode: "max-channels",
      fullParticipantSet: participantSubset,
      lowerBound,
      upperBound,
    };

    try {
      logStep(
        `Evaluating ${participantCount} participants with channel search range ${lowerBound}-${upperBound}`
      );
      const searchResult = await findLargestSimulatedCandidate(
        provider,
        program,
        context,
        definition
      );
      const candidateEvaluation: MultilateralCandidateEvaluation = {
        definition,
        attempt: searchResult.best.attempt,
        preparedRound: searchResult.best.preparedRound,
        successfulCandidates: searchResult.successfulCandidates,
      };
      if (isBetterMaxChannelsEvaluation(best, candidateEvaluation)) {
        best = candidateEvaluation;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!best) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`No executable BLS candidate found for ${scenarioTitle}`);
  }

  return submitLargestLiveMultilateralScenario(
    provider,
    program,
    context,
    best.definition,
    {
      best: {
        attempt: best.attempt,
        preparedRound: best.preparedRound,
      },
      successfulCandidates: best.successfulCandidates,
    }
  );
}

async function logFinalSummary(
  provider: anchor.AnchorProvider,
  program: Program<RyvoProtocol>,
  wallets: DemoWallet[],
  tokenId: number,
  tokenSymbol: string,
  decimals: number
): Promise<void> {
  logSection("Final Summary");
  for (const wallet of wallets) {
    const internalBalance = await fetchInternalBalance(
      program,
      wallet,
      tokenId
    );
    const externalBalance = await fetchExternalBalance(
      provider,
      wallet.tokenAccount
    );
    logStep(
      `${wallet.name} (${wallet.keypair.publicKey.toString()}) participant=${
        wallet.participantId
      } internal=${formatAmount(
        internalBalance.available,
        decimals
      )} ${tokenSymbol} external=${formatAmount(
        externalBalance,
        decimals
      )} ${tokenSymbol}`
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = loadProvider();
  anchor.setProvider(provider);
  const program = loadProgram(provider);
  const deployer = (provider.wallet as any).payer as Keypair;
  if (!deployer) {
    throw new Error("Provider wallet does not expose a payer keypair");
  }
  const network = inferNetwork(provider.connection.rpcEndpoint);
  const clearingCapacitySummary = summarizeClearingRoundCapacity(
    program.programId
  );
  if (network !== "devnet") {
    throw new Error(
      `This showcase is wired for Solana devnet because the provided mint ${options.tokenMint.toString()} is a devnet mint. Connected RPC: ${
        provider.connection.rpcEndpoint
      }`
    );
  }
  const repoRoot = process.cwd();

  logSection("Ryvo Network Demo");
  if (options.configFilePath) {
    logStep(
      `Config file: ${resolveInputPath(repoRoot, options.configFilePath)}`
    );
  }
  logStep(`RPC endpoint: ${provider.connection.rpcEndpoint}`);
  logStep(`Program ID: ${program.programId.toString()}`);
  logStep(`Deployer: ${deployer.publicKey.toString()}`);
  logStep(`Token mint: ${options.tokenMint.toString()}`);
  logStep(`Wallet count: ${options.walletCount}`);

  const readiness = await ensureProgramReady(provider, program, options);
  logStep(`Chain ID: ${readiness.chainId}`);
  logStep(
    `Message domain: ${trimHex(readiness.messageDomain.toString("hex"))}`
  );
  logStep(`Fee recipient wallet: ${readiness.feeRecipient.toString()}`);
  logStep(`Vault token account: ${readiness.vaultTokenAccount.toString()}`);
  logStep(`Mint decimals: ${readiness.decimals}`);
  const preparedWallets = await prepareDemoWallets(options, repoRoot);
  const { runId, walletDir, wallets: loadedWallets } = preparedWallets;
  const wallets = selectActiveWallets(loadedWallets, options.activeWalletNames);
  const walletManifestPath = resolveDefaultWalletManifestPath(
    repoRoot,
    options.walletManifestPath
  );
  if (preparedWallets.source === "manifest") {
    logStep(`Reusing wallet files from ${walletDir}`);
    if (preparedWallets.manifestPath) {
      logStep(`Wallet manifest: ${preparedWallets.manifestPath}`);
    }
  } else {
    logStep(`Wallet files written to ${walletDir}`);
  }
  if (options.activeWalletNames) {
    logStep(
      `Active wallets: ${wallets.map((wallet) => wallet.name).join(", ")}`
    );
  }
  await saveWalletManifest(
    walletManifestPath,
    provider,
    program,
    deployer,
    options.tokenId,
    options.tokenSymbol,
    options.tokenMint,
    readiness.decimals,
    readiness.vaultTokenAccount,
    readiness.feeRecipient,
    loadedWallets,
    runId,
    preparedWallets.manifestPath ?? options.reuseManifestPath
  );

  if (options.skipFunding) {
    logStep("Skipping wallet funding and reusing current external balances");
    await ensureWalletTokenAccounts(
      provider,
      deployer,
      wallets,
      options.tokenMint
    );
  } else {
    await fundDemoWallets(
      provider,
      deployer,
      wallets,
      options.tokenMint,
      readiness.decimals,
      options.solPerWallet,
      options.tokensPerWallet
    );
  }
  await ensureParticipants(
    program,
    readiness.feeRecipient,
    wallets,
    options.skipParticipantInit
  );
  await ensureParticipantBlsKeys(program, readiness.messageDomain, wallets);
  await ensureDeposits(
    program,
    wallets,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    readiness.vaultTokenAccount,
    options.depositPlan,
    options.skipDeposits
  );
  const reusableManifestPath =
    preparedWallets.manifestPath ?? options.reuseManifestPath;
  await saveWalletManifest(
    walletManifestPath,
    provider,
    program,
    deployer,
    options.tokenId,
    options.tokenSymbol,
    options.tokenMint,
    readiness.decimals,
    readiness.vaultTokenAccount,
    readiness.feeRecipient,
    loadedWallets,
    runId,
    reusableManifestPath
  );

  const singleScenario = await runSingleCommitmentScenario(
    provider,
    program,
    readiness.messageDomain,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    wallets[0],
    wallets[1],
    options.singleCommitmentCount,
    options.singleCommitmentAmount,
    options.singleCommitmentLogEvery
  );
  const batchScenario = await runBatchCommitmentScenario(
    provider,
    program,
    readiness.messageDomain,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    wallets.slice(1),
    wallets[0],
    options.batchCommitmentBatchCount,
    options.batchCommitmentBatchSize,
    options.batchCommitmentAmount,
    options.batchCommitmentLogEvery
  );
  const atomicRoutedScenario = await runAtomicRoutedClearingScenario(
    provider,
    program,
    readiness.messageDomain,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    wallets[3],
    wallets[4],
    wallets[5],
    1,
    readiness.vaultTokenAccount
  );
  const multilateralSearchContext = await prepareMultilateralSearchContext(
    provider,
    program,
    readiness.messageDomain,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals,
    wallets,
    readiness.vaultTokenAccount,
    options,
    runId
  );
  const blsMaxParticipantsScenario = await runBinarySearchMultilateralScenario(
    provider,
    program,
    multilateralSearchContext,
    {
      scenarioId: "blsMaxParticipantsClearing",
      scenarioTitle:
        "Scenario 5/6 - BLS Clearing Round (Max Participants v0 + ALT)",
      mode: "max-participants",
      fullParticipantSet: wallets,
      lowerBound: 3,
      upperBound: wallets.length,
    }
  );
  const blsMaxChannelsScenario = options.skipMaxChannels
    ? null
    : await runAdaptiveMaxChannelsScenario(
        provider,
        program,
        multilateralSearchContext,
        "blsMaxChannelsClearing",
        "Scenario 6/6 - BLS Clearing Round (Max Channels v0 + ALT)"
      );
  const benchmarkScenarios = [
    singleScenario.benchmark,
    batchScenario.benchmark,
    atomicRoutedScenario.benchmark,
    blsMaxParticipantsScenario.benchmark,
    ...(blsMaxChannelsScenario ? [blsMaxChannelsScenario.benchmark] : []),
  ];
  const scenarioSignatures: ScenarioSignatureMap = {
    singleCommitment: singleScenario.primarySignature,
    batchCommitment: batchScenario.primarySignature,
    atomicRoutedClearing: atomicRoutedScenario.primarySignature,
    blsMaxParticipantsClearing: blsMaxParticipantsScenario.primarySignature,
    ...(blsMaxChannelsScenario
      ? { blsMaxChannelsClearing: blsMaxChannelsScenario.primarySignature }
      : {}),
  };

  if (blsMaxChannelsScenario) {
    logClearingRoundCapacityAnalysis(
      program.programId,
      clearingCapacitySummary,
      blsMaxParticipantsScenario,
      blsMaxChannelsScenario
    );
  } else {
    logStep("Skipping BLS max-channels scenario by request");
  }

  await logFinalSummary(
    provider,
    program,
    wallets,
    options.tokenId,
    options.tokenSymbol,
    readiness.decimals
  );

  const manifestPath = path.join(
    repoRoot,
    "config",
    `ryvo-protocol-demo-${runId}.json`
  );
  await saveRunManifest(manifestPath, {
    runId,
    network,
    rpcEndpoint: provider.connection.rpcEndpoint,
    programId: program.programId.toString(),
    deployer: deployer.publicKey.toString(),
    token: {
      id: options.tokenId,
      symbol: options.tokenSymbol,
      mint: options.tokenMint.toString(),
      decimals: readiness.decimals,
      vaultTokenAccount: readiness.vaultTokenAccount.toString(),
    },
    feeRecipient: readiness.feeRecipient.toString(),
    messageDomain: readiness.messageDomain.toString("hex"),
    reusedFromManifest: reusableManifestPath,
    settings: {
      skipFunding: options.skipFunding,
      skipParticipantInit: options.skipParticipantInit,
      skipDeposits: options.skipDeposits,
      skipMaxChannels: options.skipMaxChannels,
      walletManifestPath: walletManifestPath,
      blsSearchResultsLogPath: multilateralSearchContext.resultsLogPath,
      blsInternalBalanceTarget: options.blsInternalBalanceTarget,
      blsRandomSeed: options.blsRandomSeed,
      blsRandomMinAmount: options.blsRandomMinAmount,
      blsRandomMaxAmount: options.blsRandomMaxAmount,
      blsMaxDenseChannels: options.blsMaxDenseChannels,
      blsComputeUnitLimit: options.blsComputeUnitLimit,
      singleCommitmentCount: options.singleCommitmentCount,
      singleCommitmentAmount: options.singleCommitmentAmount,
      batchCommitmentBatchCount: options.batchCommitmentBatchCount,
      batchCommitmentBatchSize: options.batchCommitmentBatchSize,
      batchCommitmentAmount: options.batchCommitmentAmount,
      unilateralPayeeACommitmentCount: options.unilateralPayeeACommitmentCount,
      unilateralPayeeBCommitmentCount: options.unilateralPayeeBCommitmentCount,
      unilateralAmountPerCommitment: options.unilateralAmountPerCommitment,
      unilateralLockAmount: options.unilateralLockAmount,
      bilateralForwardCommitmentCount: options.bilateralForwardCommitmentCount,
      bilateralReverseCommitmentCount: options.bilateralReverseCommitmentCount,
      bilateralAmountPerCommitment: options.bilateralAmountPerCommitment,
      multilateralEdgeCommitmentCount: options.multilateralEdgeCommitmentCount,
      multilateralAmountPerCommitment: options.multilateralAmountPerCommitment,
    },
    wallets: wallets.map((wallet) => ({
      name: wallet.name,
      publicKey: wallet.keypair.publicKey.toString(),
      participantId: wallet.participantId,
      participantPda: wallet.participantPda.toString(),
      tokenAccount: wallet.tokenAccount.toString(),
      secretPath: wallet.secretPath,
    })),
    benchmarkScenarios,
    scenarios: scenarioSignatures,
    explorer: Object.fromEntries(
      Object.entries(scenarioSignatures).map(([name, signature]) => [
        name,
        explorerUrl(signature),
      ])
    ),
    generatedAt: new Date().toISOString(),
  });
  await saveRunManifest(
    path.join(repoRoot, "config", "ryvo-protocol-demo-last-run.json"),
    {
      runId,
      network,
      rpcEndpoint: provider.connection.rpcEndpoint,
      programId: program.programId.toString(),
      deployer: deployer.publicKey.toString(),
      token: {
        id: options.tokenId,
        symbol: options.tokenSymbol,
        mint: options.tokenMint.toString(),
        decimals: readiness.decimals,
        vaultTokenAccount: readiness.vaultTokenAccount.toString(),
      },
      feeRecipient: readiness.feeRecipient.toString(),
      messageDomain: readiness.messageDomain.toString("hex"),
      reusedFromManifest: reusableManifestPath,
      settings: {
        skipFunding: options.skipFunding,
        skipParticipantInit: options.skipParticipantInit,
        skipDeposits: options.skipDeposits,
        skipMaxChannels: options.skipMaxChannels,
        walletManifestPath: walletManifestPath,
        blsSearchResultsLogPath: multilateralSearchContext.resultsLogPath,
        blsInternalBalanceTarget: options.blsInternalBalanceTarget,
        blsRandomSeed: options.blsRandomSeed,
        blsRandomMinAmount: options.blsRandomMinAmount,
        blsRandomMaxAmount: options.blsRandomMaxAmount,
        blsMaxDenseChannels: options.blsMaxDenseChannels,
        blsComputeUnitLimit: options.blsComputeUnitLimit,
        singleCommitmentCount: options.singleCommitmentCount,
        singleCommitmentAmount: options.singleCommitmentAmount,
        batchCommitmentBatchCount: options.batchCommitmentBatchCount,
        batchCommitmentBatchSize: options.batchCommitmentBatchSize,
        batchCommitmentAmount: options.batchCommitmentAmount,
        unilateralPayeeACommitmentCount:
          options.unilateralPayeeACommitmentCount,
        unilateralPayeeBCommitmentCount:
          options.unilateralPayeeBCommitmentCount,
        unilateralAmountPerCommitment: options.unilateralAmountPerCommitment,
        unilateralLockAmount: options.unilateralLockAmount,
        bilateralForwardCommitmentCount:
          options.bilateralForwardCommitmentCount,
        bilateralReverseCommitmentCount:
          options.bilateralReverseCommitmentCount,
        bilateralAmountPerCommitment: options.bilateralAmountPerCommitment,
        multilateralEdgeCommitmentCount:
          options.multilateralEdgeCommitmentCount,
        multilateralAmountPerCommitment:
          options.multilateralAmountPerCommitment,
      },
      wallets: wallets.map((wallet) => ({
        name: wallet.name,
        publicKey: wallet.keypair.publicKey.toString(),
        participantId: wallet.participantId,
        participantPda: wallet.participantPda.toString(),
        tokenAccount: wallet.tokenAccount.toString(),
        secretPath: wallet.secretPath,
      })),
      benchmarkScenarios,
      scenarios: scenarioSignatures,
      explorer: Object.fromEntries(
        Object.entries(scenarioSignatures).map(([name, signature]) => [
          name,
          explorerUrl(signature),
        ])
      ),
      generatedAt: new Date().toISOString(),
    }
  );

  logSection("Artifacts");
  logStep(`Wallet directory: ${walletDir}`);
  logStep(`Reusable wallet manifest: ${walletManifestPath}`);
  logStep(
    `BLS search results log: ${multilateralSearchContext.resultsLogPath}`
  );
  logStep(`Run manifest: ${manifestPath}`);
  logStep(
    `Last-run manifest: ${path.join(
      repoRoot,
      "config",
      "ryvo-protocol-demo-last-run.json"
    )}`
  );
}

main().catch((error) => {
  console.error("");
  console.error("[demo] Ryvo Network demo failed");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
