import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  TransactionInstruction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { createHash } from "crypto";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { RyvoProtocol } from "../../target/types/ryvo_protocol";
import { MockYield } from "../../target/types/mock_yield";
import { expect } from "chai";
import { ed25519 } from "@noble/curves/ed25519";
import {
  BLS_CLEARING_ROUND_MESSAGE_VERSION,
  BLS_PUBLIC_KEY_COMPRESSED_SIZE,
  BLS_REGISTRATION_MESSAGE_VERSION,
  BLS_REGISTRATION_MESSAGE_KIND,
  BLS_SIGNATURE_COMPRESSED_SIZE,
  type BlsKeypair,
  aggregateBlsSignatures,
  createBlsKeypairFromSeed,
  createBlsRegistrationMessage as createSharedBlsRegistrationMessage,
  deriveMessageDomain,
  signBlsMessage,
} from "../../shared/protocol-bls";
import {
  getCanonicalChannelParticipants,
  getDirectionalLaneState,
  normalizeChannelBucketState as normalizeSharedChannelBucketState,
  normalizeDirectionalChannelState,
  normalizeParticipantBucketSlot,
} from "../../shared/channel-bucket-state";

// Configure the client to use the local cluster.
anchor.setProvider(anchor.AnchorProvider.env());
export const provider = anchor.AnchorProvider.env();
export const program = anchor.workspace.ryvoProtocol as Program<RyvoProtocol>;

// Test accounts - shared across all test files
export let primaryMint: PublicKey;
export let deployer: Keypair;
export let feeRecipient: Keypair;
export let feeRecipientTokenAccount: PublicKey; // token_id=1 fee account used by shared tests
export let user1: Keypair;
export let user2: Keypair;
export let user3: Keypair;
export let user4: Keypair;
export let primaryUserTokenAccount: PublicKey;
export let user1TokenAccount: PublicKey;
export let upgradeAuthority: Keypair;
export const PRIMARY_TOKEN_ID = 1;
export const TEST_CHAIN_ID = 3;
export const INBOUND_CHANNEL_POLICY = {
  Permissionless: 0,
  ConsentRequired: 1,
  Disabled: 2,
} as const;
type RegisteredTokenInfo = {
  mint: PublicKey;
  feeRecipientTokenAccount: PublicKey;
};
const registeredTokens = new Map<number, RegisteredTokenInfo>();
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const knownSigners = new Map<string, Keypair>();
const knownParticipantIds = new Map<string, number>();
const knownChannelPairs = new Map<
  string,
  { lowerParticipantId: number; higherParticipantId: number; tokenId: number }
>();
const PARTICIPANT_BUCKET_SLOT_COUNT = 9;
const CHANNEL_BUCKET_SLOT_COUNT = 46;
const OWNER_INDEX_BUCKET_COUNT = 1024;

export const TEST_MESSAGE_DOMAIN = deriveMessageDomain(
  program.programId,
  TEST_CHAIN_ID
);

export type { BlsKeypair };
export {
  aggregateBlsSignatures,
  BLS_CLEARING_ROUND_MESSAGE_VERSION,
  BLS_PUBLIC_KEY_COMPRESSED_SIZE,
  BLS_SIGNATURE_COMPRESSED_SIZE,
  deriveMessageDomain,
  getCanonicalChannelParticipants,
  getDirectionalLaneState,
  normalizeDirectionalChannelState,
  normalizeParticipantBucketSlot,
  signBlsMessage,
};

function rememberKnownSigner(signer: Keypair) {
  knownSigners.set(signer.publicKey.toString(), signer);
}

function lookupKnownSigner(owner: PublicKey): Keypair | null {
  return knownSigners.get(owner.toString()) ?? null;
}

function u32Le(value: number): Buffer {
  return new anchor.BN(value).toArrayLike(Buffer, "le", 4);
}

function u64Le(value: number | bigint): Buffer {
  return new anchor.BN(value.toString()).toArrayLike(Buffer, "le", 8);
}

export function participantBucketIdForParticipantId(
  participantId: number
): number {
  return Math.floor(participantId / PARTICIPANT_BUCKET_SLOT_COUNT);
}

export function participantBucketSlotIndex(participantId: number): number {
  return participantId % PARTICIPANT_BUCKET_SLOT_COUNT;
}

export function ownerIndexBucketIdForOwner(owner: PublicKey): number {
  const digest = createHash("sha256").update(owner.toBuffer()).digest();
  return digest.readUInt32LE(0) % OWNER_INDEX_BUCKET_COUNT;
}

export function findParticipantBucketPdaById(participantId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("participant-bucket-v2"),
      u32Le(participantBucketIdForParticipantId(participantId)),
    ],
    program.programId
  )[0];
}

export function findOwnerIndexBucketPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("owner-index-bucket-v2"),
      u32Le(ownerIndexBucketIdForOwner(owner)),
    ],
    program.programId
  )[0];
}

export function pairOrdinal(
  lowerParticipantId: number,
  higherParticipantId: number
): bigint {
  const higher = BigInt(higherParticipantId);
  return (higher * (higher - 1n)) / 2n + BigInt(lowerParticipantId);
}

export function channelBucketIdForPair(
  payerId: number,
  payeeId: number
): number {
  const lowerParticipantId = Math.min(payerId, payeeId);
  const higherParticipantId = Math.max(payerId, payeeId);
  return Number(
    pairOrdinal(lowerParticipantId, higherParticipantId) /
      BigInt(CHANNEL_BUCKET_SLOT_COUNT)
  );
}

export function channelBucketSlotIndexForPair(
  payerId: number,
  payeeId: number
): number {
  const lowerParticipantId = Math.min(payerId, payeeId);
  const higherParticipantId = Math.max(payerId, payeeId);
  return Number(
    pairOrdinal(lowerParticipantId, higherParticipantId) %
      BigInt(CHANNEL_BUCKET_SLOT_COUNT)
  );
}

export function findChannelBucketPda(
  payerId: number,
  payeeId: number,
  tokenId: number = PRIMARY_TOKEN_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("channel-bucket-v2"),
      new anchor.BN(tokenId).toArrayLike(Buffer, "le", 2),
      u64Le(channelBucketIdForPair(payerId, payeeId)),
    ],
    program.programId
  )[0];
}

function rememberParticipant(owner: PublicKey, participantId: number) {
  knownParticipantIds.set(owner.toString(), participantId);
}

export function knownParticipantId(owner: PublicKey): number {
  const participantId = knownParticipantIds.get(owner.toString());
  if (participantId === undefined) {
    throw new Error(`Unknown participant id for ${owner.toBase58()}`);
  }
  return participantId;
}

