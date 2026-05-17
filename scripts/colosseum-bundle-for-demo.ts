#!/usr/bin/env ts-node
/**
 * colosseum-bundle-for-demo.ts
 *
 * Reads the channels-setup manifest plus all of the colosseum keypair files
 * (Ed25519 wallet secrets and BLS keypair JSONs) and emits a single
 * self-contained JSON bundle that the `/demo` page in `ryvo-app/packages/web`
 * imports server-side.
 *
 * The bundle is intentionally devnet-only and contains keys for wallets that
 * never hold real value. It IS still secret material — Next.js API routes load
 * it from `src/lib/demo/data/colosseum-bundle.json` and never expose it to the
 * browser.
 */

import * as fs from "fs";
import * as path from "path";

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
  blsKeypairPath: string;
  blsPubkeyCompressedB64: string;
  channelBucket?: string;
  channelBucketId?: number;
  ownerUsdcAta?: string;
  depositedUsdc?: string;
  lockedUsdc?: string;
};

type ChannelsManifest = {
  generatedAt: string;
  network: string;
  rpcUrl: string;
  program: {
    ryvoProtocol: string;
    globalConfig: string;
    tokenRegistry: string;
    messageDomainHex: string;
    chainId: number;
  };
  token: {
    tokenId: number;
    mint: string;
    symbol: string;
    decimals: number;
    vaultTokenAccount: string;
  };
  blsKeysDirectory: string;
  targets: {
    depositPerAgentBaseUnits: string;
    lockPerAgentBaseUnits: string;
  };
  lookupTable: { address: string } | null;
  merchant: WalletEntry;
  agents: WalletEntry[];
};

type CliOptions = {
  manifestPath: string;
  outputPath: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    manifestPath: "deployments/devnet/colosseum-channels-setup.json",
    outputPath: "deployments/devnet/colosseum-bundle.json",
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
      case "manifest":
        if (value) options.manifestPath = value;
        break;
      case "out":
      case "output":
        if (value) options.outputPath = value;
        break;
      default:
        break;
    }
  }

  return options;
}

function loadEd25519Secret(filePath: string): Buffer {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as number[];
  return Buffer.from(raw);
}

function loadBlsSecret(filePath: string): {
  secretScalarHex: string;
  publicKeyCompressedHex: string;
} {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function bundleEntry(entry: WalletEntry, repoRoot: string) {
  const ed25519Path = path.resolve(repoRoot, entry.keypairPath);
  const blsPath = path.resolve(repoRoot, entry.blsKeypairPath);

  const ed25519Secret = loadEd25519Secret(ed25519Path);
  const bls = loadBlsSecret(blsPath);

  return {
    label: entry.label,
    role: entry.role,
    publicKey: entry.publicKey,
    participantId: entry.participantId,
    participantBucket: entry.participantBucket,
    participantBucketId: entry.participantBucketId,
    ownerIndexBucket: entry.ownerIndexBucket,
    ownerIndexBucketId: entry.ownerIndexBucketId,
    ed25519SecretKeyBase64: ed25519Secret.toString("base64"),
    blsSecretScalarHex: bls.secretScalarHex,
    blsPublicKeyCompressedBase64: Buffer.from(
      bls.publicKeyCompressedHex,
      "hex"
    ).toString("base64"),
    channelBucket: entry.channelBucket,
    channelBucketId: entry.channelBucketId,
    ownerUsdcAta: entry.ownerUsdcAta,
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const manifestPath = path.resolve(repoRoot, options.manifestPath);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`channels manifest not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8")
  ) as ChannelsManifest;

  if (!manifest.lookupTable) {
    throw new Error(
      `manifest is missing lookupTable.address — re-run colosseum-channels-setup.ts without --skip-alt`
    );
  }

  const bundle = {
    bundleVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceManifestGeneratedAt: manifest.generatedAt,
    network: manifest.network,
    program: manifest.program,
    token: manifest.token,
    targets: manifest.targets,
    lookupTable: manifest.lookupTable,
    merchant: bundleEntry(manifest.merchant, repoRoot),
    agents: manifest.agents.map((agent) => bundleEntry(agent, repoRoot)),
    notes: [
      "DEVNET DEMO BUNDLE — for the /demo page on the landing site only.",
      "All keys are bound to wallets that hold zero mainnet value.",
      "Loaded server-side by Next.js API routes; never shipped to browsers.",
      "Regenerate via `npx ts-node scripts/colosseum-bundle-for-demo.ts --out=<path>`.",
    ],
  };

  const outputPath = path.resolve(repoRoot, options.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(
    `Wrote demo bundle (${bundle.agents.length} agents + 1 merchant) to ${outputPath}`
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
