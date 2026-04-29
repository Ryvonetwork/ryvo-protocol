import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  program,
  provider,
  deployer,
  feeRecipient,
  user1,
  expectProgramError,
  createTestParticipant,
  ensureChannel,
  fetchParticipant,
  findGlobalConfigPda,
  findOwnerIndexBucketPda,
  findParticipantBucketPdaById,
  ownerIndexBucketIdForOwner,
  participantBucketIdForParticipantId,
} from "./shared/setup";

describe("Participant Registration", () => {
  it("should register a participant with zero fee", async () => {
    const globalConfigPda = findGlobalConfigPda();
    const globalConfigBefore = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    const { wallet } = await createTestParticipant();

    const participant = await fetchParticipant(wallet.publicKey);
    expect(participant.owner.toString()).to.equal(wallet.publicKey.toString());
    expect(participant.participantId).to.equal(
      globalConfigBefore.nextParticipantId
    );
    expect(participant.tokenBalances.length).to.equal(0);
    expect(participant.inboundChannelPolicy).to.equal(1);

    const globalConfig = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(globalConfig.nextParticipantId).to.equal(
      globalConfigBefore.nextParticipantId + 1
    );
  });

  it("initialize_participant: rejects InvalidFeeRecipient (fee_recipient mismatch)", async () => {
    const wrongFeeRecipient = user1.publicKey;
    const freshUser = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        freshUser.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );
    const globalConfigPda = findGlobalConfigPda();
    const globalConfig = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    const participantId = Number(globalConfig.nextParticipantId);
    const participantBucket = findParticipantBucketPdaById(participantId);
    const ownerIndexBucket = findOwnerIndexBucketPda(freshUser.publicKey);

    await expectProgramError(
      () =>
        program.methods
          .initializeParticipant(
            participantBucketIdForParticipantId(participantId),
            ownerIndexBucketIdForOwner(freshUser.publicKey)
          )
          .accounts({
            globalConfig: globalConfigPda,
            participantBucket,
            ownerIndexBucket,
            owner: freshUser.publicKey,
            feeRecipient: wrongFeeRecipient,
            systemProgram: anchor.web3.SystemProgram.programId,
          } as any)
          .signers([freshUser])
          .rpc(),
      "InvalidFeeRecipient"
    );
  });

  it("should register user2, user3, and user4", async () => {
    const globalConfigPda = findGlobalConfigPda();
    const globalConfigBefore = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    const created = [];

    for (let i = 0; i < 3; i++) {
      created.push(await createTestParticipant());
    }

    const globalConfigAfter = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(globalConfigAfter.nextParticipantId).to.equal(
      globalConfigBefore.nextParticipantId + 3
    );
    expect(created[0].participant.participantId).to.equal(
      globalConfigBefore.nextParticipantId
    );
    expect(created[1].participant.participantId).to.equal(
      globalConfigBefore.nextParticipantId + 1
    );
    expect(created[2].participant.participantId).to.equal(
      globalConfigBefore.nextParticipantId + 2
    );
  });

  it("defaults new participants to ConsentRequired for inbound channels", async () => {
    const participant = await createTestParticipant();
    const freshPayer = await createTestParticipant();

    const stored = await fetchParticipant(participant.wallet.publicKey);
    expect(stored.inboundChannelPolicy).to.equal(1);

    await expectProgramError(
      () =>
        ensureChannel(freshPayer.wallet, participant.wallet.publicKey, 1, {
          skipAutoPayeeOwnerSigner: true,
        }),
      "InboundChannelConsentRequired"
    );
  });

  it("does not allow the same wallet to initialize twice", async () => {
    const globalConfigPda = findGlobalConfigPda();
    const participant = await createTestParticipant();
    const globalConfigBefore = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    const participantBefore = await fetchParticipant(participant.wallet.publicKey);
    const nextParticipantId = Number(globalConfigBefore.nextParticipantId);
    const participantBucket = findParticipantBucketPdaById(nextParticipantId);
    const ownerIndexBucket = findOwnerIndexBucketPda(
      participant.wallet.publicKey
    );

    await expectProgramError(
      () =>
        program.methods
          .initializeParticipant(
            participantBucketIdForParticipantId(nextParticipantId),
            ownerIndexBucketIdForOwner(participant.wallet.publicKey)
          )
          .accounts({
            globalConfig: globalConfigPda,
            participantBucket,
            ownerIndexBucket,
            owner: participant.wallet.publicKey,
            feeRecipient: feeRecipient.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "OwnerAlreadyRegistered"
    );

    const globalConfigAfter = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    const participantAfter = await fetchParticipant(participant.wallet.publicKey);

    expect(globalConfigAfter.nextParticipantId).to.equal(
      globalConfigBefore.nextParticipantId
    );
    expect(participantAfter.participantId).to.equal(
      participantBefore.participantId
    );
    expect(participantAfter.owner.toString()).to.equal(
      participantBefore.owner.toString()
    );
    expect(participantAfter.inboundChannelPolicy).to.equal(
      participantBefore.inboundChannelPolicy
    );
  });

  it("rejects invalid inbound channel policy enum values", async () => {
    const participant = await createTestParticipant();

    await expectProgramError(
      () =>
        program.methods
          .updateInboundChannelPolicy(99)
          .accounts({
            participantBucket: participant.participantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(participant.wallet.publicKey),
            owner: participant.wallet.publicKey,
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "InvalidInboundChannelPolicy"
    );
  });

  it("should register participant with non-zero fee", async () => {
    const globalConfigPda = findGlobalConfigPda();
    const user5 = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        user5.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );
    const registrationFee = 1_000_000;
    await program.methods
      .updateConfig(null, null, null, new anchor.BN(registrationFee))
      .accounts({
        authority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();

    const globalConfigBefore = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    const participantId = Number(globalConfigBefore.nextParticipantId);
    const participantBucket = findParticipantBucketPdaById(participantId);
    const ownerIndexBucket = findOwnerIndexBucketPda(user5.publicKey);
    const user5BalBefore = await provider.connection.getBalance(
      user5.publicKey
    );
    const feeRecipientBalBefore = await provider.connection.getBalance(
      feeRecipient.publicKey
    );
    await program.methods
      .initializeParticipant(
        participantBucketIdForParticipantId(participantId),
        ownerIndexBucketIdForOwner(user5.publicKey)
      )
      .accounts({
        globalConfig: globalConfigPda,
        participantBucket,
        ownerIndexBucket,
        owner: user5.publicKey,
        feeRecipient: feeRecipient.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([user5])
      .rpc();
    const user5BalAfter = await provider.connection.getBalance(user5.publicKey);
    const feeRecipientBalAfter = await provider.connection.getBalance(
      feeRecipient.publicKey
    );
    expect(user5BalBefore - user5BalAfter).to.be.at.least(registrationFee);
    expect(feeRecipientBalAfter - feeRecipientBalBefore).to.equal(
      registrationFee,
      "Fee recipient must receive registration fee"
    );

    await program.methods
      .updateConfig(null, null, null, new anchor.BN(0))
      .accounts({
        authority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();
  });
});