async function initializeParticipantFor(owner: Keypair) {
  const globalConfigPda = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  )[0];
  const config = await program.account.globalConfig.fetch(globalConfigPda);
  const participantId = Number(config.nextParticipantId);
  const participantBucket = findParticipantBucketPdaById(participantId);
  const ownerIndexBucket = findOwnerIndexBucketPda(owner.publicKey);

  await program.methods
    .initializeParticipant(
      participantBucketIdForParticipantId(participantId),
      ownerIndexBucketIdForOwner(owner.publicKey)
    )
    .accounts({
      participantBucket,
      ownerIndexBucket,
      feeRecipient: feeRecipient.publicKey,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([owner])
    .rpc();

  rememberParticipant(owner.publicKey, participantId);
  return {
    participantId,
    participantPda: participantBucket,
    participant: await fetchParticipant(owner.publicKey),
  };
}

// Setup shared test accounts and tokens
before(async () => {
  // Create test accounts — deployer pays for protocol setup; users pay for their own registration
  upgradeAuthority = (provider.wallet as any).payer as Keypair;
  deployer = anchor.web3.Keypair.generate();
  feeRecipient = anchor.web3.Keypair.generate();
  user1 = anchor.web3.Keypair.generate();
  user2 = anchor.web3.Keypair.generate();
  user3 = anchor.web3.Keypair.generate();
  user4 = anchor.web3.Keypair.generate();
  [
    upgradeAuthority,
    deployer,
    feeRecipient,
    user1,
    user2,
    user3,
    user4,
  ].forEach(rememberKnownSigner);

  // Airdrop SOL to test accounts (localnet has unlimited airdrops)
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      deployer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      feeRecipient.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      user1.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      user2.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      user3.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      user4.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );

  // Create the primary allowlisted test mint.
  primaryMint = await createMint(
    provider.connection,
    deployer,
    deployer.publicKey,
    null,
    6,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  // Create the fee recipient's token account for token_id=1.
  feeRecipientTokenAccount = await createAccount(
    provider.connection,
    deployer,
    primaryMint,
    feeRecipient.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  // Create a primary token account for user1 and mint funds into it.
  primaryUserTokenAccount = await createAccount(
    provider.connection,
    user1,
    primaryMint,
    user1.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  user1TokenAccount = primaryUserTokenAccount;

  await mintTo(
    provider.connection,
    deployer,
    primaryMint,
    primaryUserTokenAccount,
    deployer,
    1000000000
  );

  // Initialize the protocol
  const globalConfigPda = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  )[0];
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  );

  await program.methods
    .initialize(TEST_CHAIN_ID, 30, new anchor.BN(0), deployer.publicKey) // 0.3% fee, no registration fee
    .accounts({
      feeRecipient: feeRecipient.publicKey,
      upgradeAuthority: upgradeAuthority.publicKey,
      program: program.programId,
      programData: programDataPda,
    } as any)
    .rpc();

  await program.methods
    .acceptConfigAuthority()
    .accounts({
      globalConfig: globalConfigPda,
      pendingAuthority: deployer.publicKey,
    } as any)
    .signers([deployer])
    .rpc();

  // Initialize token registry after config bootstrap so its authority cannot be front-run.
  await program.methods
    .initializeTokenRegistry()
    .accounts({
      globalConfig: globalConfigPda,
      authority: deployer.publicKey,
    } as any)
    .signers([deployer])
    .rpc();

  // Register the primary test token.
  const primaryTokenSymbol = Buffer.from("TOK1\x00\x00\x00\x00");
  const [primaryVaultTokenAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault-token-account"),
      new anchor.BN(PRIMARY_TOKEN_ID).toArrayLike(Buffer, "le", 2),
    ],
    program.programId
  );

  await program.methods
    .registerToken(PRIMARY_TOKEN_ID, [...primaryTokenSymbol])
    .accounts({
      mint: primaryMint,

      authority: deployer.publicKey,
    } as any)
    .signers([deployer])
    .rpc();

  registeredTokens.set(PRIMARY_TOKEN_ID, {
    mint: primaryMint,
    feeRecipientTokenAccount,
  });

  await initializeParticipantFor(user1);
  await initializeParticipantFor(user2);
  await initializeParticipantFor(user3);
  await initializeParticipantFor(user4);
});

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function findParticipantPda(owner: PublicKey): PublicKey {
  return findParticipantBucketPdaById(knownParticipantId(owner));
}

export function findGlobalConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  )[0];
}

export function findTokenRegistryPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token-registry")],
    program.programId
  )[0];
}

export function findVaultTokenAccountPda(
  tokenId: number = PRIMARY_TOKEN_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault-token-account"),
      new anchor.BN(tokenId).toArrayLike(Buffer, "le", 2),
    ],
    program.programId
  )[0];
}

export function sha256Bytes(data: Buffer | Uint8Array): number[] {
  return [...createHash("sha256").update(data).digest()];
}

export function createBlsKeypair(): BlsKeypair {
  return createBlsKeypairFromSeed(Keypair.generate().secretKey);
}

export function createBlsRegistrationMessage(params: {
  participantId: number;
  owner: PublicKey;
  blsPubkeyCompressed: Buffer | Uint8Array;
  messageDomain?: Buffer | Uint8Array;
}): Buffer {
  return createSharedBlsRegistrationMessage({
    ...params,
    messageDomain: params.messageDomain ?? TEST_MESSAGE_DOMAIN,
  });
}

export async function registerParticipantBlsKey(params: {
  owner: Keypair;
  participantPda?: PublicKey;
  participant?: any;
  blsKeypair?: BlsKeypair;
}) {
  const participantPda =
    params.participantPda ?? findParticipantPda(params.owner.publicKey);
  const participant =
    params.participant ?? (await fetchParticipant(params.owner.publicKey));
  const blsKeypair = params.blsKeypair ?? createBlsKeypair();
  const popMessage = createBlsRegistrationMessage({
    participantId: participant.participantId,
    owner: params.owner.publicKey,
    blsPubkeyCompressed: blsKeypair.publicKeyCompressed,
  });
  const popSignatureCompressed = signBlsMessage(blsKeypair, popMessage);

  await program.methods
    .registerParticipantBlsKey(
      [...blsKeypair.publicKeyCompressed],
      [...popSignatureCompressed]
    )
    .accounts({
      globalConfig: findGlobalConfigPda(),
      owner: params.owner.publicKey,
      participantBucket: participantPda,
      ownerIndexBucket: findOwnerIndexBucketPda(params.owner.publicKey),
    } as any)
    .signers([params.owner])
    .rpc();

  const updatedParticipant = await fetchParticipant(params.owner.publicKey);

  return {
    blsKeypair,
    participant: updatedParticipant,
    participantPda,
    popMessage,
    popSignatureCompressed,
  };
}

export function findChannelPda(
  payerId: number,
  payeeId: number,
  tokenId: number = PRIMARY_TOKEN_ID
): PublicKey {
  const lowerParticipantId = Math.min(payerId, payeeId);
  const higherParticipantId = Math.max(payerId, payeeId);
  const channelPda = findChannelBucketPda(payerId, payeeId, tokenId);
  knownChannelPairs.set(channelPda.toString(), {
    lowerParticipantId,
    higherParticipantId,
    tokenId,
  });
  return channelPda;
}

async function fetchAccountData(pubkey: PublicKey): Promise<Buffer> {
  const account = await provider.connection.getAccountInfo(pubkey);
  if (!account) {
    throw new Error(`Account ${pubkey.toString()} was not found`);
  }
  return account.data;
}

function readRawU64(data: Buffer, offset: number): anchor.BN {
  return new anchor.BN(data.subarray(offset, offset + 8), "le");
}

