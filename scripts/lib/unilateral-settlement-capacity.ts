import {
  AddressLookupTableAccount,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Buffer } from "buffer";

import { LEGACY_PACKET_DATA_SIZE } from "./clearing-round-capacity";

const TOKEN_REGISTRY_SEED = "token-registry";
const GLOBAL_CONFIG_SEED = "global-config";
const SYNTHETIC_RECENT_BLOCKHASH = "11111111111111111111111111111111";
const SETTLE_INDIVIDUAL_DATA_LENGTH = 8;
const SETTLE_COMMITMENT_BUNDLE_DATA_LENGTH = 9;

export const LEGACY_COMMITMENT_V2_MESSAGE_BYTES = 103;
export const CURRENT_COMMITMENT_V4_TYPICAL_MESSAGE_BYTES = 28;
export const CURRENT_COMMITMENT_V4_CONSERVATIVE_MESSAGE_BYTES = 29;

export type IndividualSettlementCapacityMeasurement = {
  messageBytes: number;
  serializedTxBytes: number;
  remainingBytes: number;
  fits: boolean;
};

export type BundleSettlementCapacityMeasurement = {
  messageBytes: number;
  entryCount: number;
  authEnvelopeBytes: number;
  serializedTxBytes: number;
  remainingBytes: number;
  fits: boolean;
};

function deriveProgramAddress(programId: PublicKey, seed: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
}

function uniquePublicKey(seed: number): PublicKey {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed >>> 0, 0);
  bytes.writeUInt32LE((seed ^ 0x91f1_23ab) >>> 0, 4);
  return new PublicKey(bytes);
}

function shortvecLength(value: number): number {
  let remaining = value >>> 0;
  let length = 0;
  do {
    remaining >>>= 7;
    length += 1;
  } while (remaining > 0);
  return length;
}

function estimateLegacySignedTransactionSize(params: {
  payerKey: PublicKey;
  instructions: TransactionInstruction[];
  requiredSignatures: number;
}): number {
  try {
    const message = new TransactionMessage({
      payerKey: params.payerKey,
      instructions: params.instructions,
      recentBlockhash: SYNTHETIC_RECENT_BLOCKHASH,
    }).compileToLegacyMessage();

    return (
      shortvecLength(params.requiredSignatures) +
      64 * params.requiredSignatures +
      message.serialize().length
    );
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function estimateV0AltSignedTransactionSize(params: {
  payer: Keypair;
  instructions: TransactionInstruction[];
  lookupTable: AddressLookupTableAccount;
}): number {
  try {
    const message = new TransactionMessage({
      payerKey: params.payer.publicKey,
      instructions: params.instructions,
      recentBlockhash: SYNTHETIC_RECENT_BLOCKHASH,
    }).compileToV0Message([params.lookupTable]);
    const transaction = new VersionedTransaction(message);
    transaction.sign([params.payer]);
    return transaction.serialize().length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function createSyntheticEd25519Instruction(params: {
  signatureCount: number;
  messageBytesPerSignature: number;
  sharedMessage: boolean;
}): TransactionInstruction {
  const headerSize = 2 + 14 * params.signatureCount;
  const signerBytes = params.signatureCount * (32 + 64);
  const messageBytes = params.sharedMessage
    ? params.messageBytesPerSignature
    : params.signatureCount * params.messageBytesPerSignature;
  const dataLength = headerSize + signerBytes + messageBytes;

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data: Buffer.alloc(dataLength),
  });
}

function createIndividualSettlementInstruction(
  programId: PublicKey,
  submitter: PublicKey,
  payerBucket: PublicKey,
  payeeBucket: PublicKey,
  channelBucketAccount: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      {
        pubkey: deriveProgramAddress(programId, TOKEN_REGISTRY_SEED),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: deriveProgramAddress(programId, GLOBAL_CONFIG_SEED),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: payerBucket, isSigner: false, isWritable: true },
      { pubkey: payeeBucket, isSigner: false, isWritable: true },
      { pubkey: channelBucketAccount, isSigner: false, isWritable: true },
      { pubkey: submitter, isSigner: true, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.alloc(SETTLE_INDIVIDUAL_DATA_LENGTH),
  });
}

function createBundleSettlementInstruction(
  programId: PublicKey,
  submitter: PublicKey,
  payeeBucket: PublicKey,
  payerBucketAccounts: PublicKey[],
  channelBucketAccounts: PublicKey[]
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      {
        pubkey: deriveProgramAddress(programId, TOKEN_REGISTRY_SEED),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: deriveProgramAddress(programId, GLOBAL_CONFIG_SEED),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: payeeBucket, isSigner: false, isWritable: true },
      { pubkey: submitter, isSigner: true, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      ...payerBucketAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
      ...channelBucketAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    ],
    data: Buffer.alloc(SETTLE_COMMITMENT_BUNDLE_DATA_LENGTH),
  });
}

