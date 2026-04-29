import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";

import {
  aggregateBlsSignatures,
  BLS_CLEARING_ROUND_MESSAGE_VERSION,
  BlsKeypair,
  createBlsKeypair,
  createBlsRegistrationMessage,
  createClearingRoundMessage,
  createFundedTokenAccount,
  createTestParticipant,
  ensureChannel,
  expectProgramError,
  fetchParticipant,
  findOwnerIndexBucketPda,
  findTokenRegistryPda,
  findVaultTokenAccountPda,
  getTokenBalance,
  program,
  PRIMARY_TOKEN_ID,
  primaryMint,
  refetchDirectionalChannel,
  registerParticipantBlsKey,
  signBlsMessage,
} from "./shared/setup";

const DIRECTED_RELATIONSHIPS = [
  [0, 1],
  [1, 0],
  [0, 2],
  [2, 0],
  [1, 2],
  [2, 1],
] as const;

const ROUND_DELTAS = [
  5_000_000, 1_500_000, 4_000_000, 7_500_000, 2_250_000, 3_250_000,
];
const BLS_TEST_COMPUTE_UNIT_LIMIT = 1_400_000;
const BLS_TEST_HEAP_FRAME_BYTES = 256 * 1024;

type ParticipantFixture = Awaited<ReturnType<typeof createTestParticipant>> & {
  ownerTokenAccount: PublicKey;
  blsKeypair?: BlsKeypair;
};

function findGlobalConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  )[0];
}

function relationshipKey(payerIndex: number, payeeIndex: number): string {
  return `${payerIndex}>${payeeIndex}`;
}

async function depositToParticipant(
  owner: anchor.web3.Keypair,
  participantPda: PublicKey,
  amount: number
): Promise<PublicKey> {
  const ownerTokenAccount = await createFundedTokenAccount(
    owner,
    primaryMint,
    amount
  );
  await program.methods
    .deposit(PRIMARY_TOKEN_ID, new anchor.BN(amount))
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      globalConfig: findGlobalConfigPda(),
      owner: owner.publicKey,
      participantBucket: participantPda,
      ownerIndexBucket: findOwnerIndexBucketPda(owner.publicKey),
      ownerTokenAccount,
      vaultTokenAccount: findVaultTokenAccountPda(PRIMARY_TOKEN_ID),
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([owner])
    .rpc();
  return ownerTokenAccount;
}

async function createParticipantGroup(
  registerBls: boolean
): Promise<ParticipantFixture[]> {
  const participants: ParticipantFixture[] = [];
  for (let index = 0; index < 3; index += 1) {
    const participant = await createTestParticipant();
    const ownerTokenAccount = await depositToParticipant(
      participant.wallet,
      participant.participantPda,
      120_000_000
    );
    const fixture: ParticipantFixture = {
      ...participant,
      ownerTokenAccount,
    };
    if (registerBls) {
      const registration = await registerParticipantBlsKey({
        owner: participant.wallet,
        participantPda: participant.participantPda,
        participant: participant.participant,
      });
      fixture.blsKeypair = registration.blsKeypair;
    }
    participants.push(fixture);
  }
  return participants;
}

async function createDirectedChannels(group: ParticipantFixture[]) {
  const channels = new Map<string, Awaited<ReturnType<typeof ensureChannel>>>();
  for (const [payerIndex, payeeIndex] of DIRECTED_RELATIONSHIPS) {
    const channel = await ensureChannel(
      group[payerIndex].wallet,
      group[payeeIndex].wallet.publicKey,
      PRIMARY_TOKEN_ID,
      {
        payeeOwnerSigner: group[payeeIndex].wallet,
      }
    );
    channels.set(relationshipKey(payerIndex, payeeIndex), channel);
  }
  return channels;
}

