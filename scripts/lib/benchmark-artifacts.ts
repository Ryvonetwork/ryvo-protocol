export const X402_SOLANA_COST_PER_TX_USD = 0.00044;

export type BenchmarkSavings = {
  baselineModel: string;
  baselineTransactionCount: number;
  settlementTransactionCount: number;
  savedTransactions: number;
  reductionPercent: number;
  compressionRatio: number;
  estimatedBaselineCostUsd: number;
  estimatedAgonCostUsd: number;
  estimatedSavingsUsd: number;
};

export type BenchmarkShape = {
  participantCount: number;
  channelCount: number;
};

export type DemoBenchmarkScenario = {
  id: string;
  title: string;
  settlementMode:
    | "latest-commitment"
    | "bundle"
    | "single-payer-clearing"
    | "bilateral-clearing"
    | "multilateral-clearing";
  participantCount: number;
  channelCount: number;
  underlyingPaymentCount: number;
  grossValueRaw: string;
  grossValueFormatted: string;
  settlementTransactionCount: number;
  signatures: string[];
  explorerLinks: string[];
  serializedTransactionBytes: number[];
  totalSerializedTransactionBytes: number;
  signedMessageBytes: number;
  signatureCount: number;
  participantBalanceWrites: number;
  channelLaneWrites: number;
  baselineModel: string;
  savings: BenchmarkSavings;
  notes: string[];
  requestedShape?: BenchmarkShape;
  achievedShape?: BenchmarkShape;
};

export type SyntheticBenchmarkSnapshot = {
  schemaVersion: 1;
  family: "synthetic-capacity";
  generatedAt: string;
  commit: string | null;
  cluster: "synthetic";
  programId: string;
  packetDataSize: number;
  unilateral: {
    legacyMessageBytes: number;
    currentTypicalMessageBytes: number;
    currentConservativeMessageBytes: number;
    legacySerializedTxBytes: number;
    currentTypicalSerializedTxBytes: number;
    currentConservativeSerializedTxBytes: number;
    savingsVsLegacyBytes: number;
  };
  bundle: {
    currentTypicalLargestEntryCount: number;
    currentTypicalSerializedTxBytes: number;
    currentTypicalSignedMessageBytes: number;
    currentConservativeLargestEntryCount: number;
    currentConservativeSerializedTxBytes: number;
    currentConservativeSignedMessageBytes: number;
  };
  clearing: {
    blsV0AltCycle: {
      participantCount: number;
      channelCount: number;
      serializedTxBytes: number;
      messageBytes: number;
      authEnvelopeBytes: number;
      remainingBytes: number;
      participantBucketCount: number;
      channelBucketCount: number;
      dynamicWritableAccountCount: number;
    };
    blsV0AltOverall: {
      participantCount: number;
      channelCount: number;
      serializedTxBytes: number;
      messageBytes: number;
      authEnvelopeBytes: number;
      remainingBytes: number;
      participantBucketCount: number;
      channelBucketCount: number;
      dynamicWritableAccountCount: number;
    };
  };
};

export type LiveBenchmarkSnapshot = {
  schemaVersion: 1;
  family: "live-devnet-demo";
  generatedAt: string;
  commit: string | null;
  cluster: string;
  runId: string;
  programId: string;
  messageDomain: string;
  token: {
    id: number;
    symbol: string;
    mint: string;
    decimals: number;
  };
  scenarios: DemoBenchmarkScenario[];
};

export function computeSavingsMetrics(params: {
  baselineModel?: string;
  underlyingPaymentCount: number;
  settlementTransactionCount: number;
  perTransactionCostUsd?: number;
}): BenchmarkSavings {
  const baselineModel =
    params.baselineModel ?? "Exact-payment x402 onchain baseline";
  const perTransactionCostUsd =
    params.perTransactionCostUsd ?? X402_SOLANA_COST_PER_TX_USD;
  const baselineTransactionCount = params.underlyingPaymentCount;
  const settlementTransactionCount = params.settlementTransactionCount;
  const savedTransactions =
    baselineTransactionCount - settlementTransactionCount;
  const reductionPercent =
    baselineTransactionCount === 0
      ? 0
      : (savedTransactions / baselineTransactionCount) * 100;
  const compressionRatio =
    settlementTransactionCount === 0
      ? 0
      : baselineTransactionCount / settlementTransactionCount;
  const estimatedBaselineCostUsd =
    baselineTransactionCount * perTransactionCostUsd;
  const estimatedAgonCostUsd =
    settlementTransactionCount * perTransactionCostUsd;

  return {
    baselineModel,
    baselineTransactionCount,
    settlementTransactionCount,
    savedTransactions,
    reductionPercent,
    compressionRatio,
    estimatedBaselineCostUsd,
    estimatedAgonCostUsd,
    estimatedSavingsUsd: estimatedBaselineCostUsd - estimatedAgonCostUsd,
  };
}

export function explorerUrl(signature: string, cluster = "devnet"): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export function renderMarkdownTable(
  headers: string[],
  rows: Array<Array<string | number>>
): string {
  const headerRow = `| ${headers.join(" | ")} |`;
  const dividerRow = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyRows = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerRow, dividerRow, ...bodyRows].join("\n");
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}