function buildBundleLookupTable(
  programId: PublicKey,
  payeeBucket: PublicKey,
  payerBucketAccounts: PublicKey[],
  channelBucketAccounts: PublicKey[]
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: uniquePublicKey(8_000),
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [
        deriveProgramAddress(programId, TOKEN_REGISTRY_SEED),
        deriveProgramAddress(programId, GLOBAL_CONFIG_SEED),
        SYSVAR_INSTRUCTIONS_PUBKEY,
        payeeBucket,
        ...payerBucketAccounts,
        ...channelBucketAccounts,
      ],
    },
  });
}

export function measureIndividualSettlementCapacity(params: {
  programId: PublicKey;
  messageBytes: number;
  packetDataSize?: number;
}): IndividualSettlementCapacityMeasurement {
  const packetDataSize = params.packetDataSize ?? LEGACY_PACKET_DATA_SIZE;
  const submitter = Keypair.generate();
  const payerBucket = uniquePublicKey(1_000);
  const payeeBucket = uniquePublicKey(1_001);
  const channelBucketAccount = uniquePublicKey(1_002);

  const ed25519Ix = createSyntheticEd25519Instruction({
    signatureCount: 1,
    messageBytesPerSignature: params.messageBytes,
    sharedMessage: true,
  });
  const settleIx = createIndividualSettlementInstruction(
    params.programId,
    submitter.publicKey,
    payerBucket,
    payeeBucket,
    channelBucketAccount
  );
  const serializedTxBytes = estimateLegacySignedTransactionSize({
    payerKey: submitter.publicKey,
    instructions: [ed25519Ix, settleIx],
    requiredSignatures: 1,
  });

  return {
    messageBytes: params.messageBytes,
    serializedTxBytes,
    remainingBytes: packetDataSize - serializedTxBytes,
    fits: serializedTxBytes <= packetDataSize,
  };
}

export function measureBundleSettlementCapacity(params: {
  programId: PublicKey;
  messageBytes: number;
  entryCount: number;
  packetDataSize?: number;
}): BundleSettlementCapacityMeasurement {
  const packetDataSize = params.packetDataSize ?? LEGACY_PACKET_DATA_SIZE;
  const submitter = Keypair.generate();
  const payeeBucket = uniquePublicKey(2_000);
  const payerBucketAccounts = Array.from({ length: params.entryCount }, (_, index) =>
    uniquePublicKey(2_100 + index)
  );
  const channelBucketAccounts = Array.from({ length: params.entryCount }, (_, index) =>
    uniquePublicKey(3_100 + index)
  );

  const ed25519Ix = createSyntheticEd25519Instruction({
    signatureCount: params.entryCount,
    messageBytesPerSignature: params.messageBytes,
    sharedMessage: false,
  });
  const settleIx = createBundleSettlementInstruction(
    params.programId,
    submitter.publicKey,
    payeeBucket,
    payerBucketAccounts,
    channelBucketAccounts
  );
  const serializedTxBytes = estimateV0AltSignedTransactionSize({
    payer: submitter,
    instructions: [ed25519Ix, settleIx],
    lookupTable: buildBundleLookupTable(
      params.programId,
      payeeBucket,
      payerBucketAccounts,
      channelBucketAccounts
    ),
  });

  return {
    messageBytes: params.messageBytes,
    entryCount: params.entryCount,
    authEnvelopeBytes: ed25519Ix.data.length,
    serializedTxBytes,
    remainingBytes: packetDataSize - serializedTxBytes,
    fits: serializedTxBytes <= packetDataSize,
  };
}

export function findLargestBundleSettlementEntryCount(params: {
  programId: PublicKey;
  messageBytes: number;
  maxEntries?: number;
  packetDataSize?: number;
}): BundleSettlementCapacityMeasurement {
  const maxEntries = params.maxEntries ?? 32;
  let best = measureBundleSettlementCapacity({
    programId: params.programId,
    messageBytes: params.messageBytes,
    entryCount: 1,
    packetDataSize: params.packetDataSize,
  });

  for (let entryCount = 2; entryCount <= maxEntries; entryCount += 1) {
    const measurement = measureBundleSettlementCapacity({
      programId: params.programId,
      messageBytes: params.messageBytes,
      entryCount,
      packetDataSize: params.packetDataSize,
    });
    if (!measurement.fits) {
      break;
    }
    best = measurement;
  }

  return best;
}
