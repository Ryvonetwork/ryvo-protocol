#!/usr/bin/env ts-node

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { PublicKey } from "@solana/web3.js";

import {
  BenchmarkSavings,
  DemoBenchmarkScenario,
  LiveBenchmarkSnapshot,
  SyntheticBenchmarkSnapshot,
  computeSavingsMetrics,
  explorerUrl,
  formatRatio,
  formatUsd,
  renderMarkdownTable,
} from "./lib/benchmark-artifacts";
import {
  LEGACY_PACKET_DATA_SIZE,
  summarizeClearingRoundCapacity,
} from "./lib/clearing-round-capacity";
import {
  CURRENT_COMMITMENT_V4_CONSERVATIVE_MESSAGE_BYTES,
  CURRENT_COMMITMENT_V4_TYPICAL_MESSAGE_BYTES,
  LEGACY_COMMITMENT_V2_MESSAGE_BYTES,
  findLargestBundleSettlementEntryCount,
  measureIndividualSettlementCapacity,
} from "./lib/unilateral-settlement-capacity";

type DeploymentManifest = {
  programId: string;
  network: string;
  messageDomain: string;
};

type DemoRunManifest = {
  runId: string;
  network: string;
  programId: string;
  generatedAt: string;
  token: {
    id: number;
    symbol: string;
    mint: string;
    decimals: number;
  };
  messageDomain?: string;
  benchmarkScenarios?: DemoBenchmarkScenario[];
};

type CliOptions = {
  docsOnly: boolean;
  manifestPath: string;
  deploymentPath: string;
  outputDir: string;
  docsRoot: string;
};

