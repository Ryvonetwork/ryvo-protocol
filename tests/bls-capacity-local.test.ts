import * as anchor from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  aggregateBlsSignatures,
  BLS_CLEARING_ROUND_MESSAGE_VERSION,
  BlsKeypair,
  createClearingRoundMessage,
  createFundedTokenAccount,
  createTestParticipant,
  ensureChannel,
  findOwnerIndexBucketPda,
  findTokenRegistryPda,
  findVaultTokenAccountPda,
  primaryMint,
  program,
  provider,
  registerParticipantBlsKey,
  signBlsMessage,
  sleep,
} from "./shared/setup";

const BLS_CAPACITY_COMPUTE_UNIT_LIMIT = 1_400_000;
const BLS_CAPACITY_HEAP_FRAME_BYTES = 256 * 1024;
const BLS_CAPACITY_TOKEN_ID = 1;
const BLS_CAPACITY_INCREMENT = new anchor.BN(1_000_000);

type CapacityParticipant = Awaited<ReturnType<typeof createTestParticipant>> & {
  blsKeypair: BlsKeypair;
};

type CapacityEdge = Awaited<ReturnType<typeof ensureChannel>> & {
  payerIndex: number;
  payeeIndex: number;
};

type CandidateResult = {
  participantCount: number;
  channelCount: number;
  pairAccountCount: number;
  serializedBytes: number;
  success: boolean;
  error: unknown;
  unitsConsumed: number | null;
};

function findGlobalConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  )[0];
}

function buildOrderedDirectedPairs(
  participantCount: number
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let offset = 1; offset < participantCount; offset += 1) {
    for (let payerIndex = 0; payerIndex < participantCount; payerIndex += 1) {
      pairs.push([payerIndex, (payerIndex + offset) % participantCount]);
    }
  }
  return pairs;
}

function edgeKey(payerIndex: number, payeeIndex: number): string {
  return `${payerIndex}>${payeeIndex}`;
}

async function sendLegacyTransaction(
  feePayer: anchor.web3.Keypair,
  instructions: TransactionInstruction[]
): Promise<void> {
  const { blockhash, lastValidBlockHeight } =
    await provider.connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    recentBlockhash: blockhash,
  }).add(...instructions);
  transaction.sign(feePayer);
  const signature = await provider.connection.sendRawTransaction(
    transaction.serialize(),
    { preflightCommitment: "confirmed" }
  );
  await provider.connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
}

async function createLookupTableForAddresses(
  authority: anchor.web3.Keypair,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount> {
  const uniqueAddresses = [
    ...new Map(
      addresses.map((address) => [address.toString(), address])
    ).values(),
  ];
  const recentSlot = Math.max(
    0,
    (await provider.connection.getSlot("finalized")) - 5
  );
  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      recentSlot,
    });
  await sendLegacyTransaction(authority, [createIx]);

  for (let offset = 0; offset < uniqueAddresses.length; offset += 28) {
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      lookupTable: lookupTableAddress,
      addresses: uniqueAddresses.slice(offset, offset + 28),
    });
    await sendLegacyTransaction(authority, [extendIx]);
  }

  const lastExtendObservedSlot = await provider.connection.getSlot("confirmed");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      (await provider.connection.getSlot("confirmed")) > lastExtendObservedSlot
    ) {
      break;
    }
    await sleep(250);
  }

  const lookupTable = (
    await provider.connection.getAddressLookupTable(lookupTableAddress, {
      commitment: "confirmed",
    })
  ).value;
  if (!lookupTable) {
    throw new Error("Lookup table was created but could not be fetched");
  }
  return lookupTable;
}

function orderedPairMetasForRound(
  selectedEdges: CapacityEdge[],
  participants: CapacityParticipant[]
) {
  const edgeByKey = new Map(
    selectedEdges.map((edge) => [
      edgeKey(edge.payerIndex, edge.payeeIndex),
      edge,
    ])
  );
  const seen = new Set<string>();
  const metas: Array<{ pubkey: PublicKey; isSigner: false; isWritable: true }> =
    [];

  participants.forEach((_, payerIndex) => {
    selectedEdges
      .filter((edge) => edge.payerIndex === payerIndex)
      .forEach((edge) => {
        const resolved = edgeByKey.get(
          edgeKey(edge.payerIndex, edge.payeeIndex)
        );
        if (!resolved) {
          throw new Error("Unable to resolve selected edge");
        }
        const key = resolved.channelPda.toString();
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        metas.push({
          pubkey: resolved.channelPda,
          isSigner: false,
          isWritable: true,
        });
      });
  });

  return metas;
}