function readRawI64(data: Buffer, offset: number): anchor.BN {
  return new anchor.BN(data.readBigInt64LE(offset).toString());
}

function readRawPubkey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function readRawParticipantBucketSlot(data: Buffer, participantId: number) {
  const slotOffset = 13 + participantBucketSlotIndex(participantId) * 1079;
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

function readRawLane(data: Buffer, laneOffset: number) {
  return {
    initialized: data[laneOffset] !== 0,
    settledCumulative: readRawU64(data, laneOffset + 1),
    lockedBalance: readRawU64(data, laneOffset + 9),
    authorizedSigner: readRawPubkey(data, laneOffset + 17),
    pendingUnlockAmount: readRawU64(data, laneOffset + 49),
    unlockRequestedAt: readRawI64(data, laneOffset + 57),
    pendingAuthorizedSigner: readRawPubkey(data, laneOffset + 65),
    authorizedSignerUpdateRequestedAt: readRawI64(data, laneOffset + 97),
  };
}

async function fetchRawParticipantBucketSlot(participantId: number) {
  return readRawParticipantBucketSlot(
    await fetchAccountData(findParticipantBucketPdaById(participantId)),
    participantId
  );
}

async function fetchRawChannelBucketState(
  channelPda: PublicKey,
  payerId: number,
  payeeId: number
) {
  const data = await fetchAccountData(channelPda);
  const { lowerParticipantId, higherParticipantId } =
    getCanonicalChannelParticipants(payerId, payeeId);
  const slotOffset = 19 + channelBucketSlotIndexForPair(payerId, payeeId) * 219;
  const initialized = data[slotOffset] !== 0;
  const actualLowerParticipantId = data.readUInt32LE(slotOffset + 1);
  const actualHigherParticipantId = data.readUInt32LE(slotOffset + 5);
  if (
    !initialized ||
    actualLowerParticipantId !== lowerParticipantId ||
    actualHigherParticipantId !== higherParticipantId
  ) {
    throw new Error(
      `Channel bucket slot is not initialized for ${payerId}->${payeeId}`
    );
  }

  return {
    tokenId: data.readUInt16LE(8),
    lowerParticipantId,
    higherParticipantId,
    lowerToHigher: readRawLane(data, slotOffset + 9),
    higherToLower: readRawLane(data, slotOffset + 114),
  };
}

export function normalizeChannelBucketState(
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

export async function fetchDirectionalChannelState(
  channelPda: PublicKey,
  payerId: number,
  payeeId: number
) {
  const pairChannel = await fetchRawChannelBucketState(
    channelPda,
    payerId,
    payeeId
  );
  return normalizeDirectionalChannelState(pairChannel, payerId, payeeId);
}

export async function refetchDirectionalChannel(params: {
  channelPda: PublicKey;
  channel?: { payerId: number; payeeId: number };
  payerParticipant?: { participantId: number };
  payeeParticipant?: { participantId: number };
}) {
  const payerId =
    params.channel?.payerId ?? params.payerParticipant?.participantId;
  const payeeId =
    params.channel?.payeeId ?? params.payeeParticipant?.participantId;
  if (payerId === undefined || payeeId === undefined) {
    throw new Error(
      "refetchDirectionalChannel requires a directional channel or explicit payer/payee participant ids"
    );
  }
  return fetchDirectionalChannelState(params.channelPda, payerId, payeeId);
}

export async function fetchParticipant(owner: PublicKey) {
  const participantId = knownParticipantId(owner);
  const slot = await fetchRawParticipantBucketSlot(participantId);
  return normalizeParticipantBucketSlot(slot);
}

export async function fetchParticipantById(participantId: number) {
  const slot = await fetchRawParticipantBucketSlot(participantId);
  return normalizeParticipantBucketSlot(slot);
}

export function uniqueWritableMetasForPubkeys(pubkeys: PublicKey[]) {
  const seen = new Set<string>();
  return pubkeys.flatMap((pubkey) => {
    const key = pubkey.toString();
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ pubkey, isSigner: false, isWritable: true }];
  });
}

export function participantBucketMetasForOwners(owners: PublicKey[]) {
  return uniqueWritableMetasForPubkeys(
    owners.map((owner) => findParticipantPda(owner))
  );
}

export function participantBucketMetasForIds(participantIds: number[]) {
  return uniqueWritableMetasForPubkeys(
    participantIds.map((participantId) =>
      findParticipantBucketPdaById(participantId)
    )
  );
}

export function individualSettlementRemainingAccounts(params: {
  payerParticipantPda: PublicKey;
  payeeParticipantPda: PublicKey;
  channelPda: PublicKey;
}) {
  return [
    ...uniqueWritableMetasForPubkeys([
      params.payerParticipantPda,
      params.payeeParticipantPda,
    ]),
    { pubkey: params.channelPda, isSigner: false, isWritable: true },
  ];
}

export async function settleIndividualForTest(params: {
  ensured: Awaited<ReturnType<typeof ensureChannel>>;
  message: Buffer;
  signer: Keypair;
  submitter: Keypair;
}) {
  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: params.signer.secretKey,
    message: params.message,
  });
  await program.methods
    .settleIndividual()
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      globalConfig: findGlobalConfigPda(),
      submitter: params.submitter.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts(
      individualSettlementRemainingAccounts({
        payerParticipantPda: params.ensured.payerParticipantPda,
        payeeParticipantPda: params.ensured.payeeParticipantPda,
        channelPda: params.ensured.channelPda,
      })
    )
    .preInstructions([ed25519Ix])
    .signers([params.submitter])
    .rpc();
}

export function bundleSettlementRemainingAccounts(params: {
  payeeParticipantPda: PublicKey;
  payerParticipantPdas: PublicKey[];
  channelPdas: PublicKey[];
}) {
  return [
    ...uniqueWritableMetasForPubkeys([
      params.payeeParticipantPda,
      ...params.payerParticipantPdas,
    ]),
    ...uniqueWritableMetasForPubkeys(params.channelPdas),
  ];
}

export async function depositParticipantBalance(params: {
  owner: Keypair;
  ownerTokenAccount: PublicKey;
  tokenId?: number;
  amount: number;
  participantPda?: PublicKey;
}) {
  const tokenId = params.tokenId ?? PRIMARY_TOKEN_ID;
  const participantPda =
    params.participantPda ?? findParticipantPda(params.owner.publicKey);
  await program.methods
    .deposit(tokenId, new anchor.BN(params.amount))
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      globalConfig: findGlobalConfigPda(),
      participantBucket: participantPda,
      ownerIndexBucket: findOwnerIndexBucketPda(params.owner.publicKey),
      ownerTokenAccount: params.ownerTokenAccount,
      vaultTokenAccount: findVaultTokenAccountPda(tokenId),
      owner: params.owner.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([params.owner])
    .rpc();
}

export async function lockChannelFundsForTest(
  ensured: Awaited<ReturnType<typeof ensureChannel>>,
  amount: number,
  owner: Keypair,
  tokenId: number = PRIMARY_TOKEN_ID
) {
  await program.methods
    .lockChannelFunds(
      tokenId,
      ensured.payeeParticipant.participantId,
      new anchor.BN(amount)
    )
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      payerBucket: ensured.payerParticipantPda,
      channelBucket: ensured.channelPda,
      ownerIndexBucket: findOwnerIndexBucketPda(owner.publicKey),
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([owner])
    .rpc();
}

