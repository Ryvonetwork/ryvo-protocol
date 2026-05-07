#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const anchor = require("@coral-xyz/anchor");
const { Program } = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount } = require("@solana/spl-token");
const { loadProjectRpcEnv, resolveProjectRpcUrl } = require("./lib/rpc-env.cjs");

loadProjectRpcEnv(process.cwd());

const GLOBAL_CONFIG_SEED = "global-config";
const TOKEN_REGISTRY_SEED = "token-registry";
const PARTICIPANT_BUCKET_SEED = "participant-bucket-v2";
const OWNER_INDEX_BUCKET_SEED = "owner-index-bucket-v2";
const VAULT_TOKEN_ACCOUNT_SEED = "vault-token-account";
const PARTICIPANT_BUCKET_SLOT_COUNT = 9;
const OWNER_INDEX_BUCKET_COUNT = 1024;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = "true";
    }
  }

  return { command, options };
}

function createWallet(payer) {
  return {
    payer,
    publicKey: payer.publicKey,
    signTransaction: async (transaction) => {
      if ("version" in transaction) {
        transaction.sign([payer]);
      } else {
        transaction.partialSign(payer);
      }
      return transaction;
    },
    signAllTransactions: async (transactions) =>
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

function loadProvider() {
  const rpcEndpoint =
    process.env.ANCHOR_PROVIDER_URL ?? resolveProjectRpcUrl("devnet");
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(process.cwd(), "keys", "devnet-deployer.json");

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

function loadProgram(provider) {
  const idlPath = path.join(__dirname, "..", "target", "idl", "ryvo_protocol.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  return new Program(idl, provider);
}

function findGlobalConfigPda(programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_CONFIG_SEED)],
    programId
  )[0];
}

function findTokenRegistryPda(programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_REGISTRY_SEED)],
    programId
  )[0];
}

function u32Le(value) {
  return new anchor.BN(value).toArrayLike(Buffer, "le", 4);
}

function participantBucketIdForParticipantId(participantId) {
  return Math.floor(participantId / PARTICIPANT_BUCKET_SLOT_COUNT);
}

function participantBucketSlotIndex(participantId) {
  return participantId % PARTICIPANT_BUCKET_SLOT_COUNT;
}

function ownerIndexBucketIdForOwner(owner) {
  const digest = crypto.createHash("sha256").update(owner.toBuffer()).digest();
  return digest.readUInt32LE(0) % OWNER_INDEX_BUCKET_COUNT;
}

function findParticipantBucketPdaById(programId, participantId) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(PARTICIPANT_BUCKET_SEED),
      u32Le(participantBucketIdForParticipantId(participantId)),
    ],
    programId
  )[0];
}

function findOwnerIndexBucketPda(programId, owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(OWNER_INDEX_BUCKET_SEED), u32Le(ownerIndexBucketIdForOwner(owner))],
    programId
  )[0];
}

function readRawU64(data, offset) {
  return new anchor.BN(data.subarray(offset, offset + 8), "le");
}

function readRawI64(data, offset) {
  return new anchor.BN(data.readBigInt64LE(offset).toString());
}

function readRawPubkey(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32));
}

async function fetchRawParticipantBucketSlot(provider, participantPda, participantId) {
  const account = await provider.connection.getAccountInfo(participantPda);
  if (!account) {
    throw new Error(`Participant bucket ${participantPda.toString()} was not found`);
  }
  const data = account.data;
  const slotOffset = 13 + participantBucketSlotIndex(participantId) * 1079;
  const initialized = data[slotOffset] !== 0;
  const actualParticipantId = data.readUInt32LE(slotOffset + 33);
  if (!initialized || actualParticipantId !== participantId) {
    throw new Error(`Participant bucket slot ${participantId} is not initialized`);
  }
  const tokenBalances = Array.from({ length: 16 }, (_, index) => {
    const offset = slotOffset + 135 + index * 59;
    return {
      initialized: data[offset] !== 0,
      tokenId: data.readUInt16LE(offset + 1),
      availableBalance: readRawU64(data, offset + 3),
      withdrawingBalance: readRawU64(data, offset + 11),
      withdrawalUnlockAt: readRawI64(data, offset + 19),
      withdrawalDestination: readRawPubkey(data, offset + 27),
    };
  });
  return {
    initialized,
    owner: readRawPubkey(data, slotOffset + 1),
    participantId: actualParticipantId,
    inboundChannelPolicy: data[slotOffset + 37],
    blsSchemeVersion: data[slotOffset + 38],
    blsPubkeyCompressed: Array.from(data.subarray(slotOffset + 39, slotOffset + 135)),
    tokenBalances,
  };
}

