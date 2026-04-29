import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

import {
  channelBucketIdForPair,
  cooperativeUnlockChannelFundsForTest,
  createCommitmentMessage,
  createFundedTokenAccount,
  createTestParticipant,
  depositParticipantBalance,
  ensureChannel,
  executeChannelSignerUpdateForTest,
  executeUnlockChannelFundsForTest,
  expectProgramError,
  fetchParticipant,
  findChannelPda,
  findGlobalConfigPda,
  findOwnerIndexBucketPda,
  findTokenRegistryPda,
  getTokenBalance,
  INBOUND_CHANNEL_POLICY,
  lockChannelFundsForTest,
  nextCommitmentAmount,
  primaryMint,
  program,
  refetchDirectionalChannel,
  registerTestToken,
  requestChannelSignerUpdateForTest,
  requestUnlockChannelFundsForTest,
  settleIndividualForTest,
  sleep,
} from "./shared/setup";

const SECOND_CHANNEL_TOKEN_ID = 13;

async function depositToParticipant(
  owner: anchor.web3.Keypair,
  participantPda: PublicKey,
  ownerTokenAccount: PublicKey,
  tokenId: number,
  amount: number
) {
  await depositParticipantBalance({
    owner,
    participantPda,
    ownerTokenAccount,
    tokenId,
    amount,
  });
}

