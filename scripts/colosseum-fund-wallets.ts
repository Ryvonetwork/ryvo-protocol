#!/usr/bin/env ts-node

import * as anchor from "@coral-xyz/anchor";
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
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const { loadProjectRpcEnv, resolveProjectRpcUrl } =
  require("./lib/rpc-env.cjs") as {
    loadProjectRpcEnv: (repoRoot?: string) => void;
    resolveProjectRpcUrl: (network?: string) => string;
  };

loadProjectRpcEnv(process.cwd());

type Network = "devnet" | "mainnet" | "localnet" | "testnet";

type CliOptions = {
  network: Network;
  manifestPath: string;
  outputPath: string;
  tokenId: number;
  tokenAmount: bigint;
  lamports: number;
};

type WalletEntry = {
  label: string;
  role: "merchant" | "participant";
  keypairPath: string;
  publicKey: string;
  participantId: number;
};

const DEFAULT_MANIFEST = "deployments/devnet/colosseum-basic-setup.json";
const DEFAULT_OUTPUT = "deployments/devnet/colosseum-funding.json";
const DEFAULT_TOKEN_ID = 1;
const DEFAULT_TOKEN_AMOUNT = 2_000_000n;
const DEFAULT_LAMPORTS = Math.round(0.1 * LAMPORTS_PER_SOL);

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    network: "devnet",
    manifestPath: DEFAULT_MANIFEST,
    outputPath: DEFAULT_OUTPUT,
    tokenId: DEFAULT_TOKEN_ID,
    tokenAmount: DEFAULT_TOKEN_AMOUNT,
    lamports: DEFAULT_LAMPORTS,
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
      case "manifest":
        if (value) options.manifestPath = value;
        break;
      case "output":
        if (value) options.outputPath = value;
        break;
      case "token-id":
        if (value) options.tokenId = Number.parseInt(value, 10);
        break;
      case "token-amount":
        if (value) options.tokenAmount = BigInt(value);
        break;
      case "lamports":
        if (value) options.lamports = Number.parseInt(value, 10);
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

async function tokenAccountExists(
  connection: anchor.web3.Connection,
  address: PublicKey
): Promise<boolean> {
  return (await connection.getAccountInfo(address, "confirmed")) !== null;
}

async function ensureAtaInstruction(
  connection: anchor.web3.Connection,
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey
) {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  if (await tokenAccountExists(connection, ata)) {
    return { ata, instruction: null };
  }
  return {
    ata,
    instruction: createAssociatedTokenAccountInstruction(
      payer,
      ata,
      owner,
      mint
    ),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = loadProvider(options.network);
  const deployer = (provider.wallet as any).payer as Keypair;
  const manifestPath = path.resolve(options.manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const token = (manifest.tokens ?? []).find(
    (entry: any) => Number(entry.tokenId) === options.tokenId
  );
  if (!token) {
    throw new Error(`Token ${options.tokenId} not found in ${manifestPath}`);
  }
  const mint = new PublicKey(token.mint);
  const decimals = Number(token.decimals ?? 6);
  const allWallets: WalletEntry[] = [
    manifest.wallets.merchant,
    ...(manifest.wallets.participants ?? []),
  ];
  const deployerAta = getAssociatedTokenAddressSync(mint, deployer.publicKey);
  const deployerToken = await getAccount(provider.connection, deployerAta);

  const results: any[] = [];
  let requiredTokenTopup = 0n;
  for (const wallet of allWallets) {
    const owner = new PublicKey(wallet.publicKey);
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const current = (await tokenAccountExists(provider.connection, ata))
      ? (await getAccount(provider.connection, ata)).amount
      : 0n;
    if (current < options.tokenAmount) {
      requiredTokenTopup += options.tokenAmount - current;
    }
  }
  if (deployerToken.amount < requiredTokenTopup) {
    throw new Error(
      `Deployer token ATA has ${deployerToken.amount}; need ${requiredTokenTopup}`
    );
  }

  for (const wallet of allWallets) {
    const owner = new PublicKey(wallet.publicKey);
    const currentLamports = await provider.connection.getBalance(
      owner,
      "confirmed"
    );
    const tokenAccount = await ensureAtaInstruction(
      provider.connection,
      deployer.publicKey,
      owner,
      mint
    );
    const currentToken = (await tokenAccountExists(
      provider.connection,
      tokenAccount.ata
    ))
      ? (await getAccount(provider.connection, tokenAccount.ata)).amount
      : 0n;

    const transaction = new Transaction();
    if (currentLamports < options.lamports) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: deployer.publicKey,
          toPubkey: owner,
          lamports: options.lamports - currentLamports,
        })
      );
    }
    if (tokenAccount.instruction) {
      transaction.add(tokenAccount.instruction);
    }
    if (currentToken < options.tokenAmount) {
      transaction.add(
        createTransferCheckedInstruction(
          deployerAta,
          mint,
          tokenAccount.ata,
          deployer.publicKey,
          options.tokenAmount - currentToken,
          decimals,
          [],
          TOKEN_PROGRAM_ID
        )
      );
    }

    let signature: string | null = null;
    if (transaction.instructions.length > 0) {
      signature = await sendAndConfirmTransaction(
        provider.connection,
        transaction,
        [deployer],
        { commitment: "confirmed" }
      );
    }
    results.push({
      label: wallet.label,
      role: wallet.role,
      publicKey: wallet.publicKey,
      participantId: wallet.participantId,
      targetLamports: options.lamports,
      targetTokenAmount: options.tokenAmount.toString(),
      tokenAccount: tokenAccount.ata.toString(),
      signature,
    });
    console.log(
      `${wallet.label}: SOL ${currentLamports}->${Math.max(
        currentLamports,
        options.lamports
      )}, token target ${options.tokenAmount.toString()}`
    );
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
        sourceManifest: relPath(manifestPath),
        token: {
          tokenId: options.tokenId,
          mint: mint.toString(),
          decimals,
          targetAmount: options.tokenAmount.toString(),
        },
        targetLamports: options.lamports,
        funder: deployer.publicKey.toString(),
        wallets: results,
      },
      null,
      2
    )}\n`
  );
  console.log(`Wrote funding manifest to ${relPath(outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