function parseArgs(argv: string[]): CliOptions {
  const repoRoot = path.resolve(__dirname, "..");
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const trimmed = value.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex >= 0) {
      args.set(trimmed.slice(0, eqIndex), trimmed.slice(eqIndex + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(trimmed, next);
      index += 1;
    } else {
      args.set(trimmed, "true");
    }
  }

  return {
    docsOnly: args.has("docs-only"),
    manifestPath:
      args.get("manifest") ??
      path.join(repoRoot, "config", "ryvo-protocol-demo-last-run.json"),
    deploymentPath:
      args.get("deployment") ??
      path.join(repoRoot, "config", "devnet-deployment.json"),
    outputDir: args.get("output-dir") ?? path.join(repoRoot, "benchmarks"),
    docsRoot:
      args.get("docs-root") ??
      process.env.RYVO_DOCS_ROOT ??
      "/mnt/c/ryvo/ryvo/docs",
  };
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeTextFile(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${value.trimEnd()}\n`, "utf8");
}

function tryReadCommit(repoRoot: string): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function renderSavingsCell(savings: BenchmarkSavings): string {
  return `${formatRatio(
    savings.compressionRatio
  )}x / ${savings.savedTransactions.toLocaleString("en-US")} tx saved`;
}

function createLiveSnapshot(
  repoRoot: string,
  deployment: DeploymentManifest,
  manifest: DemoRunManifest
): LiveBenchmarkSnapshot {
  if (!Array.isArray(manifest.benchmarkScenarios)) {
    throw new Error(
      `Demo manifest ${path.join(
        repoRoot,
        "config",
        "ryvo-protocol-demo-last-run.json"
      )} does not include benchmarkScenarios yet. Re-run the upgraded demo first.`
    );
  }

  return {
    schemaVersion: 1,
    family: "live-devnet-demo",
    generatedAt: manifest.generatedAt,
    commit: tryReadCommit(repoRoot),
    cluster: manifest.network,
    runId: manifest.runId,
    programId: manifest.programId,
    messageDomain: manifest.messageDomain ?? deployment.messageDomain,
    token: manifest.token,
    scenarios: manifest.benchmarkScenarios,
  };
}

function createSyntheticSnapshot(
  repoRoot: string,
  deployment: DeploymentManifest
): SyntheticBenchmarkSnapshot {
  const programId = new PublicKey(deployment.programId);
  const legacyIndividual = measureIndividualSettlementCapacity({
    programId,
    messageBytes: LEGACY_COMMITMENT_V2_MESSAGE_BYTES,
  });
  const currentTypicalIndividual = measureIndividualSettlementCapacity({
    programId,
    messageBytes: CURRENT_COMMITMENT_V4_TYPICAL_MESSAGE_BYTES,
  });
  const currentConservativeIndividual = measureIndividualSettlementCapacity({
    programId,
    messageBytes: CURRENT_COMMITMENT_V4_CONSERVATIVE_MESSAGE_BYTES,
  });
  const currentTypicalBundle = findLargestBundleSettlementEntryCount({
    programId,
    messageBytes: CURRENT_COMMITMENT_V4_TYPICAL_MESSAGE_BYTES,
  });
  const currentConservativeBundle = findLargestBundleSettlementEntryCount({
    programId,
    messageBytes: CURRENT_COMMITMENT_V4_CONSERVATIVE_MESSAGE_BYTES,
  });
  const clearing = summarizeClearingRoundCapacity(programId);

  return {
    schemaVersion: 1,
    family: "synthetic-capacity",
    generatedAt: new Date().toISOString(),
    commit: tryReadCommit(repoRoot),
    cluster: "synthetic",
    programId: deployment.programId,
    packetDataSize: LEGACY_PACKET_DATA_SIZE,
    unilateral: {
      legacyMessageBytes: LEGACY_COMMITMENT_V2_MESSAGE_BYTES,
      currentTypicalMessageBytes: CURRENT_COMMITMENT_V4_TYPICAL_MESSAGE_BYTES,
      currentConservativeMessageBytes:
        CURRENT_COMMITMENT_V4_CONSERVATIVE_MESSAGE_BYTES,
      legacySerializedTxBytes: legacyIndividual.serializedTxBytes,
      currentTypicalSerializedTxBytes:
        currentTypicalIndividual.serializedTxBytes,
      currentConservativeSerializedTxBytes:
        currentConservativeIndividual.serializedTxBytes,
      savingsVsLegacyBytes:
        legacyIndividual.serializedTxBytes -
        currentTypicalIndividual.serializedTxBytes,
    },
    bundle: {
      currentTypicalLargestEntryCount: currentTypicalBundle.entryCount,
      currentTypicalSerializedTxBytes: currentTypicalBundle.serializedTxBytes,
      currentTypicalSignedMessageBytes:
        currentTypicalBundle.entryCount * currentTypicalBundle.messageBytes,
      currentConservativeLargestEntryCount:
        currentConservativeBundle.entryCount,
      currentConservativeSerializedTxBytes:
        currentConservativeBundle.serializedTxBytes,
      currentConservativeSignedMessageBytes:
        currentConservativeBundle.entryCount *
        currentConservativeBundle.messageBytes,
    },
    clearing: {
      blsV0AltCycle: {
        participantCount: clearing.blsV0AltCycle.participantCount,
        channelCount: clearing.blsV0AltCycle.channelCount,
        serializedTxBytes: clearing.blsV0AltCycle.serializedTxBytes,
        messageBytes: clearing.blsV0AltCycle.messageBytes,
        authEnvelopeBytes: clearing.blsV0AltCycle.authEnvelopeBytes,
        remainingBytes: clearing.blsV0AltCycle.remainingBytes,
        participantBucketCount: clearing.blsV0AltCycle.participantBucketCount,
        channelBucketCount: clearing.blsV0AltCycle.channelBucketCount,
        dynamicWritableAccountCount:
          clearing.blsV0AltCycle.dynamicWritableAccountCount,
      },
      blsV0AltOverall: {
        participantCount: clearing.blsV0AltOverall.participantCount,
        channelCount: clearing.blsV0AltOverall.channelCount,
        serializedTxBytes: clearing.blsV0AltOverall.serializedTxBytes,
        messageBytes: clearing.blsV0AltOverall.messageBytes,
        authEnvelopeBytes: clearing.blsV0AltOverall.authEnvelopeBytes,
        remainingBytes: clearing.blsV0AltOverall.remainingBytes,
        participantBucketCount: clearing.blsV0AltOverall.participantBucketCount,
        channelBucketCount: clearing.blsV0AltOverall.channelBucketCount,
        dynamicWritableAccountCount:
          clearing.blsV0AltOverall.dynamicWritableAccountCount,
      },
    },
  };
}

function renderLiveBenchmarkPage(snapshot: LiveBenchmarkSnapshot): string {
  const rows = snapshot.scenarios.map((scenario) => [
    scenario.title,
    scenario.participantCount,
    scenario.channelCount,
    scenario.underlyingPaymentCount.toLocaleString("en-US"),
    scenario.settlementTransactionCount,
    scenario.totalSerializedTransactionBytes,
    scenario.signedMessageBytes,
    scenario.signatureCount,
    renderSavingsCell(scenario.savings),
  ]);

  const explorerRows = snapshot.scenarios.map((scenario) => [
    scenario.title,
    scenario.explorerLinks
      .map((url, index) => `[tx ${index + 1}](${url})`)
      .join(", "),
  ]);

  return `---
title: "Generated Live Devnet Benchmarks"
description: "Generated from the latest protocol-only Ryvo devnet demo run."
---

The table below is generated from the latest committed live demo snapshot for program \`${
    snapshot.programId
  }\` on \`${snapshot.cluster}\`.

${renderMarkdownTable(
  [
    "Scenario",
    "Participants",
    "Channels",
    "Underlying Payments",
    "Settlement Txs",
    "Serialized Tx Bytes",
    "Signed Message Bytes",
    "Signature Count",
    "Compression",
  ],
  rows
)}

## Explorer Links

${renderMarkdownTable(["Scenario", "Explorer"], explorerRows)}
`;
}

function renderSyntheticBenchmarkPage(
  snapshot: SyntheticBenchmarkSnapshot
): string {
  return `---
title: "Generated Synthetic Capacity Benchmarks"
description: "Deterministic capacity snapshots for Ryvo bucketed BLS settlement paths."
---

These tables are generated from the deterministic sizing scripts at commit \`${
    snapshot.commit ?? "unknown"
  }\`.

## Unilateral Commitments

${renderMarkdownTable(
  ["Shape", "Message Bytes", "Serialized Tx Bytes", "Headroom vs Packet"],
  [
    [
      "Legacy unilateral commitment",
      snapshot.unilateral.legacyMessageBytes,
      snapshot.unilateral.legacySerializedTxBytes,
      snapshot.packetDataSize - snapshot.unilateral.legacySerializedTxBytes,
    ],
    [
      "Current v4 typical unilateral commitment",
      snapshot.unilateral.currentTypicalMessageBytes,
      snapshot.unilateral.currentTypicalSerializedTxBytes,
      snapshot.packetDataSize -
        snapshot.unilateral.currentTypicalSerializedTxBytes,
    ],
    [
      "Current v4 conservative unilateral commitment",
      snapshot.unilateral.currentConservativeMessageBytes,
      snapshot.unilateral.currentConservativeSerializedTxBytes,
      snapshot.packetDataSize -
        snapshot.unilateral.currentConservativeSerializedTxBytes,
    ],
  ]
)}

## Bundle Settlement

${renderMarkdownTable(
  [
    "Shape",
    "Largest Entry Count",
    "Serialized Tx Bytes",
    "Signed Message Bytes",
  ],
  [
    [
      "Current v4 typical bundle",
      snapshot.bundle.currentTypicalLargestEntryCount,
      snapshot.bundle.currentTypicalSerializedTxBytes,
      snapshot.bundle.currentTypicalSignedMessageBytes,
    ],
    [
      "Current v4 conservative bundle",
      snapshot.bundle.currentConservativeLargestEntryCount,
      snapshot.bundle.currentConservativeSerializedTxBytes,
      snapshot.bundle.currentConservativeSignedMessageBytes,
    ],
  ]
)}

## Cooperative Clearing

${renderMarkdownTable(
  [
    "Mode",
    "Participants",
    "Channels",
    "Bucket Locks",
    "Serialized Tx Bytes",
    "Message Bytes",
    "Auth Envelope Bytes",
    "Remaining Bytes",
  ],
  [
    [
      "BLS v0 + ALT balanced round",
      snapshot.clearing.blsV0AltCycle.participantCount,
      snapshot.clearing.blsV0AltCycle.channelCount,
      `${snapshot.clearing.blsV0AltCycle.dynamicWritableAccountCount} (${snapshot.clearing.blsV0AltCycle.participantBucketCount} PB + ${snapshot.clearing.blsV0AltCycle.channelBucketCount} CB)`,
      snapshot.clearing.blsV0AltCycle.serializedTxBytes,
      snapshot.clearing.blsV0AltCycle.messageBytes,
      snapshot.clearing.blsV0AltCycle.authEnvelopeBytes,
      snapshot.clearing.blsV0AltCycle.remainingBytes,
    ],
    [
      "BLS v0 + ALT overall fit",
      snapshot.clearing.blsV0AltOverall.participantCount,
      snapshot.clearing.blsV0AltOverall.channelCount,
      `${snapshot.clearing.blsV0AltOverall.dynamicWritableAccountCount} (${snapshot.clearing.blsV0AltOverall.participantBucketCount} PB + ${snapshot.clearing.blsV0AltOverall.channelBucketCount} CB)`,
      snapshot.clearing.blsV0AltOverall.serializedTxBytes,
      snapshot.clearing.blsV0AltOverall.messageBytes,
      snapshot.clearing.blsV0AltOverall.authEnvelopeBytes,
      snapshot.clearing.blsV0AltOverall.remainingBytes,
    ],
  ]
)}
`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..");
  const deployment = readJsonFile<DeploymentManifest>(options.deploymentPath);

  let liveSnapshot: LiveBenchmarkSnapshot;
  let syntheticSnapshot: SyntheticBenchmarkSnapshot;

  if (options.docsOnly) {
    liveSnapshot = readJsonFile<LiveBenchmarkSnapshot>(
      path.join(options.outputDir, "live", "latest-devnet-demo.json")
    );
    syntheticSnapshot = readJsonFile<SyntheticBenchmarkSnapshot>(
      path.join(options.outputDir, "synthetic", "latest-capacity.json")
    );
  } else {
    const manifest = readJsonFile<DemoRunManifest>(options.manifestPath);
    liveSnapshot = createLiveSnapshot(repoRoot, deployment, manifest);
    syntheticSnapshot = createSyntheticSnapshot(repoRoot, deployment);

    const liveDir = path.join(options.outputDir, "live");
    const syntheticDir = path.join(options.outputDir, "synthetic");
    writeJsonFile(path.join(liveDir, "latest-devnet-demo.json"), liveSnapshot);
    writeJsonFile(
      path.join(liveDir, `devnet-demo-${manifest.runId}.json`),
      liveSnapshot
    );
    writeJsonFile(
      path.join(syntheticDir, "latest-capacity.json"),
      syntheticSnapshot
    );
  }

  writeTextFile(
    path.join(options.docsRoot, "benchmarks", "generated-live-devnet.mdx"),
    renderLiveBenchmarkPage(liveSnapshot)
  );
  writeTextFile(
    path.join(
      options.docsRoot,
      "benchmarks",
      "generated-synthetic-capacity.mdx"
    ),
    renderSyntheticBenchmarkPage(syntheticSnapshot)
  );
}

main();