function orderedParticipantBucketMetas(participants: CapacityParticipant[]) {
  const seen = new Set<string>();
  return participants.flatMap((participant) => {
    const key = participant.participantPda.toString();
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [
      {
        pubkey: participant.participantPda,
        isSigner: false,
        isWritable: true,
      },
    ];
  });
}

async function createCapacityParticipants(
  participantCount: number
): Promise<CapacityParticipant[]> {
  const participants: CapacityParticipant[] = [];
  for (let index = 0; index < participantCount; index += 1) {
    const participant = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      participant.wallet,
      primaryMint,
      500_000_000
    );
    await program.methods
      .deposit(BLS_CAPACITY_TOKEN_ID, new anchor.BN(500_000_000))
      .accounts({
        owner: participant.wallet.publicKey,
        participantBucket: participant.participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(participant.wallet.publicKey),
        ownerTokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(BLS_CAPACITY_TOKEN_ID),
      } as any)
      .signers([participant.wallet])
      .rpc();
    const registration = await registerParticipantBlsKey({
      owner: participant.wallet,
      participantPda: participant.participantPda,
      participant: participant.participant,
    });
    participants.push({
      ...participant,
      blsKeypair: registration.blsKeypair,
    });
  }
  return participants;
}

async function createCapacityEdges(
  participants: CapacityParticipant[],
  maxChannelCount: number
): Promise<CapacityEdge[]> {
  const orderedPairs = buildOrderedDirectedPairs(participants.length).slice(
    0,
    maxChannelCount
  );
  const edges: CapacityEdge[] = [];
  for (const [payerIndex, payeeIndex] of orderedPairs) {
    edges.push({
      payerIndex,
      payeeIndex,
      ...(await ensureChannel(
        participants[payerIndex].wallet,
        participants[payeeIndex].wallet.publicKey,
        BLS_CAPACITY_TOKEN_ID,
        {
          payeeOwnerSigner: participants[payeeIndex].wallet,
        }
      )),
    });
  }
  return edges;
}

