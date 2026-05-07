import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { Buffer } from "buffer";

export const LEGACY_PACKET_DATA_SIZE = 1232;
const DEFAULT_BLS_AGGREGATE_SIGNATURE_BYTES = 48;
const TOKEN_REGISTRY_SEED = "token-registry";
const GLOBAL_CONFIG_SEED = "global-config";
const SYNTHETIC_RECENT_BLOCKHASH = "11111111111111111111111111111111";
const SYNTHETIC_MESSAGE_DOMAIN = Buffer.from("ryvo-capacity-v4", "utf8");
const PARTICIPANT_BUCKET_SLOT_COUNT = 9;
const CHANNEL_BUCKET_SLOT_COUNT = 46;

export type ClearingRoundCapacityMode =
  | "bls"
  | "bls-v0-alt"
  | "hypothetical-bls"
  | "hypothetical-bls-v0-alt";

export type ClearingRoundCapacityMeasurement = {
  mode: ClearingRoundCapacityMode;
  participantCount: number;
  channelCount: number;
  messageBytes: number;
  authEnvelopeBytes: number;
  serializedTxBytes: number;
  remainingBytes: number;
  participantBucketCount: number;
  channelBucketCount: number;
  dynamicWritableAccountCount: number;
  fits: boolean;
};

export type ClearingRoundCapacitySummary = {
  blsCycle: ClearingRoundCapacityMeasurement;
  blsOverall: ClearingRoundCapacityMeasurement;
  blsV0AltCycle: ClearingRoundCapacityMeasurement;
  blsV0AltOverall: ClearingRoundCapacityMeasurement;
};

type SyntheticBlock = {
  signer: Keypair;
  participantId: number;
  entries: {
    payeeRef: number;
  }[];
};

function deriveProgramAddress(programId: PublicKey, seed: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
}

function uniquePublicKey(seed: number): PublicKey {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed >>> 0, 0);
  bytes.writeUInt32LE((seed ^ 0xa5a5_5a5a) >>> 0, 4);
  return new PublicKey(bytes);
}

function buildOrderedPairs(participantCount: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let offset = 1; offset < participantCount; offset += 1) {
    for (let payerIndex = 0; payerIndex < participantCount; payerIndex += 1) {
      pairs.push([payerIndex, (payerIndex + offset) % participantCount]);
    }
  }
  return pairs;
}

function buildSyntheticRound(
  participantCount: number,
  channelCount: number
): {
  submitter: Keypair;
  participantBucketAccounts: PublicKey[];
  channelBucketAccounts: PublicKey[];
  blocks: SyntheticBlock[];
} {
  if (participantCount < 3) {
    throw new Error("Multilateral clearing requires at least 3 participants");
  }
  if (channelCount < participantCount) {
    throw new Error(
      `Meaningful multilateral rounds need at least one channel per participant (channels=${channelCount}, participants=${participantCount})`
    );
  }
  if (channelCount > participantCount * (participantCount - 1)) {
    throw new Error(
      `Requested ${channelCount} directed channels, but only ${
        participantCount * (participantCount - 1)
      } unique participant pairs exist`
    );
  }

  const submitter = Keypair.generate();
  const participantBucketAccounts: PublicKey[] = [];
  const participantBucketById = new Map<number, PublicKey>();
  const blocks: SyntheticBlock[] = Array.from(
    { length: participantCount },
    (_, index) => ({
      signer: Keypair.generate(),
      participantId: index,
      entries: [],
    })
  );
  for (const block of blocks) {
    const bucketId = participantBucketIdForParticipantId(block.participantId);
    if (!participantBucketById.has(bucketId)) {
      const participantBucket = uniquePublicKey(1_000 + bucketId);
      participantBucketById.set(bucketId, participantBucket);
      participantBucketAccounts.push(participantBucket);
    }
  }

  const orderedPairs = buildOrderedPairs(participantCount);
  const channelBucketAccounts: PublicKey[] = [];
  const channelBucketAccountById = new Map<number, PublicKey>();
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const [payerIndex, payeeIndex] = orderedPairs[channelIndex];
    const lowerIndex = Math.min(payerIndex, payeeIndex);
    const higherIndex = Math.max(payerIndex, payeeIndex);
    const channelBucketId = channelBucketIdForPair(lowerIndex, higherIndex);
    if (!channelBucketAccountById.has(channelBucketId)) {
      const channelBucket = uniquePublicKey(5_000 + channelBucketId);
      channelBucketAccountById.set(channelBucketId, channelBucket);
      channelBucketAccounts.push(channelBucket);
    }
    blocks[payerIndex].entries.push({
      payeeRef: payeeIndex,
    });
  }

  return {
    submitter,
    participantBucketAccounts,
    channelBucketAccounts,
    blocks,
  };
}