async function fetchParticipantForOwner(program, owner) {
  const ownerIndexBucketPda = findOwnerIndexBucketPda(program.programId, owner);
  let ownerIndexBucket;
  try {
    ownerIndexBucket = await program.account.ownerIndexBucket.fetch(ownerIndexBucketPda);
  } catch {
    return null;
  }

  const ownerSlot = ownerIndexBucket.slots.find(
    (slot) => slot.initialized && slot.owner.toString() === owner.toString()
  );
  if (!ownerSlot) {
    return null;
  }

  const participantId = Number(ownerSlot.participantId);
  const participantPda = findParticipantBucketPdaById(program.programId, participantId);
  const participant = await fetchRawParticipantBucketSlot(
    program.provider,
    participantPda,
    participantId
  );

  return {
    participantPda,
    ownerIndexBucketPda,
    participant,
  };
}

function findVaultTokenAccountPda(programId, tokenId) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_TOKEN_ACCOUNT_SEED),
      new anchor.BN(tokenId).toArrayLike(Buffer, "le", 2),
    ],
    programId
  )[0];
}

function symbolBytes(symbol) {
  const bytes = Buffer.alloc(8);
  Buffer.from(symbol, "ascii").copy(bytes, 0, 0, 8);
  return [...bytes];
}

function decodeSymbol(symbol) {
  return Buffer.from(symbol).toString("ascii").replace(/\0+$/g, "");
}

async function ensureFeeRecipientTokenAccount(provider, mint, feeRecipientWallet) {
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    provider.wallet.payer,
    mint,
    feeRecipientWallet,
    false,
    "confirmed",
    {
      commitment: "confirmed",
    }
  );

  return tokenAccount.address;
}