async function evaluateCandidate(params: {
  participants: CapacityParticipant[];
  allEdges: CapacityEdge[];
  participantCount: number;
  channelCount: number;
  lookupTable: AddressLookupTableAccount;
}): Promise<CandidateResult> {
  const participants = params.participants.slice(0, params.participantCount);
  const selectedEdges = params.allEdges
    .filter(
      (edge) =>
        edge.payerIndex < params.participantCount &&
        edge.payeeIndex < params.participantCount
    )
    .slice(0, params.channelCount);
  const blocks = participants.map((participant, payerIndex) => ({
    participantId: participant.participant.participantId,
    entries: selectedEdges
      .filter((edge) => edge.payerIndex === payerIndex)
      .map((edge) => ({
        payeeRef: edge.payeeIndex,
        targetCumulative: edge.channel.settledCumulative.add(
          BLS_CAPACITY_INCREMENT
        ),
      })),
  }));
  const message = createClearingRoundMessage({
    tokenId: BLS_CAPACITY_TOKEN_ID,
    version: BLS_CLEARING_ROUND_MESSAGE_VERSION,
    blocks,
  });
  const aggregateSignature = aggregateBlsSignatures(
    participants.map((participant) =>
      signBlsMessage(participant.blsKeypair, message)
    )
  );
  const pairMetas = orderedPairMetasForRound(selectedEdges, participants);
  const remainingAccounts = [
    ...orderedParticipantBucketMetas(participants),
    ...pairMetas,
  ];
  const clearingIx = await program.methods
    .settleClearingRound(message, [...aggregateSignature])
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      globalConfig: findGlobalConfigPda(),
      submitter: participants[0].wallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts(remainingAccounts)
    .instruction();
  const instructions = [
    ComputeBudgetProgram.requestHeapFrame({
      bytes: BLS_CAPACITY_HEAP_FRAME_BYTES,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({
      units: BLS_CAPACITY_COMPUTE_UNIT_LIMIT,
    }),
    clearingIx,
  ];
  const { blockhash } = await provider.connection.getLatestBlockhash(
    "confirmed"
  );
  const messageV0 = new TransactionMessage({
    payerKey: participants[0].wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message([params.lookupTable]);
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([participants[0].wallet]);
  const serializedBytes = transaction.serialize().length;
  const simulation = await provider.connection.simulateTransaction(
    transaction,
    {
      commitment: "confirmed",
      sigVerify: false,
    }
  );

  return {
    participantCount: params.participantCount,
    channelCount: params.channelCount,
    pairAccountCount: pairMetas.length,
    serializedBytes,
    success: simulation.value.err === null,
    error: simulation.value.err,
    unitsConsumed: simulation.value.unitsConsumed ?? null,
  };
}

async function findMaxChannelsForParticipants(params: {
  participants: CapacityParticipant[];
  allEdges: CapacityEdge[];
  participantCount: number;
  lookupTable: AddressLookupTableAccount;
}): Promise<CandidateResult> {
  let low = params.participantCount;
  let high = params.participantCount * (params.participantCount - 1);
  let best: CandidateResult | null = null;
  let last: CandidateResult | null = null;

  while (low <= high) {
    const channelCount = Math.floor((low + high) / 2);
    const result = await evaluateCandidate({
      ...params,
      channelCount,
    });
    last = result;
    if (result.success) {
      best = result;
      low = channelCount + 1;
    } else {
      high = channelCount - 1;
    }
  }

  return best ?? last!;
}

describe("BLS local capacity search", () => {
  const runCapacity = process.env.AGON_RUN_BLS_CAPACITY === "1" ? it : it.skip;

  runCapacity("measures simulated BLS v0 + ALT capacity", async function () {
    this.timeout(240_000);

    const maxParticipants = Number(process.env.AGON_BLS_CAPACITY_MAX_P ?? 10);
    const participants = await createCapacityParticipants(maxParticipants);
    const allEdges = await createCapacityEdges(
      participants,
      maxParticipants * (maxParticipants - 1)
    );
    const lookupTable = await createLookupTableForAddresses(
      participants[0].wallet,
      [
        findTokenRegistryPda(),
        findGlobalConfigPda(),
        SYSVAR_INSTRUCTIONS_PUBKEY,
        ...orderedParticipantBucketMetas(participants).map(
          (meta) => meta.pubkey
        ),
        ...allEdges.map((edge) => edge.channelPda),
      ]
    );

    const cycleResults: CandidateResult[] = [];
    for (
      let participantCount = 3;
      participantCount <= maxParticipants;
      participantCount += 1
    ) {
      const result = await evaluateCandidate({
        participants,
        allEdges,
        participantCount,
        channelCount: participantCount,
        lookupTable,
      });
      cycleResults.push(result);
      if (!result.success) {
        break;
      }
    }

    const denseResults: CandidateResult[] = [];
    for (
      let participantCount = 3;
      participantCount <= maxParticipants;
      participantCount += 1
    ) {
      denseResults.push(
        await findMaxChannelsForParticipants({
          participants,
          allEdges,
          participantCount,
          lookupTable,
        })
      );
    }

    const bestCycle = [...cycleResults]
      .reverse()
      .find((result) => result.success);
    const bestDense = denseResults
      .filter((result) => result.success)
      .sort(
        (left, right) =>
          right.channelCount - left.channelCount ||
          right.participantCount - left.participantCount
      )[0];

    console.log(
      JSON.stringify(
        {
          maxParticipants,
          bestCycle,
          bestDense,
          cycleResults,
          denseResults,
        },
        null,
        2
      )
    );

    expect(bestCycle, "at least one cycle candidate should pass").to.exist;
    expect(bestDense, "at least one dense candidate should pass").to.exist;
  });
});