function participantBucketIdForParticipantId(participantId: number): number {
  return Math.floor(participantId / PARTICIPANT_BUCKET_SLOT_COUNT);
}

function channelBucketIdForPair(
  lowerParticipantId: number,
  higherParticipantId: number
): number {
  const higher = BigInt(higherParticipantId);
  const ordinal = (higher * (higher - 1n)) / 2n + BigInt(lowerParticipantId);
  return Number(ordinal / BigInt(CHANNEL_BUCKET_SLOT_COUNT));
}

function encodeCompactU64(value: bigint): number[] {
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

function createClearingRoundMessage(
  blocks: SyntheticBlock[],
  version = 0x04
): Buffer {
  const dynamicParts: number[] = [];
  for (const block of blocks) {
    dynamicParts.push(...encodeCompactU64(BigInt(block.participantId)));
    dynamicParts.push(block.entries.length & 0xff);

    for (const entry of block.entries) {
      dynamicParts.push(entry.payeeRef & 0xff);
      dynamicParts.push(
        ...encodeCompactU64(BigInt(1_000_000 + dynamicParts.length))
      );
    }
  }

  return Buffer.concat([
    Buffer.from([0x02, version]),
    SYNTHETIC_MESSAGE_DOMAIN,
    Buffer.from([0x01, 0x00]),
    Buffer.from([blocks.length & 0xff]),
    Buffer.from(dynamicParts),
  ]);
}

function createClearingRoundInstruction(
  programId: PublicKey,
  submitter: PublicKey,
  participantBucketAccounts: PublicKey[],
  channelBucketAccounts: PublicKey[],
  dataLength: number
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
      {
        pubkey: submitter,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      ...participantBucketAccounts.map((pubkey) => ({
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
    data: Buffer.alloc(dataLength),
  });
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

function buildSyntheticLookupTable(
  programId: PublicKey,
  participantBucketAccounts: PublicKey[],
  channelBucketAccounts: PublicKey[]
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: uniquePublicKey(9_000),
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [
        deriveProgramAddress(programId, TOKEN_REGISTRY_SEED),
        deriveProgramAddress(programId, GLOBAL_CONFIG_SEED),
        SYSVAR_INSTRUCTIONS_PUBKEY,
        ...participantBucketAccounts,
        ...channelBucketAccounts,
      ],
    },
  });
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

function shortvecLength(value: number): number {
  let remaining = value >>> 0;
  let length = 0;
  do {
    remaining >>>= 7;
    length += 1;
  } while (remaining > 0);
  return length;
}

export function measureClearingRoundCapacity(params: {
  programId: PublicKey;
  mode: ClearingRoundCapacityMode;
  participantCount: number;
  channelCount: number;
  packetDataSize?: number;
  aggregateSignatureBytes?: number;
}): ClearingRoundCapacityMeasurement {
  const packetDataSize = params.packetDataSize ?? LEGACY_PACKET_DATA_SIZE;
  const aggregateSignatureBytes =
    params.aggregateSignatureBytes ?? DEFAULT_BLS_AGGREGATE_SIGNATURE_BYTES;
  const round = buildSyntheticRound(
    params.participantCount,
    params.channelCount
  );
  const message = createClearingRoundMessage(round.blocks, 0x05);

  let authEnvelopeBytes: number;
  let serializedTxBytes: number;
  const clearingIxDataLength = 8 + 4 + message.length + aggregateSignatureBytes;
  const clearingInstruction = createClearingRoundInstruction(
    params.programId,
    round.submitter.publicKey,
    round.participantBucketAccounts,
    round.channelBucketAccounts,
    clearingIxDataLength
  );

  authEnvelopeBytes = 4 + message.length + aggregateSignatureBytes;
  const instructions = [clearingInstruction];
  const usesV0Alt =
    params.mode === "bls-v0-alt" || params.mode === "hypothetical-bls-v0-alt";
  serializedTxBytes = usesV0Alt
    ? estimateV0AltSignedTransactionSize({
        payer: round.submitter,
        instructions,
        lookupTable: buildSyntheticLookupTable(
          params.programId,
          round.participantBucketAccounts,
          round.channelBucketAccounts
        ),
      })
    : estimateLegacySignedTransactionSize({
        payerKey: round.submitter.publicKey,
        instructions,
        requiredSignatures: 1,
      });

  return {
    mode: params.mode,
    participantCount: params.participantCount,
    channelCount: params.channelCount,
    messageBytes: message.length,
    authEnvelopeBytes,
    serializedTxBytes,
    remainingBytes: packetDataSize - serializedTxBytes,
    participantBucketCount: round.participantBucketAccounts.length,
    channelBucketCount: round.channelBucketAccounts.length,
    dynamicWritableAccountCount:
      round.participantBucketAccounts.length + round.channelBucketAccounts.length,
    fits: serializedTxBytes <= packetDataSize,
  };
}

export function findLargestCycleRound(params: {
  programId: PublicKey;
  mode: ClearingRoundCapacityMode;
  maxParticipants?: number;
  packetDataSize?: number;
  aggregateSignatureBytes?: number;
}): ClearingRoundCapacityMeasurement {
  const maxParticipants = params.maxParticipants ?? 32;
  let best = measureClearingRoundCapacity({
    programId: params.programId,
    mode: params.mode,
    participantCount: 3,
    channelCount: 3,
    packetDataSize: params.packetDataSize,
    aggregateSignatureBytes: params.aggregateSignatureBytes,
  });

  for (
    let participantCount = 4;
    participantCount <= maxParticipants;
    participantCount += 1
  ) {
    const measurement = measureClearingRoundCapacity({
      programId: params.programId,
      mode: params.mode,
      participantCount,
      channelCount: participantCount,
      packetDataSize: params.packetDataSize,
      aggregateSignatureBytes: params.aggregateSignatureBytes,
    });
    if (!measurement.fits) {
      break;
    }
    best = measurement;
  }

  return best;
}

export function findLargestOverallRound(params: {
  programId: PublicKey;
  mode: ClearingRoundCapacityMode;
  maxParticipants?: number;
  packetDataSize?: number;
  aggregateSignatureBytes?: number;
}): ClearingRoundCapacityMeasurement {
  const maxParticipants = params.maxParticipants ?? 32;
  let best = measureClearingRoundCapacity({
    programId: params.programId,
    mode: params.mode,
    participantCount: 3,
    channelCount: 3,
    packetDataSize: params.packetDataSize,
    aggregateSignatureBytes: params.aggregateSignatureBytes,
  });

  for (
    let participantCount = 3;
    participantCount <= maxParticipants;
    participantCount += 1
  ) {
    const maxChannelsForParticipants =
      participantCount * (participantCount - 1);
    for (
      let channelCount = participantCount;
      channelCount <= maxChannelsForParticipants;
      channelCount += 1
    ) {
      const measurement = measureClearingRoundCapacity({
        programId: params.programId,
        mode: params.mode,
        participantCount,
        channelCount,
        packetDataSize: params.packetDataSize,
        aggregateSignatureBytes: params.aggregateSignatureBytes,
      });
      if (!measurement.fits) {
        break;
      }
      if (
        measurement.channelCount > best.channelCount ||
        (measurement.channelCount === best.channelCount &&
          measurement.participantCount > best.participantCount)
      ) {
        best = measurement;
      }
    }
  }

  return best;
}

export function summarizeClearingRoundCapacity(
  programId: PublicKey,
  aggregateSignatureBytes = DEFAULT_BLS_AGGREGATE_SIGNATURE_BYTES
): ClearingRoundCapacitySummary {
  return {
    blsCycle: findLargestCycleRound({
      programId,
      mode: "bls",
      aggregateSignatureBytes,
    }),
    blsOverall: findLargestOverallRound({
      programId,
      mode: "bls",
      aggregateSignatureBytes,
    }),
    blsV0AltCycle: findLargestCycleRound({
      programId,
      mode: "bls-v0-alt",
      aggregateSignatureBytes,
    }),
    blsV0AltOverall: findLargestOverallRound({
      programId,
      mode: "bls-v0-alt",
      aggregateSignatureBytes,
    }),
  };
}