function buildRoundBlocks(
  group: ParticipantFixture[],
  channels: Map<string, Awaited<ReturnType<typeof ensureChannel>>>,
  messageVersion: number
) {
  const blocks = group.map((participant, payerIndex) => ({
    participantId: participant.participant.participantId,
    entries: DIRECTED_RELATIONSHIPS.flatMap(
      ([candidatePayerIndex, payeeIndex], entryIndex) => {
        if (candidatePayerIndex !== payerIndex) {
          return [];
        }
        const channel = channels.get(
          relationshipKey(candidatePayerIndex, payeeIndex)
        );
        if (!channel) {
          throw new Error("Missing directed channel in test fixture");
        }
        return [
          {
            payeeRef: payeeIndex,
            targetCumulative: channel.channel.settledCumulative.add(
              new anchor.BN(ROUND_DELTAS[entryIndex])
            ),
          },
        ];
      }
    ),
  }));

  return {
    blocks,
    message: createClearingRoundMessage({
      tokenId: PRIMARY_TOKEN_ID,
      version: messageVersion,
      blocks,
    }),
  };
}

function orderedRoundChannelMetas(
  group: ParticipantFixture[],
  channels: Map<string, Awaited<ReturnType<typeof ensureChannel>>>
) {
  const seenPairAccounts = new Set<string>();
  return group.flatMap((_, payerIndex) =>
    DIRECTED_RELATIONSHIPS.flatMap(([candidatePayerIndex, payeeIndex]) => {
      if (candidatePayerIndex !== payerIndex) {
        return [];
      }
      const channel = channels.get(
        relationshipKey(candidatePayerIndex, payeeIndex)
      );
      if (!channel) {
        throw new Error("Missing directed channel for round ordering");
      }
      const pairKey = channel.channelPda.toString();
      if (seenPairAccounts.has(pairKey)) {
        return [];
      }
      seenPairAccounts.add(pairKey);
      return [
        {
          pubkey: channel.channelPda,
          isSigner: false,
          isWritable: true,
        },
      ];
    })
  );
}

function orderedRoundParticipantBucketMetas(group: ParticipantFixture[]) {
  const seenBuckets = new Set<string>();
  return group.flatMap((participant) => {
    const bucketKey = participant.participantPda.toString();
    if (seenBuckets.has(bucketKey)) {
      return [];
    }
    seenBuckets.add(bucketKey);
    return [
      {
        pubkey: participant.participantPda,
        isSigner: false,
        isWritable: true,
      },
    ];
  });
}

async function snapshotParticipantBalances(group: ParticipantFixture[]) {
  return Promise.all(
    group.map((participant) => fetchParticipant(participant.wallet.publicKey))
  );
}

async function snapshotChannelStates(
  channels: Map<string, Awaited<ReturnType<typeof ensureChannel>>>
) {
  return Promise.all(
    DIRECTED_RELATIONSHIPS.map(async ([payerIndex, payeeIndex]) => {
      const channel = channels.get(relationshipKey(payerIndex, payeeIndex));
      if (!channel) {
        throw new Error("Missing directed channel in snapshot");
      }
      return refetchDirectionalChannel(channel);
    })
  );
}

function participantBalanceDeltas(before: any[], after: any[]): number[] {
  return before.map((snapshot, index) => {
    const beforeBalance = getTokenBalance(
      snapshot,
      PRIMARY_TOKEN_ID
    ).availableBalance.toNumber();
    const afterBalance = getTokenBalance(
      after[index],
      PRIMARY_TOKEN_ID
    ).availableBalance.toNumber();
    return afterBalance - beforeBalance;
  });
}