describe("Permanent Channel Lifecycle", () => {
  it("stores a custom authorized signer when creating a channel", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const delegatedSigner = anchor.web3.Keypair.generate();

    const { channel } = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1,
      {
        authorizedSigner: delegatedSigner.publicKey,
        payeeOwnerSigner: payee.wallet,
      }
    );

    expect(channel.authorizedSigner.toString()).to.equal(
      delegatedSigner.publicKey.toString()
    );
  });

  it("rejects self-channels for the same participant", async () => {
    const participant = await createTestParticipant();
    const channelPda = findChannelPda(
      participant.participant.participantId,
      participant.participant.participantId,
      1
    );

    await expectProgramError(
      () =>
        program.methods
          .createChannel(
            1,
            participant.participant.participantId,
            participant.participant.participantId,
            new anchor.BN(0),
            null
          )
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            owner: participant.wallet.publicKey,
            payerBucket: participant.participantPda,
            payeeBucket: participant.participantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(participant.wallet.publicKey),
            payeeOwner: null,
            channelBucket: channelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "SelfChannelNotAllowed"
    );
  });

  it("rejects duplicate channel creation for the same payer, payee, and token", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1,
      { payeeOwnerSigner: payee.wallet }
    );

    await expectProgramError(
      () =>
        program.methods
          .createChannel(
            1,
            ensured.lowerParticipantId,
            ensured.higherParticipantId,
            new anchor.BN(
              channelBucketIdForPair(
                ensured.payerParticipant.participantId,
                ensured.payeeParticipant.participantId
              )
            ),
            null
          )
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            owner: payer.wallet.publicKey,
            payerBucket: ensured.payerParticipantPda,
            payeeBucket: ensured.payeeParticipantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
            payeeOwner: payee.wallet.publicKey,
            channelBucket: ensured.channelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([payer.wallet, payee.wallet])
          .rpc(),
      "ChannelAlreadyExists"
    );
  });

  it("creates distinct permanent channels per token for the same payer and payee", async () => {
    await registerTestToken(SECOND_CHANNEL_TOKEN_ID, "EURC");
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();

    const firstChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1
    );

    const secondChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      SECOND_CHANNEL_TOKEN_ID
    );

    expect(firstChannel.channelPda.toString()).to.not.equal(
      secondChannel.channelPda.toString()
    );
    expect(secondChannel.channel.tokenId).to.equal(SECOND_CHANNEL_TOKEN_ID);
  });

  it("lock_channel_funds remains additive", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_500_000
    );

    await lockChannelFundsForTest(ensured, 200_000, payer.wallet);
    await lockChannelFundsForTest(ensured, 150_000, payer.wallet);

    const channel = await refetchDirectionalChannel(ensured);
    expect(channel.lockedBalance.toNumber()).to.equal(350_000);
  });

  it("lock_channel_funds rejects a token id that does not match the channel", async () => {
    await registerTestToken(SECOND_CHANNEL_TOKEN_ID, "EURC");
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const primaryTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const secondChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      SECOND_CHANNEL_TOKEN_ID,
      { payeeOwnerSigner: payee.wallet }
    );

    await depositToParticipant(
      payer.wallet,
      secondChannel.payerParticipantPda,
      primaryTokenAccount,
      1,
      1_000_000
    );

    await expectProgramError(
      () =>
        program.methods
          .lockChannelFunds(
            1,
            secondChannel.payeeParticipant.participantId,
            new anchor.BN(100_000)
          )
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            payerBucket: secondChannel.payerParticipantPda,
            channelBucket: secondChannel.channelPda,
            ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
            owner: payer.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "InvalidTokenMint"
    );
  });

  it("request_unlock_channel_funds rejects non-owners", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const outsider = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_000_000
    );
    await lockChannelFundsForTest(ensured, 300_000, payer.wallet);

    await expectProgramError(
      () =>
        program.methods
          .requestUnlockChannelFunds(
            1,
            ensured.payeeParticipant.participantId,
            new anchor.BN(100_000)
          )
          .accounts({
            globalConfig: findGlobalConfigPda(),
            channelBucket: ensured.channelPda,
            ownerIndexBucket: findOwnerIndexBucketPda(outsider.wallet.publicKey),
            owner: outsider.wallet.publicKey,
          } as any)
          .signers([outsider.wallet])
          .rpc(),
      "BucketAccountMismatch"
    );
  });

  it("request_unlock_channel_funds overwrites the previous request and resets the timer", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_000_000
    );
    await lockChannelFundsForTest(ensured, 400_000, payer.wallet);
    await requestUnlockChannelFundsForTest(ensured, 100_000, payer.wallet);

    const afterFirst = await refetchDirectionalChannel(ensured);
    await sleep(1200);

    await requestUnlockChannelFundsForTest(ensured, 250_000, payer.wallet);

    const afterSecond = await refetchDirectionalChannel(ensured);
    expect(afterSecond.pendingUnlockAmount.toNumber()).to.equal(250_000);
    expect(afterSecond.unlockRequestedAt.toNumber()).to.be.greaterThan(
      afterFirst.unlockRequestedAt.toNumber()
    );
  });

  it("execute_unlock_channel_funds enforces the timelock and releases partial collateral", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_500_000
    );
    await lockChannelFundsForTest(ensured, 500_000, payer.wallet);
    await requestUnlockChannelFundsForTest(ensured, 200_000, payer.wallet);

    await expectProgramError(
      () =>
        program.methods
          .executeUnlockChannelFunds(1, ensured.payeeParticipant.participantId)
          .accounts({
            globalConfig: findGlobalConfigPda(),
            payerBucket: ensured.payerParticipantPda,
            channelBucket: ensured.channelPda,
            ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "WithdrawalLocked"
    );

    const payerBeforeUnlock = await fetchParticipant(payer.wallet.publicKey);

    await sleep(2500);

    await executeUnlockChannelFundsForTest(ensured, payer.wallet);

    const payerAfterUnlock = await fetchParticipant(payer.wallet.publicKey);
    const channelAfterUnlock = await refetchDirectionalChannel(ensured);

    expect(
      getTokenBalance(payerAfterUnlock, 1).availableBalance.toNumber() -
        getTokenBalance(payerBeforeUnlock, 1).availableBalance.toNumber()
    ).to.equal(200_000);
    expect(channelAfterUnlock.lockedBalance.toNumber()).to.equal(300_000);
    expect(channelAfterUnlock.pendingUnlockAmount.toNumber()).to.equal(0);
    expect(channelAfterUnlock.unlockRequestedAt.toNumber()).to.equal(0);
  });

  it("cooperative_unlock_channel_funds releases collateral immediately with payee consent", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_500_000
    );
    await lockChannelFundsForTest(ensured, 500_000, payer.wallet);

    const payerBeforeUnlock = await fetchParticipant(payer.wallet.publicKey);
    await cooperativeUnlockChannelFundsForTest(
      ensured,
      200_000,
      payer.wallet,
      payee.wallet
    );

    const payerAfterUnlock = await fetchParticipant(payer.wallet.publicKey);
    const channelAfterUnlock = await refetchDirectionalChannel(ensured);
    expect(
      getTokenBalance(payerAfterUnlock, 1).availableBalance.toNumber() -
        getTokenBalance(payerBeforeUnlock, 1).availableBalance.toNumber()
    ).to.equal(200_000);
    expect(channelAfterUnlock.lockedBalance.toNumber()).to.equal(300_000);
    expect(channelAfterUnlock.pendingUnlockAmount.toNumber()).to.equal(0);
    expect(channelAfterUnlock.unlockRequestedAt.toNumber()).to.equal(0);
  });

  it("cooperative_unlock_channel_funds requires the payee owner signer", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const outsider = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_000_000
    );
    await lockChannelFundsForTest(ensured, 300_000, payer.wallet);

    await expectProgramError(
      () =>
        (program.methods as any)
          .cooperativeUnlockChannelFunds(
            1,
            ensured.payeeParticipant.participantId,
            new anchor.BN(100_000)
          )
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            payerBucket: ensured.payerParticipantPda,
            payeeBucket: ensured.payeeParticipantPda,
            channelBucket: ensured.channelPda,
            ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
            owner: payer.wallet.publicKey,
            payeeOwner: outsider.wallet.publicKey,
          } as any)
          .signers([payer.wallet, outsider.wallet])
          .rpc(),
      "CounterpartyConsentRequired"
    );
  });

  it("fully drained pending unlock executes with zero release and clears pending state", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      3_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      payeeOwnerSigner: payee.wallet,
    });
    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      2_000_000
    );
    await lockChannelFundsForTest(ensured, 400_000, payer.wallet);
    await requestUnlockChannelFundsForTest(ensured, 250_000, payer.wallet);

    const drainMessage = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(ensured.channel, 400_000),
    });
    const payerBeforeExecute = await fetchParticipant(payer.wallet.publicKey);

    await settleIndividualForTest({
      ensured,
      message: drainMessage,
      signer: payer.wallet,
      submitter: payee.wallet,
    });

    await sleep(2500);

    await executeUnlockChannelFundsForTest(ensured, payer.wallet);

    const payerAfterExecute = await fetchParticipant(payer.wallet.publicKey);
    const channelAfterExecute = await refetchDirectionalChannel(ensured);

    expect(
      getTokenBalance(payerAfterExecute, 1).availableBalance.toNumber() -
        getTokenBalance(payerBeforeExecute, 1).availableBalance.toNumber()
    ).to.equal(0);
    expect(channelAfterExecute.lockedBalance.toNumber()).to.equal(0);
    expect(channelAfterExecute.pendingUnlockAmount.toNumber()).to.equal(0);
    expect(channelAfterExecute.unlockRequestedAt.toNumber()).to.equal(0);
  });

  it("rotates the authorized signer after the timelock and invalidates the old signer", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const oldSigner = anchor.web3.Keypair.generate();
    const newSigner = anchor.web3.Keypair.generate();
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      2_000_000
    );
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
      authorizedSigner: oldSigner.publicKey,
      payeeOwnerSigner: payee.wallet,
    });

    await depositToParticipant(
      payer.wallet,
      ensured.payerParticipantPda,
      ownerTokenAccount,
      1,
      1_500_000
    );

    await requestChannelSignerUpdateForTest(
      ensured,
      newSigner.publicKey,
      payer.wallet
    );

    const prematureNewSignerMessage = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(ensured.channel, 100_000),
    });

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: prematureNewSignerMessage,
          signer: newSigner,
          submitter: payee.wallet,
        }),
      "InvalidSignature"
    );

    await expectProgramError(
      () =>
        executeChannelSignerUpdateForTest(ensured, payer.wallet),
      "WithdrawalLocked"
    );

    const oldSignerMessage = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(ensured.channel, 100_000),
    });

    await settleIndividualForTest({
      ensured,
      message: oldSignerMessage,
      signer: oldSigner,
      submitter: payee.wallet,
    });

    await sleep(2500);

    await executeChannelSignerUpdateForTest(ensured, payer.wallet);

    const rotatedChannel = await refetchDirectionalChannel(ensured);
    expect(rotatedChannel.authorizedSigner.toString()).to.equal(
      newSigner.publicKey.toString()
    );
    expect(rotatedChannel.pendingAuthorizedSigner.toString()).to.equal(
      PublicKey.default.toString()
    );

    const postRotationAmount = nextCommitmentAmount(rotatedChannel, 100_000);

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: createCommitmentMessage({
            payerId: rotatedChannel.payerId,
            payeeId: rotatedChannel.payeeId,
            tokenId: 1,
            committedAmount: postRotationAmount,
          }),
          signer: oldSigner,
          submitter: payee.wallet,
        }),
      "InvalidSignature"
    );

    await settleIndividualForTest({
      ensured,
      message: createCommitmentMessage({
        payerId: rotatedChannel.payerId,
        payeeId: rotatedChannel.payeeId,
        tokenId: 1,
        committedAmount: postRotationAmount,
      }),
      signer: newSigner,
      submitter: payee.wallet,
    });
  });

  it("respects inbound consent policies when creating permanent channels", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();

    await expectProgramError(
      () =>
        ensureChannel(payer.wallet, payee.wallet.publicKey, 1, {
          skipAutoPayeeOwnerSigner: true,
        }),
      "InboundChannelConsentRequired"
    );

    await program.methods
      .updateInboundChannelPolicy(INBOUND_CHANNEL_POLICY.Permissionless)
      .accounts({
        participantBucket: payee.participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(payee.wallet.publicKey),
        owner: payee.wallet.publicKey,
      } as any)
      .signers([payee.wallet])
      .rpc();

    const permissionlessChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1,
      { skipAutoPayeeOwnerSigner: true }
    );
    expect(permissionlessChannel.channel.payerId).to.equal(
      permissionlessChannel.payerParticipant.participantId
    );

    const payee2 = await createTestParticipant();
    await program.methods
      .updateInboundChannelPolicy(INBOUND_CHANNEL_POLICY.Disabled)
      .accounts({
        participantBucket: payee2.participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(payee2.wallet.publicKey),
        owner: payee2.wallet.publicKey,
      } as any)
      .signers([payee2.wallet])
      .rpc();

    await expectProgramError(
      () =>
        ensureChannel(payer.wallet, payee2.wallet.publicKey, 1, {
          skipAutoPayeeOwnerSigner: true,
        }),
      "InboundChannelsDisabled"
    );
  });
});