export async function requestUnlockChannelFundsForTest(
  ensured: Awaited<ReturnType<typeof ensureChannel>>,
  amount: number,
  owner: Keypair,
  tokenId: number = PRIMARY_TOKEN_ID
) {
  await program.methods
    .requestUnlockChannelFunds(
      tokenId,
      ensured.payeeParticipant.participantId,
      new anchor.BN(amount)
    )
    .accounts({
      globalConfig: findGlobalConfigPda(),
      channelBucket: ensured.channelPda,
      ownerIndexBucket: findOwnerIndexBucketPda(owner.publicKey),
      owner: owner.publicKey,
    } as any)
    .signers([owner])
    .rpc();
}

export async function executeUnlockChannelFundsForTest(
  ensured: Awaited<ReturnType<typeof ensureChannel>>,
  owner: Keypair,
  tokenId: number = PRIMARY_TOKEN_ID
) {
  await program.methods
    .executeUnlockChannelFunds(tokenId, ensured.payeeParticipant.participantId)
    .accounts({
      globalConfig: findGlobalConfigPda(),
      payerBucket: ensured.payerParticipantPda,
      channelBucket: ensured.channelPda,
      ownerIndexBucket: findOwnerIndexBucketPda(owner.publicKey),
      owner: owner.publicKey,
    } as any)
    .signers([owner])
    .rpc();
}

export async function cooperativeUnlockChannelFundsForTest(
  ensured: Awaited<ReturnType<typeof ensureChannel>>,
  amount: number,
  owner: Keypair,
  payeeOwner: Keypair,
  tokenId: number = PRIMARY_TOKEN_ID
) {
  await (program.methods as any)
    .cooperativeUnlockChannelFunds(
      tokenId,
      ensured.payeeParticipant.participantId,
      new anchor.BN(amount)
    )
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      payerBucket: ensured.payerParticipantPda,
      payeeBucket: ensured.payeeParticipantPda,
      channelBucket: ensured.channelPda,
      ownerIndexBucket: findOwnerIndexBucketPda(owner.publicKey),
      owner: owner.publicKey,
      payeeOwner: payeeOwner.publicKey,
    } as any)
    .signers([owner, payeeOwner])
    .rpc();
}

export async function requestChannelSignerUpdateForTest(
  ensured: Awaited<ReturnType<typeof ensureChannel>>,
  newSigner: PublicKey,
  owner: Keypair,
  tokenId: number = PRIMARY_TOKEN_ID
) {
  await program.methods
    .requestUpdateChannelAuthorizedSigner(
      tokenId,
      ensured.payeeParticipant.participantId,
      newSigner
    )
    .accounts({
      globalConfig: findGlobalConfigPda(),
      channelBucket: ensured.channelPda,
      ownerIndexBucket: findOwnerIndexBucketPda(owner.publicKey),
      owner: owner.publicKey,
    } as any)
    .signers([owner])
    .rpc();
}

export async function executeChannelSignerUpdateForTest(
  ensured: Awaited<ReturnType<typeof ensureChannel>>,
  owner: Keypair,
  tokenId: number = PRIMARY_TOKEN_ID
) {
  await program.methods
    .executeUpdateChannelAuthorizedSigner(
      tokenId,
      ensured.payeeParticipant.participantId
    )
    .accounts({
      globalConfig: findGlobalConfigPda(),
      channelBucket: ensured.channelPda,
      ownerIndexBucket: findOwnerIndexBucketPda(owner.publicKey),
      owner: owner.publicKey,
    } as any)
    .signers([owner])
    .rpc();
}

export async function createTestParticipant() {
  const wallet = anchor.web3.Keypair.generate();
  rememberKnownSigner(wallet);
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      wallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    )
  );

  const { participantPda, participant } = await initializeParticipantFor(
    wallet
  );
  return { wallet, participantPda, participant };
}

export function getRegisteredToken(tokenId: number): RegisteredTokenInfo {
  const token = registeredTokens.get(tokenId);
  if (!token) {
    throw new Error(`Token ${tokenId} is not registered in test setup`);
  }
  return token;
}

export function getFeeRecipientTokenAccount(tokenId: number): PublicKey {
  return getRegisteredToken(tokenId).feeRecipientTokenAccount;
}