async function settleRoundBls(
  group: ParticipantFixture[],
  channels: Map<string, Awaited<ReturnType<typeof ensureChannel>>>,
  signatureMessage?: Buffer
) {
  const { message } = buildRoundBlocks(
    group,
    channels,
    BLS_CLEARING_ROUND_MESSAGE_VERSION
  );
  const signingMessage = signatureMessage ?? message;
  const aggregateSignatureCompressed = aggregateBlsSignatures(
    group.map((participant) => {
      if (!participant.blsKeypair) {
        throw new Error("Missing BLS keypair in round fixture");
      }
      return signBlsMessage(participant.blsKeypair, signingMessage);
    })
  );

  await program.methods
    .settleClearingRound(message, [...aggregateSignatureCompressed])
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      globalConfig: findGlobalConfigPda(),
      submitter: group[0].wallet.publicKey,
      instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts([
      ...orderedRoundParticipantBucketMetas(group),
      ...orderedRoundChannelMetas(group, channels),
    ])
    .preInstructions([
      ComputeBudgetProgram.requestHeapFrame({
        bytes: BLS_TEST_HEAP_FRAME_BYTES,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({
        units: BLS_TEST_COMPUTE_UNIT_LIMIT,
      }),
    ])
    .signers([group[0].wallet])
    .rpc();
}

describe("BLS Clearing Rounds", () => {
  it("settles a 3 participant / 6 directed channel round through the BLS-only bucket path", async function () {
    this.timeout(180_000);

    const blsGroup = await createParticipantGroup(true);
    const blsChannels = await createDirectedChannels(blsGroup);

    const blsParticipantsBefore = await snapshotParticipantBalances(blsGroup);

    await settleRoundBls(blsGroup, blsChannels);

    const blsParticipantsAfter = await snapshotParticipantBalances(blsGroup);
    const blsChannelStates = await snapshotChannelStates(blsChannels);

    const blsDeltas = participantBalanceDeltas(
      blsParticipantsBefore,
      blsParticipantsAfter
    );

    expect(blsDeltas).to.deep.equal([0, 4_500_000, -4_500_000]);

    blsChannelStates.forEach((channel, index) => {
      expect(channel.settledCumulative.toNumber()).to.equal(
        ROUND_DELTAS[index]
      );
    });
  });

  it("rejects malformed compressed BLS pubkeys during registration", async () => {
    const participant = await createTestParticipant();
    const honestKeypair = createBlsKeypair();
    const invalidPubkey = Buffer.alloc(96);
    const popMessage = createBlsRegistrationMessage({
      participantId: participant.participant.participantId,
      owner: participant.wallet.publicKey,
      blsPubkeyCompressed: invalidPubkey,
    });
    const validPopForMalformedPubkey = signBlsMessage(
      honestKeypair,
      popMessage
    );

    await expectProgramError(
      () =>
        program.methods
          .registerParticipantBlsKey(
            [...invalidPubkey],
            [...validPopForMalformedPubkey]
          )
          .accounts({
            globalConfig: findGlobalConfigPda(),
            owner: participant.wallet.publicKey,
            participantBucket: participant.participantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(
              participant.wallet.publicKey
            ),
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "InvalidBlsPublicKey"
    );
  });

  it("rejects invalid BLS proofs of possession during registration", async () => {
    const participant = await createTestParticipant();
    const honestKeypair = createBlsKeypair();
    const wrongSignerKeypair = createBlsKeypair();
    const popMessage = createBlsRegistrationMessage({
      participantId: participant.participant.participantId,
      owner: participant.wallet.publicKey,
      blsPubkeyCompressed: honestKeypair.publicKeyCompressed,
    });
    const invalidPop = signBlsMessage(wrongSignerKeypair, popMessage);

    await expectProgramError(
      () =>
        program.methods
          .registerParticipantBlsKey(
            [...honestKeypair.publicKeyCompressed],
            [...invalidPop]
          )
          .accounts({
            globalConfig: findGlobalConfigPda(),
            owner: participant.wallet.publicKey,
            participantBucket: participant.participantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(
              participant.wallet.publicKey
            ),
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "InvalidBlsProofOfPossession"
    );
  });

  it("rejects BLS registration when the wallet owner does not match the participant account", async () => {
    const first = await createTestParticipant();
    const second = await createTestParticipant();
    const blsKeypair = createBlsKeypair();
    const popMessage = createBlsRegistrationMessage({
      participantId: second.participant.participantId,
      owner: second.wallet.publicKey,
      blsPubkeyCompressed: blsKeypair.publicKeyCompressed,
    });
    const popSignature = signBlsMessage(blsKeypair, popMessage);

    await expectProgramError(
      () =>
        program.methods
          .registerParticipantBlsKey(
            [...blsKeypair.publicKeyCompressed],
            [...popSignature]
          )
          .accounts({
            globalConfig: findGlobalConfigPda(),
            owner: first.wallet.publicKey,
            participantBucket: second.participantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(second.wallet.publicKey),
          } as any)
          .signers([first.wallet])
          .rpc(),
      "BucketAccountMismatch"
    );
  });

  it("rejects second BLS registration for the same participant", async () => {
    const participant = await createTestParticipant();
    const registration = await registerParticipantBlsKey({
      owner: participant.wallet,
      participantPda: participant.participantPda,
      participant: participant.participant,
    });

    await expectProgramError(
      () =>
        program.methods
          .registerParticipantBlsKey(
            [...registration.blsKeypair.publicKeyCompressed],
            [...registration.popSignatureCompressed]
          )
          .accounts({
            globalConfig: findGlobalConfigPda(),
            owner: participant.wallet.publicKey,
            participantBucket: participant.participantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(
              participant.wallet.publicKey
            ),
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "ParticipantBlsKeyAlreadyRegistered"
    );
  });

  it("rejects clearing rounds when one participant has no inline BLS registration", async function () {
    this.timeout(120_000);

    const group = await createParticipantGroup(false);
    for (const participant of group) {
      participant.blsKeypair = createBlsKeypair();
    }
    for (const participant of group.slice(0, 2)) {
      await registerParticipantBlsKey({
        owner: participant.wallet,
        participantPda: participant.participantPda,
        participant: participant.participant,
        blsKeypair: participant.blsKeypair,
      });
    }
    const channels = await createDirectedChannels(group);
    const { message } = buildRoundBlocks(
      group,
      channels,
      BLS_CLEARING_ROUND_MESSAGE_VERSION
    );
    const aggregateSignatureCompressed = aggregateBlsSignatures(
      group.map((participant) =>
        signBlsMessage(participant.blsKeypair!, message)
      )
    );

    await expectProgramError(
      () =>
        program.methods
          .settleClearingRound(message, [...aggregateSignatureCompressed])
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            submitter: group[0].wallet.publicKey,
            instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .remainingAccounts([
            ...orderedRoundParticipantBucketMetas(group),
            ...orderedRoundChannelMetas(group, channels),
          ])
          .signers([group[0].wallet])
          .rpc(),
      "ParticipantBlsKeyNotFound"
    );
  });

  it("builds BLS rounds with participant accounts plus unique pair accounts only", async function () {
    this.timeout(120_000);

    const group = await createParticipantGroup(true);
    const channels = await createDirectedChannels(group);
    const { message } = buildRoundBlocks(
      group,
      channels,
      BLS_CLEARING_ROUND_MESSAGE_VERSION
    );
    const aggregateSignatureCompressed = aggregateBlsSignatures(
      group.map((participant) =>
        signBlsMessage(participant.blsKeypair!, message)
      )
    );
    const pairAccountMetas = orderedRoundChannelMetas(group, channels);

    const instruction = await program.methods
      .settleClearingRound(message, [...aggregateSignatureCompressed])
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        submitter: group[0].wallet.publicKey,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .remainingAccounts([
        ...orderedRoundParticipantBucketMetas(group),
        ...pairAccountMetas,
      ])
      .instruction();

    expect(instruction.keys).to.have.length(
      4 +
        orderedRoundParticipantBucketMetas(group).length +
        pairAccountMetas.length
    );
  });

  it("rejects aggregate signatures that were created for a different clearing-round message", async function () {
    this.timeout(120_000);

    const group = await createParticipantGroup(true);
    const channels = await createDirectedChannels(group);
    const { message } = buildRoundBlocks(
      group,
      channels,
      BLS_CLEARING_ROUND_MESSAGE_VERSION
    );
    const wrongMessage = Buffer.from(message);
    wrongMessage[wrongMessage.length - 1] ^= 0x01;

    await expectProgramError(
      () => settleRoundBls(group, channels, wrongMessage),
      "InvalidBlsSignature"
    );
  });

  it("rejects duplicate extra bucket accounts in the BLS remaining account list", async function () {
    this.timeout(120_000);

    const group = await createParticipantGroup(true);
    const channels = await createDirectedChannels(group);
    const { message } = buildRoundBlocks(
      group,
      channels,
      BLS_CLEARING_ROUND_MESSAGE_VERSION
    );
    const aggregateSignatureCompressed = aggregateBlsSignatures(
      group.map((participant) =>
        signBlsMessage(participant.blsKeypair!, message)
      )
    );

    await expectProgramError(
      () =>
        program.methods
          .settleClearingRound(message, [...aggregateSignatureCompressed])
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            submitter: group[0].wallet.publicKey,
            instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .remainingAccounts([
            ...orderedRoundParticipantBucketMetas(group),
            ...orderedRoundChannelMetas(group, channels),
            orderedRoundChannelMetas(group, channels)[0],
          ])
          .signers([group[0].wallet])
          .rpc(),
      "InvalidClearingRoundMessage"
    );
  });
});