async function buildDeploymentTokens(program, provider, feeRecipientWallet) {
  const tokenRegistryPda = findTokenRegistryPda(program.programId);
  const registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);

  const tokens = await Promise.all(
    registry.tokens.map(async (entry) => {
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

  return tokens.sort((left, right) => left.id - right.id);
}

async function writeDeploymentConfig(program, provider) {
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
  const tokens = await buildDeploymentTokens(
    program,
    provider,
    new PublicKey(globalConfig.feeRecipient.toString())
  );

  const deploymentConfig = {
    programId: program.programId.toString(),
    network: "devnet",
    chainId: globalConfig.chainId,
    messageDomain: Buffer.from(globalConfig.messageDomain).toString("hex"),
    deployer: provider.wallet.publicKey.toString(),
    authority: globalConfig.authority.toString(),
    feeRecipient: globalConfig.feeRecipient.toString(),
    feeBps: globalConfig.feeBps,
    registrationFeeLamports: globalConfig.registrationFeeLamports.toNumber(),
    withdrawalTimelockSeconds: globalConfig.withdrawalTimelockSeconds.toNumber(),
    channelUnlockTimelockSeconds:
      globalConfig.channelUnlockTimelockSeconds?.toNumber?.() ?? null,
    tokens,
    deployedAt: new Date().toISOString(),
  };

  const outputPath = path.join(process.cwd(), "config", "devnet-deployment.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(deploymentConfig, null, 2)}\n`);

  return deploymentConfig;
}

async function ensureToken(program, provider, tokenId, mintAddress, symbol) {
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const tokenRegistryPda = findTokenRegistryPda(program.programId);
  const registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);

  const existing = registry.tokens.find(
    (entry) =>
      entry.id === tokenId ||
      entry.mint.toString() === mintAddress
  );

  if (!existing) {
    await program.methods
      .registerToken(tokenId, symbolBytes(symbol))
      .accounts({
        tokenRegistry: tokenRegistryPda,
        vaultTokenAccount: findVaultTokenAccountPda(program.programId, tokenId),
        mint: new PublicKey(mintAddress),
        globalConfig: globalConfigPda,
        authority: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  } else {
    if (existing.id !== tokenId) {
      throw new Error(
        `Mint ${mintAddress} is already registered under token id ${existing.id}, not ${tokenId}`
      );
    }
    if (existing.mint.toString() !== mintAddress) {
      throw new Error(
        `Token id ${tokenId} is already registered to ${existing.mint.toString()}, not ${mintAddress}`
      );
    }
  }

  const deploymentConfig = await writeDeploymentConfig(program, provider);
  return deploymentConfig.tokens.find((entry) => entry.id === tokenId);
}

async function ensureParticipant(program, provider) {
  const globalConfigPda = findGlobalConfigPda(program.programId);
  const globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
  let participantRecord = await fetchParticipantForOwner(
    program,
    provider.wallet.publicKey
  );

  if (!participantRecord) {
    const participantId = Number(globalConfig.nextParticipantId);
    const participantPda = findParticipantBucketPdaById(
      program.programId,
      participantId
    );
    const ownerIndexBucketPda = findOwnerIndexBucketPda(
      program.programId,
      provider.wallet.publicKey
    );
    await program.methods
      .initializeParticipant(
        participantBucketIdForParticipantId(participantId),
        ownerIndexBucketIdForOwner(provider.wallet.publicKey)
      )
      .accounts({
        globalConfig: globalConfigPda,
        participantBucket: participantPda,
        ownerIndexBucket: ownerIndexBucketPda,
        feeRecipient: new PublicKey(globalConfig.feeRecipient.toString()),
        owner: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([provider.wallet.payer])
      .rpc();
    participantRecord = await fetchParticipantForOwner(
      program,
      provider.wallet.publicKey
    );
  }
  if (!participantRecord) {
    throw new Error("Participant registration did not produce a bucket slot");
  }

  return {
    participantPda: participantRecord.participantPda.toString(),
    participantId: participantRecord.participant.participantId,
    owner: participantRecord.participant.owner.toString(),
    inboundChannelPolicy: participantRecord.participant.inboundChannelPolicy,
  };
}

async function setInboundPolicy(program, provider, policy) {
  let participantRecord = await fetchParticipantForOwner(
    program,
    provider.wallet.publicKey
  );
  if (!participantRecord) {
    await ensureParticipant(program, provider);
    participantRecord = await fetchParticipantForOwner(
      program,
      provider.wallet.publicKey
    );
  }
  if (!participantRecord) {
    throw new Error("Participant must be initialized before setting policy");
  }

  await program.methods
    .updateInboundChannelPolicy(policy)
    .accounts({
      participantBucket: participantRecord.participantPda,
      ownerIndexBucket: participantRecord.ownerIndexBucketPda,
      owner: provider.wallet.publicKey,
    })
    .rpc();

  participantRecord = await fetchParticipantForOwner(program, provider.wallet.publicKey);
  return {
    participantPda: participantRecord.participantPda.toString(),
    participantId: participantRecord.participant.participantId,
    owner: participantRecord.participant.owner.toString(),
    inboundChannelPolicy: participantRecord.participant.inboundChannelPolicy,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const provider = loadProvider();
  anchor.setProvider(provider);
  const program = loadProgram(provider);

  if (command === "ensure-token") {
    const tokenId = Number(options.id);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      throw new Error("ensure-token requires --id <positive integer>");
    }
    if (!options.mint) {
      throw new Error("ensure-token requires --mint <mint-address>");
    }
    if (!options.symbol) {
      throw new Error("ensure-token requires --symbol <symbol>");
    }

    const token = await ensureToken(program, provider, tokenId, options.mint, options.symbol);
    console.log(JSON.stringify({ ok: true, token }, null, 2));
    return;
  }

  if (command === "ensure-participant") {
    const participant = await ensureParticipant(program, provider);
    console.log(JSON.stringify({ ok: true, participant }, null, 2));
    return;
  }

  if (command === "set-inbound-policy") {
    const policy = Number(options.policy);
    if (![0, 1, 2].includes(policy)) {
      throw new Error("set-inbound-policy requires --policy 0|1|2");
    }
    const participant = await setInboundPolicy(program, provider, policy);
    console.log(JSON.stringify({ ok: true, participant }, null, 2));
    return;
  }

  if (command === "refresh-config") {
    const config = await writeDeploymentConfig(program, provider);
    console.log(JSON.stringify({ ok: true, config }, null, 2));
    return;
  }

  throw new Error(
    "Usage: node scripts/devnet-admin.cjs <ensure-token|ensure-participant|set-inbound-policy|refresh-config> [--id 2 --mint <mint> --symbol RYVO | --policy 0]"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