export async function registerTestToken(
  tokenId: number,
  symbol: string,
  decimals: number = 6
): Promise<RegisteredTokenInfo> {
  const existing = registeredTokens.get(tokenId);
  if (existing) {
    return existing;
  }

  const symbolBytes = Buffer.alloc(8);
  Buffer.from(symbol, "ascii").copy(symbolBytes, 0, 0, 8);

  const mint = await createMint(
    provider.connection,
    deployer,
    deployer.publicKey,
    null,
    decimals,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  const feeAccount = await createAccount(
    provider.connection,
    deployer,
    mint,
    feeRecipient.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  await program.methods
    .registerToken(tokenId, [...symbolBytes])
    .accounts({
      mint,
      authority: deployer.publicKey,
    } as any)
    .signers([deployer])
    .rpc();

  const token = {
    mint,
    feeRecipientTokenAccount: feeAccount,
  };
  registeredTokens.set(tokenId, token);
  return token;
}

export async function createFundedTokenAccount(
  owner: Keypair,
  mint: PublicKey,
  amount: number
): Promise<PublicKey> {
  const tokenAccount = await createAccount(
    provider.connection,
    deployer,
    mint,
    owner.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  if (amount > 0) {
    await mintTo(
      provider.connection,
      deployer,
      mint,
      tokenAccount,
      deployer,
      amount
    );
  }

  return tokenAccount;
}

export async function ensureChannel(
  payer: Keypair,
  payeeOwner: PublicKey,
  tokenId: number = PRIMARY_TOKEN_ID,
  options?: {
    authorizedSigner?: PublicKey | null;
    payeeOwnerSigner?: Keypair | null;
    skipAutoPayeeOwnerSigner?: boolean;
  }
) {
  const payerParticipantPda = findParticipantPda(payer.publicKey);
  const payeeParticipantPda = findParticipantPda(payeeOwner);
  const payerParticipant = await fetchParticipant(payer.publicKey);
  const payeeParticipant = await fetchParticipant(payeeOwner);
  const channelPda = findChannelPda(
    payerParticipant.participantId,
    payeeParticipant.participantId,
    tokenId
  );
  const { lowerParticipantId, higherParticipantId } =
    getCanonicalChannelParticipants(
      payerParticipant.participantId,
      payeeParticipant.participantId
    );

  try {
    const existingPairChannel = await fetchRawChannelBucketState(
      channelPda,
      payerParticipant.participantId,
      payeeParticipant.participantId
    );
    const existingLane = getDirectionalLaneState(
      existingPairChannel,
      payerParticipant.participantId,
      payeeParticipant.participantId
    );
    if (existingLane.initialized) {
      const channel = normalizeDirectionalChannelState(
        existingPairChannel,
        payerParticipant.participantId,
        payeeParticipant.participantId
      );
      return {
        channel,
        lane: existingLane,
        pairChannel: existingPairChannel,
        channelPda,
        lowerParticipantId,
        higherParticipantId,
        payerParticipant,
        payerParticipantPda,
        payeeParticipant,
        payeeParticipantPda,
      };
    }
  } catch {}

  const payeeOwnerSigner =
    options?.payeeOwnerSigner ??
    (options?.skipAutoPayeeOwnerSigner ? null : lookupKnownSigner(payeeOwner));
  await program.methods
    .createChannel(
      tokenId,
      lowerParticipantId,
      higherParticipantId,
      new anchor.BN(
        channelBucketIdForPair(
          payerParticipant.participantId,
          payeeParticipant.participantId
        )
      ),
      (options?.authorizedSigner ?? null) as any
    )
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      owner: payer.publicKey,
      payerBucket: payerParticipantPda,
      payeeBucket: payeeParticipantPda,
      ownerIndexBucket: findOwnerIndexBucketPda(payer.publicKey),
      payeeOwner: payeeOwnerSigner?.publicKey ?? null,
      channelBucket: channelPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers(payeeOwnerSigner ? [payer, payeeOwnerSigner] : [payer])
    .rpc();

  const pairChannel = await fetchRawChannelBucketState(
    channelPda,
    payerParticipant.participantId,
    payeeParticipant.participantId
  );
  const channel = normalizeDirectionalChannelState(
    pairChannel,
    payerParticipant.participantId,
    payeeParticipant.participantId
  );
  const lane = getDirectionalLaneState(
    pairChannel,
    payerParticipant.participantId,
    payeeParticipant.participantId
  );

  return {
    channel,
    lane,
    pairChannel,
    channelPda,
    lowerParticipantId,
    higherParticipantId,
    payerParticipant,
    payerParticipantPda,
    payeeParticipant,
    payeeParticipantPda,
  };
}

/** Assert that a program call fails with an error containing the given substring.
 *  Uses both message and logs to catch program errors. Prefer specific substrings
 *  (e.g. "InvalidAuthority") over generic ones (e.g. "Invalid") to avoid false positives. */
export async function expectProgramError(
  fn: () => Promise<unknown>,
  errorSubstring: string
): Promise<void> {
  try {
    await fn();
    expect.fail(
      `Expected error containing "${errorSubstring}" but call succeeded`
    );
  } catch (e: any) {
    const msg = e.message ?? e.toString();
    const logs = e.logs?.join(" ") ?? "";
    const combined = msg + " " + logs;
    expect(
      combined,
      `Expected "${errorSubstring}" in error, got: ${msg}`
    ).to.include(errorSubstring);
  }
}

export async function parseProgramEvents(signature: string) {
  let transaction: Awaited<
    ReturnType<typeof provider.connection.getTransaction>
  > | null = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    transaction = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (transaction?.meta?.logMessages) {
      break;
    }

    await sleep(200);
  }

  expect(transaction?.meta?.logMessages, "Transaction logs not available").to
    .exist;

  const logs = transaction!.meta!.logMessages!;
  const parser = new anchor.EventParser(program.programId, program.coder);
  const parsed = [...parser.parseLogs(logs)];

  if (parsed.length > 0) {
    return parsed;
  }

  return logs
    .map((log) => program.coder.events.decode(log))
    .filter((event): event is NonNullable<typeof event> => event !== null);
}

/** Create Ed25519 instruction with multiple signers on the same message (for cooperative clearing rounds) */
export function createMultiSigEd25519Instruction(
  signers: Keypair[],
  message: Buffer
): TransactionInstruction {
  const numSigs = signers.length;
  const headerSize = 2 + 14 * numSigs; // numSignatures(1) + padding(1) + 14 bytes per sig
  const sigBlockSize = 32 + 64; // pubkey + signature per signer
  const dataStart = headerSize;
  const messageOffset = dataStart + numSigs * sigBlockSize;

  const data = Buffer.alloc(messageOffset + message.length);
  data[0] = numSigs;
  data[1] = 0;

  for (let i = 0; i < numSigs; i++) {
    const pubkey = signers[i].publicKey.toBytes();
    const sig = ed25519.sign(message, signers[i].secretKey.slice(0, 32));
    const sigOffset = dataStart + i * sigBlockSize + 32;
    const pubkeyOffset = dataStart + i * sigBlockSize;

    data.writeUInt16LE(sigOffset, 2 + i * 14);
    data.writeUInt16LE(0xffff, 4 + i * 14); // signature_instruction_index
    data.writeUInt16LE(pubkeyOffset, 6 + i * 14);
    data.writeUInt16LE(0xffff, 8 + i * 14); // public_key_instruction_index
    data.writeUInt16LE(messageOffset, 10 + i * 14);
    data.writeUInt16LE(message.length, 12 + i * 14);
    data.writeUInt16LE(0xffff, 14 + i * 14); // message_instruction_index

    Buffer.from(pubkey).copy(data, pubkeyOffset);
    Buffer.from(sig).copy(data, sigOffset);
  }
  message.copy(data, messageOffset);

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

/** Create a single Ed25519 instruction that bundles many signer/message pairs. */
export function createMultiMessageEd25519Instruction(
  entries: { signer: Keypair; message: Buffer }[]
): TransactionInstruction {
  const numSigs = entries.length;
  const headerSize = 2 + 14 * numSigs;
  let cursor = headerSize;
  const buffers: Buffer[] = [];
  const offsetRows: Array<{
    signatureOffset: number;
    publicKeyOffset: number;
    messageOffset: number;
    messageLength: number;
  }> = [];

  for (const entry of entries) {
    const publicKeyOffset = cursor;
    const signatureOffset = publicKeyOffset + 32;
    const messageOffset = signatureOffset + 64;
    const signature = ed25519.sign(
      entry.message,
      entry.signer.secretKey.slice(0, 32)
    );

    buffers.push(
      Buffer.from(entry.signer.publicKey.toBytes()),
      Buffer.from(signature),
      entry.message
    );
    offsetRows.push({
      signatureOffset,
      publicKeyOffset,
      messageOffset,
      messageLength: entry.message.length,
    });
    cursor = messageOffset + entry.message.length;
  }

  const data = Buffer.alloc(cursor);
  data[0] = numSigs;
  data[1] = 0;

  offsetRows.forEach((row, index) => {
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

/** Create an Ed25519 instruction that references message bytes from another instruction. */
export function createCrossInstructionMessageEd25519Instruction(
  signer: Keypair,
  message: Buffer,
  messageInstructionIndex: number
): TransactionInstruction {
  const headerSize = 16;
  const publicKeyOffset = headerSize;
  const signatureOffset = publicKeyOffset + 32;
  const data = Buffer.alloc(signatureOffset + 64);
  const signature = ed25519.sign(message, signer.secretKey.slice(0, 32));

  data[0] = 1;
  data[1] = 0;
  data.writeUInt16LE(signatureOffset, 2);
  data.writeUInt16LE(0xffff, 4);
  data.writeUInt16LE(publicKeyOffset, 6);
  data.writeUInt16LE(0xffff, 8);
  data.writeUInt16LE(0, 10);
  data.writeUInt16LE(message.length, 12);
  data.writeUInt16LE(messageInstructionIndex, 14);

  Buffer.from(signer.publicKey.toBytes()).copy(data, publicKeyOffset);
  Buffer.from(signature).copy(data, signatureOffset);

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

/** Helper to generate cumulative payment commitment message buffer matching the Rust v5 layout. */
export function createCommitmentMessage(params: {
  payerId: number;
  payeeId: number;
  tokenId: number;
  committedAmount?: anchor.BN;
  amount?: anchor.BN;
  authorizedSettler?: PublicKey;
  messageDomain?: Buffer | Uint8Array;
}): Buffer {
  const committedAmount = params.committedAmount ?? params.amount;
  expect(committedAmount, "createCommitmentMessage requires committedAmount").to
    .exist;
  const flags = params.authorizedSettler ? 1 : 0;
  const body: number[] = [
    ...encodeCompactU64(BigInt(params.payerId)),
    ...encodeCompactU64(BigInt(params.payeeId)),
  ];
  const bodyBufferParts = [
    Buffer.from(body),
    new anchor.BN(params.tokenId).toArrayLike(Buffer, "le", 2),
    Buffer.from(encodeCompactU64(BigInt(committedAmount!.toString()))),
  ];

  if (params.authorizedSettler) {
    bodyBufferParts.push(params.authorizedSettler.toBuffer());
  }

  return Buffer.concat([
    Buffer.from([0x01, 0x05]),
    Buffer.from(params.messageDomain ?? TEST_MESSAGE_DOMAIN),
    Buffer.from([flags]),
    ...bodyBufferParts,
  ]);
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

/** Helper to generate cooperative clearing-round message buffer matching the Rust v4 layout. */
export function createClearingRoundMessage(params: {
  tokenId: number;
  version?: number;
  messageDomain?: Buffer | Uint8Array;
  blocks: {
    participantId: number;
    entries: {
      payeeRef: number;
      targetCumulative: anchor.BN;
    }[];
  }[];
}): Buffer {
  const dynamicParts: number[] = [];
  for (const block of params.blocks) {
    dynamicParts.push(...encodeCompactU64(BigInt(block.participantId)));
    dynamicParts.push(block.entries.length & 0xff);
    for (const entry of block.entries) {
      dynamicParts.push(entry.payeeRef & 0xff);
      dynamicParts.push(
        ...encodeCompactU64(BigInt(entry.targetCumulative.toString()))
      );
    }
  }

  return Buffer.concat([
    Buffer.from([0x02, params.version ?? 0x04]),
    Buffer.from(params.messageDomain ?? TEST_MESSAGE_DOMAIN),
    new anchor.BN(params.tokenId).toArrayLike(Buffer, "le", 2),
    Buffer.from([params.blocks.length & 0xff]),
    Buffer.from(dynamicParts),
  ]);
}

/** Helper to extract a specific token's balance from a participant bucket slot */
export function getTokenBalance(participantData: any, tokenId: number) {
  const balance = participantData.tokenBalances.find(
    (b: any) => b.tokenId === tokenId
  );
  if (!balance) {
    return {
      availableBalance: new anchor.BN(0),
      withdrawingBalance: new anchor.BN(0),
      withdrawalUnlockAt: new anchor.BN(0),
      withdrawalDestination: PublicKey.default,
    };
  }
  return balance;
}

export function nextCommitmentAmount(
  channelData: {
    settledCumulative?: anchor.BN | { toString(): string };
  },
  delta: anchor.BN | number
): anchor.BN {
  const deltaBn =
    delta instanceof anchor.BN ? delta : new anchor.BN(delta.toString());
  const current = channelData.settledCumulative ?? new anchor.BN(0);
  return new anchor.BN(current.toString()).add(deltaBn);
}

// ---------------------------------------------------------------------------
// v6 yield-bearing test helpers (mock-yield + ryUSDC).
//
// These helpers register ryUSDC as token_id=RY_USDC_TOKEN_ID alongside the existing primary
// plain-token (TOK1, token_id=PRIMARY_TOKEN_ID=1), so existing tests are untouched. New tests can
// `await getYieldBearingTestbed()` once and then drive yield-bearing flows through the helpers
// below.
// ---------------------------------------------------------------------------

// Picked to avoid collisions with token_ids used by other test files (currently 1-4, 11-16).
export const RY_USDC_TOKEN_ID = 50;
export const RY_USDC_SYMBOL = "ryUSDC";
export const PROTOCOL_YIELD_SHARE_BPS = 3_333; // ~33.33% of yield goes to the protocol fee_recipient.

// PDA seeds — must mirror ryvo-protocol::state::yield_strategy and mock-yield::state.
export const YIELD_STRATEGY_SEED = Buffer.from("yield-strategy");
export const YIELD_SHARE_VAULT_SEED = Buffer.from("yield-share-vault");
export const RESERVE_SEED = Buffer.from("reserve");
export const SHARE_MINT_SEED = Buffer.from("share-mint");
export const LIQUIDITY_VAULT_SEED = Buffer.from("liquidity-vault");

export const mockYieldProgram = anchor.workspace
  .mockYield as Program<MockYield>;

function u16Le(value: number): Buffer {
  return new anchor.BN(value).toArrayLike(Buffer, "le", 2);
}

export function findYieldStrategyPda(tokenId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [YIELD_STRATEGY_SEED, u16Le(tokenId)],
    program.programId
  )[0];
}

export function findYieldShareVaultPda(tokenId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [YIELD_SHARE_VAULT_SEED, u16Le(tokenId)],
    program.programId
  )[0];
}

export function findReservePda(underlyingMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [RESERVE_SEED, underlyingMint.toBuffer()],
    mockYieldProgram.programId
  )[0];
}

export function findShareMintPda(underlyingMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SHARE_MINT_SEED, underlyingMint.toBuffer()],
    mockYieldProgram.programId
  )[0];
}

export function findLiquidityVaultPda(underlyingMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [LIQUIDITY_VAULT_SEED, underlyingMint.toBuffer()],
    mockYieldProgram.programId
  )[0];
}

function symbolBytes(s: string): number[] {
  if (s.length > 8) throw new Error(`symbol too long: ${s}`);
  const buf = Buffer.alloc(8);
  buf.write(s, "utf8");
  return [...buf];
}

export interface YieldBearingTestbed {
  underlyingMint: PublicKey; // == primaryMint, reused for both TOK1 and ryUSDC's underlying.
  reserve: PublicKey;
  shareMint: PublicKey;
  liquidityVault: PublicKey;
  yieldStrategy: PublicKey;
  shareVault: PublicKey;
  feeRecipientUsdcAta: PublicKey;
}

let cachedTestbed: YieldBearingTestbed | null = null;

/**
 * Idempotent bootstrap of the mock-yield reserve + ryUSDC yield-bearing token registration.
 * Safe to call from any number of test files; the work is done at most once per `anchor test` run.
 *
 * Reuses `primaryMint` as the underlying USDC mint. Mints a generous buffer into liquidity_vault so
 * accrued yield is actually redeemable (mock-yield's accrual is virtual — see comment on
 * scripts/yield-bearing-demo.ts::ensureLiquidityVaultYieldBuffer).
 */
export async function getYieldBearingTestbed(): Promise<YieldBearingTestbed> {
  if (cachedTestbed) return cachedTestbed;

  const reserve = findReservePda(primaryMint);
  const shareMint = findShareMintPda(primaryMint);
  const liquidityVault = findLiquidityVaultPda(primaryMint);
  const yieldStrategy = findYieldStrategyPda(RY_USDC_TOKEN_ID);
  const shareVault = findYieldShareVaultPda(RY_USDC_TOKEN_ID);

  // 1) mock-yield reserve — initialise once. APY is irrelevant for solvency assertions; tests that
  // care about magnitude can call updateApyBps directly.
  const reserveInfo = await provider.connection.getAccountInfo(reserve);
  if (!reserveInfo) {
    await mockYieldProgram.methods
      .initializeReserve(600 /* 6% APY */)
      .accounts({
        underlyingMint: primaryMint,
        authority: deployer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([deployer])
      .rpc();
  }

  // 2) liquidity_vault buffer — mint 1B units (1000 USDC equivalent). Deployer is mint authority
  // for primaryMint so this just works on localnet.
  const vaultAccount = await getAccount(
    provider.connection,
    liquidityVault,
    "confirmed"
  ).catch(() => null);
  const desiredBuffer = 1_000_000_000n; // 1000 USDC at 6dp
  const currentVault = vaultAccount?.amount ?? 0n;
  if (currentVault < desiredBuffer) {
    await mintTo(
      provider.connection,
      deployer,
      primaryMint,
      liquidityVault,
      deployer,
      Number(desiredBuffer - currentVault)
    );
  }

  // 3) Register ryUSDC at token_id=RY_USDC_TOKEN_ID. The plain TOK1 stays at PRIMARY_TOKEN_ID=1.
  const strategyInfo = await provider.connection.getAccountInfo(yieldStrategy);
  if (!strategyInfo) {
    await program.methods
      .registerYieldBearingToken(
        RY_USDC_TOKEN_ID,
        symbolBytes(RY_USDC_SYMBOL),
        PROTOCOL_YIELD_SHARE_BPS
      )
      .accounts({
        underlyingMint: primaryMint,
        yieldProgram: mockYieldProgram.programId,
        reserve,
        shareMint,
        liquidityVault,
        authority: deployer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([deployer])
      .rpc();

    registeredTokens.set(RY_USDC_TOKEN_ID, {
      mint: primaryMint,
      feeRecipientTokenAccount,
    });
  }

  // 4) Fee recipient ATA — `claim_protocol_yield_fee` and `execute_withdrawal_yield_bearing` need
  // a USDC ATA owned by the fee_recipient. The existing primary-token feeRecipientTokenAccount is
  // an SPL account on the same mint with the same owner, so we can reuse it.
  const feeRecipientUsdcAta = feeRecipientTokenAccount;

  cachedTestbed = {
    underlyingMint: primaryMint,
    reserve,
    shareMint,
    liquidityVault,
    yieldStrategy,
    shareVault,
    feeRecipientUsdcAta,
  };
  return cachedTestbed;
}

/** Deposit USDC -> ryUSDC for a participant (auto-creates user's USDC ATA + funds it). */
export async function depositYieldBearingForTest(params: {
  owner: Keypair;
  /** Pass `participantPda` if the caller already knows it; otherwise we look it up. */
  participantPda?: PublicKey;
  /** Underlying USDC amount (6dp). The user's ATA is funded with this exact amount before deposit. */
  amountUsdc: number;
}): Promise<{
  testbed: YieldBearingTestbed;
  ownerUsdcAta: PublicKey;
  participantPda: PublicKey;
}> {
  const testbed = await getYieldBearingTestbed();
  const participantPda =
    params.participantPda ?? findParticipantPda(params.owner.publicKey);

  // Ensure the user has an ATA holding `amountUsdc` of underlying USDC.
  const ownerUsdcAta = await createFundedTokenAccount(
    params.owner,
    primaryMint,
    params.amountUsdc
  );

  await program.methods
    .depositYieldBearing(RY_USDC_TOKEN_ID, new anchor.BN(params.amountUsdc))
    .accounts({
      participantBucket: participantPda,
      ownerIndexBucket: findOwnerIndexBucketPda(params.owner.publicKey),
      yieldProgram: mockYieldProgram.programId,
      reserve: testbed.reserve,
      underlyingMint: primaryMint,
      shareMint: testbed.shareMint,
      liquidityVault: testbed.liquidityVault,
      shareVault: testbed.shareVault,
      depositorUnderlying: ownerUsdcAta,
      depositor: params.owner.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([params.owner])
    .rpc();

  return { testbed, ownerUsdcAta, participantPda };
}

/** Permissionlessly accrue yield on the strategy. */
export async function accrueYieldForTest(): Promise<void> {
  const testbed = await getYieldBearingTestbed();
  await program.methods
    .accrueYield()
    .accounts({
      yieldStrategy: testbed.yieldStrategy,
      yieldProgram: mockYieldProgram.programId,
      reserve: testbed.reserve,
      shareMint: testbed.shareMint,
      shareVault: testbed.shareVault,
    } as any)
    .rpc();
}

/** Update mock-yield's APY (deployer is the mock-yield reserve authority). */
export async function updateMockYieldApyForTest(apyBps: number): Promise<void> {
  const testbed = await getYieldBearingTestbed();
  await mockYieldProgram.methods
    .updateApyBps(apyBps)
    .accounts({
      reserve: testbed.reserve,
      authority: deployer.publicKey,
    } as any)
    .signers([deployer])
    .rpc();
}

/** Permissioned protocol-fee claim by the fee_recipient signer. */
export async function claimProtocolYieldFeeForTest(
  amountUsdc: anchor.BN
): Promise<void> {
  const testbed = await getYieldBearingTestbed();
  await program.methods
    .claimProtocolYieldFee(RY_USDC_TOKEN_ID, amountUsdc)
    .accounts({
      yieldStrategy: testbed.yieldStrategy,
      yieldProgram: mockYieldProgram.programId,
      reserve: testbed.reserve,
      underlyingMint: primaryMint,
      shareMint: testbed.shareMint,
      liquidityVault: testbed.liquidityVault,
      shareVault: testbed.shareVault,
      feeRecipientTokenAccount: testbed.feeRecipientUsdcAta,
      feeRecipient: feeRecipient.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([feeRecipient])
    .rpc();
}

/** Internal opt-in: move `amountUsdc` from owner's plain bucket to their ryUSDC bucket. */
export async function optInYieldForTest(params: {
  owner: Keypair;
  /** The plain token id to debit from. */
  plainTokenId?: number;
  /** Underlying USDC amount (6dp) to opt into yield. */
  amountUsdc: number | bigint;
}): Promise<{ testbed: YieldBearingTestbed }> {
  const testbed = await getYieldBearingTestbed();
  const plainTokenId = params.plainTokenId ?? PRIMARY_TOKEN_ID;
  const participantPda = findParticipantPda(params.owner.publicKey);
  const amountBN = new anchor.BN(params.amountUsdc.toString());

  const sig = await program.methods
    .optInYield(plainTokenId, RY_USDC_TOKEN_ID, amountBN)
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      globalConfig: findGlobalConfigPda(),
      yieldStrategy: testbed.yieldStrategy,
      plainVaultTokenAccount: findVaultTokenAccountPda(plainTokenId),
      participantBucket: participantPda,
      ownerIndexBucket: findOwnerIndexBucketPda(params.owner.publicKey),
      yieldProgram: mockYieldProgram.programId,
      reserve: testbed.reserve,
      underlyingMint: primaryMint,
      shareMint: testbed.shareMint,
      liquidityVault: testbed.liquidityVault,
      shareVault: testbed.shareVault,
      owner: params.owner.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([params.owner])
    .rpc();
  // Wait for "confirmed" commitment so subsequent SPL token reads see the post-CPI state on
  // localnet — without this, the validator's confirmed-level cache can lag by ~one slot and
  // tests downstream see stale share_vault / liquidity_vault balances.
  await provider.connection.confirmTransaction(sig, "confirmed");

  return { testbed };
}

/** Internal opt-out: burn `shares` of ryUSDC and credit the redeemed USDC to plain bucket. */
export async function optOutYieldForTest(params: {
  owner: Keypair;
  shares: anchor.BN | number | bigint;
  plainTokenId?: number;
}): Promise<{ testbed: YieldBearingTestbed }> {
  const testbed = await getYieldBearingTestbed();
  const plainTokenId = params.plainTokenId ?? PRIMARY_TOKEN_ID;
  const participantPda = findParticipantPda(params.owner.publicKey);
  const sharesBN =
    params.shares instanceof anchor.BN
      ? params.shares
      : new anchor.BN(params.shares.toString());

  const sig = await program.methods
    .optOutYield(RY_USDC_TOKEN_ID, plainTokenId, sharesBN)
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      globalConfig: findGlobalConfigPda(),
      yieldStrategy: testbed.yieldStrategy,
      plainVaultTokenAccount: findVaultTokenAccountPda(plainTokenId),
      participantBucket: participantPda,
      ownerIndexBucket: findOwnerIndexBucketPda(params.owner.publicKey),
      yieldProgram: mockYieldProgram.programId,
      reserve: testbed.reserve,
      underlyingMint: primaryMint,
      shareMint: testbed.shareMint,
      liquidityVault: testbed.liquidityVault,
      shareVault: testbed.shareVault,
      owner: params.owner.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([params.owner])
    .rpc();
  await provider.connection.confirmTransaction(sig, "confirmed");

  return { testbed };
}

/** Two-step yield-bearing withdrawal — request + execute. Returns the user's USDC ATA. */
export async function withdrawYieldBearingForTest(params: {
  owner: Keypair;
  shares: anchor.BN | number | bigint;
  /** Where the underlying USDC is paid out. Auto-created if omitted. */
  destinationUsdcAta?: PublicKey;
}): Promise<{
  testbed: YieldBearingTestbed;
  destinationUsdcAta: PublicKey;
}> {
  const testbed = await getYieldBearingTestbed();
  const participantPda = findParticipantPda(params.owner.publicKey);
  const sharesBN =
    params.shares instanceof anchor.BN
      ? params.shares
      : new anchor.BN(params.shares.toString());

  const destinationUsdcAta =
    params.destinationUsdcAta ??
    (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        deployer,
        primaryMint,
        params.owner.publicKey,
        false,
        "confirmed"
      )
    ).address;

  await program.methods
    .requestWithdrawalYieldBearing(
      RY_USDC_TOKEN_ID,
      sharesBN,
      destinationUsdcAta
    )
    .accounts({
      participantBucket: participantPda,
      ownerIndexBucket: findOwnerIndexBucketPda(params.owner.publicKey),
      withdrawalDestination: destinationUsdcAta,
      owner: params.owner.publicKey,
    } as any)
    .signers([params.owner])
    .rpc();

  await program.methods
    .executeWithdrawalYieldBearing(
      RY_USDC_TOKEN_ID,
      knownParticipantId(params.owner.publicKey)
    )
    .accounts({
      participantBucket: participantPda,
      yieldProgram: mockYieldProgram.programId,
      reserve: testbed.reserve,
      underlyingMint: primaryMint,
      shareMint: testbed.shareMint,
      liquidityVault: testbed.liquidityVault,
      shareVault: testbed.shareVault,
      withdrawalDestination: destinationUsdcAta,
      feeRecipientTokenAccount: testbed.feeRecipientUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();

  return { testbed, destinationUsdcAta };
}

/** Decode YieldStrategy with the fields tests care about. */
export interface YieldStrategySnapshot {
  userIndexQ64: bigint;
  totalUserShares: bigint;
  protocolOwedUnderlying: bigint;
  lastSettledUnderlying: bigint;
}

export async function fetchYieldStrategy(): Promise<YieldStrategySnapshot> {
  const testbed = await getYieldBearingTestbed();
  const acc: any = await (program.account as any).yieldStrategy.fetch(
    testbed.yieldStrategy
  );
  return {
    userIndexQ64: BigInt(acc.userIndexQ64.toString()),
    totalUserShares: BigInt(acc.totalUserShares.toString()),
    protocolOwedUnderlying: BigInt(acc.protocolOwedUnderlying.toString()),
    lastSettledUnderlying: BigInt(acc.lastSettledUnderlying.toString()),
  };
}

/**
 * Solvency invariant check: share_vault.amount × cUSDC_rate >= total_user_shares × user_index +
 * protocol_owed_underlying. Returns the spread (LHS - RHS) — must be ≥ 0.
 */
export async function assertYieldStrategySolvent(): Promise<bigint> {
  const testbed = await getYieldBearingTestbed();
  const strategy = await fetchYieldStrategy();
  const shareVaultAcc = await getAccount(
    provider.connection,
    testbed.shareVault,
    "confirmed"
  );
  const reserve: any = await (mockYieldProgram.account as any).reserve.fetch(
    testbed.reserve
  );
  const totalUnderlying = BigInt(reserve.totalUnderlying.toString());
  const shareMintInfo = await provider.connection.getTokenSupply(
    testbed.shareMint
  );
  const supply = BigInt(shareMintInfo.value.amount);

  // Convert share_vault's cUSDC into USDC at the current cUSDC ↔ USDC rate.
  const shareVaultBalance = shareVaultAcc.amount;
  const usdcBackedByVault =
    supply === 0n ? 0n : (shareVaultBalance * totalUnderlying) / supply;

  // Liabilities: user shares × user_index_q64 / 2^64.
  const TWO_64 = 1n << 64n;
  const userLiability =
    (strategy.totalUserShares * strategy.userIndexQ64) / TWO_64;
  const totalLiability = userLiability + strategy.protocolOwedUnderlying;

  expect(
    usdcBackedByVault >= totalLiability,
    `solvency invariant broken: vault-backed=${usdcBackedByVault}, ` +
      `liability=${totalLiability} ` +
      `(userShares=${strategy.totalUserShares}, ` +
      `userIndex=${strategy.userIndexQ64}, ` +
      `protocolOwed=${strategy.protocolOwedUnderlying})`
  ).to.be.true;

  return usdcBackedByVault - totalLiability;
}
