import * as anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  channelBucketIdForPair,
  createCommitmentMessage,
  createFundedTokenAccount,
  createTestParticipant,
  depositParticipantBalance,
  ensureChannel,
  expectProgramError,
  findGlobalConfigPda,
  findOwnerIndexBucketPda,
  findTokenRegistryPda,
  findVaultTokenAccountPda,
  getCanonicalChannelParticipants,
  knownParticipantId,
  lockChannelFundsForTest,
  participantBucketMetasForOwners,
  primaryMint,
  program,
  requestUnlockChannelFundsForTest,
  settleIndividualForTest,
  user1,
  user1TokenAccount,
  user2,
  user3,
  user4,
  deployer,
  feeRecipientTokenAccount,
  findParticipantPda,
} from "./shared/setup";

describe("Negative tests - expect specific errors", () => {
  it("update_config: rejects InvalidFeeBps bounds and non-authority", async () => {
    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, null, 2, null)
          .accounts({
            globalConfig: findGlobalConfigPda(),
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidFeeBps"
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, null, 31, null)
          .accounts({
            globalConfig: findGlobalConfigPda(),
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidFeeBps"
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, null, 20, null)
          .accounts({
            globalConfig: findGlobalConfigPda(),
            authority: user1.publicKey,
          } as any)
          .signers([user1])
          .rpc(),
      "ConstraintHasOne"
    );
  });

  it("deposit: rejects AmountMustBePositive", async () => {
    await expectProgramError(
      () =>
        program.methods
          .deposit(1, new anchor.BN(0))
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            owner: user1.publicKey,
            participantBucket: findParticipantPda(user1.publicKey),
            ownerIndexBucket: findOwnerIndexBucketPda(user1.publicKey),
            ownerTokenAccount: user1TokenAccount,
            vaultTokenAccount: findVaultTokenAccountPda(1),
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([user1])
          .rpc(),
      "AmountMustBePositive"
    );
  });

  it("deposit_for: rejects length mismatch, invalid accounts, and zero amounts", async () => {
    await expectProgramError(
      () =>
        program.methods
          .depositFor(
            1,
            [knownParticipantId(user1.publicKey), knownParticipantId(user2.publicKey)],
            [new anchor.BN(10_000_000)]
          )
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            funderTokenAccount: user1TokenAccount,
            vaultTokenAccount: findVaultTokenAccountPda(1),
            funder: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .remainingAccounts(
            participantBucketMetasForOwners([user1.publicKey, user2.publicKey])
          )
          .signers([user1])
          .rpc(),
      "InvalidDepositFor"
    );

    await expectProgramError(
      () =>
        program.methods
          .depositFor(
            1,
            [knownParticipantId(user1.publicKey)],
            [new anchor.BN(10_000_000)]
          )
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            funderTokenAccount: user1TokenAccount,
            vaultTokenAccount: findVaultTokenAccountPda(1),
            funder: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .remainingAccounts([
            {
              pubkey: anchor.web3.Keypair.generate().publicKey,
              isSigner: false,
              isWritable: true,
            },
          ])
          .signers([user1])
          .rpc(),
      "ParticipantNotFound"
    );

    await expectProgramError(
      () =>
        program.methods
          .depositFor(
            1,
            [knownParticipantId(user1.publicKey)],
            [new anchor.BN(0)]
          )
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            funderTokenAccount: user1TokenAccount,
            vaultTokenAccount: findVaultTokenAccountPda(1),
            funder: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .remainingAccounts(participantBucketMetasForOwners([user1.publicKey]))
          .signers([user1])
          .rpc(),
      "AmountMustBePositive"
    );
  });

  it("request_withdrawal: rejects zero amounts, duplicate pending withdrawals, and bad destinations", async () => {
    const participantPda = findParticipantPda(user1.publicKey);

    const requestWithdrawal = (amount: number, destination: PublicKey) =>
      program.methods
        .requestWithdrawal(1, new anchor.BN(amount), destination)
        .accounts({
          tokenRegistry: findTokenRegistryPda(),
          globalConfig: findGlobalConfigPda(),
          participantBucket: participantPda,
          ownerIndexBucket: findOwnerIndexBucketPda(user1.publicKey),
          owner: user1.publicKey,
          withdrawalDestination: destination,
        } as any)
        .signers([user1])
        .rpc();

    await expectProgramError(
      () => requestWithdrawal(0, user1TokenAccount),
      "AmountMustBePositive"
    );

    await requestWithdrawal(1_000_000, user1TokenAccount);
    await expectProgramError(
      () => requestWithdrawal(500_000, user1TokenAccount),
      "WithdrawalAlreadyPending"
    );

    await program.methods
      .cancelWithdrawal(1)
      .accounts({
        participantBucket: participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(user1.publicKey),
        owner: user1.publicKey,
      } as any)
      .signers([user1])
      .rpc();

    await expectProgramError(
      () => requestWithdrawal(1_000_000, user2.publicKey),
      "AccountOwnedByWrongProgram"
    );
  });

  it("create_channel: rejects ChannelAlreadyExists", async () => {
    const ensured = await ensureChannel(user3, user4.publicKey, 1);
    const { lowerParticipantId, higherParticipantId } =
      getCanonicalChannelParticipants(
        ensured.payerParticipant.participantId,
        ensured.payeeParticipant.participantId
      );

    await expectProgramError(
      () =>
        program.methods
          .createChannel(
            1,
            lowerParticipantId,
            higherParticipantId,
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
            owner: user3.publicKey,
            payerBucket: ensured.payerParticipantPda,
            payeeBucket: ensured.payeeParticipantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(user3.publicKey),
            payeeOwner: user4.publicKey,
            channelBucket: ensured.channelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([user3, user4])
          .rpc(),
      "ChannelAlreadyExists"
    );
  });

  it("channel unlock lifecycle rejects invalid pending-unlock states", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

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
      "NoChannelUnlockPending"
    );

    await expectProgramError(
      () =>
        program.methods
          .requestUnlockChannelFunds(
            1,
            ensured.payeeParticipant.participantId,
            new anchor.BN(0)
          )
          .accounts({
            globalConfig: findGlobalConfigPda(),
            channelBucket: ensured.channelPda,
            ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "AmountMustBePositive"
    );

    await expectProgramError(
      () =>
        program.methods
          .requestUnlockChannelFunds(
            1,
            ensured.payeeParticipant.participantId,
            new anchor.BN(1)
          )
          .accounts({
            globalConfig: findGlobalConfigPda(),
            channelBucket: ensured.channelPda,
            ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "InsufficientLockedBalance"
    );
  });

  it("execute_unlock_channel_funds rejects WithdrawalLocked before the timelock", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);
    const ownerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      1_000_000
    );

    await depositParticipantBalance({
      owner: payer.wallet,
      participantPda: ensured.payerParticipantPda,
      ownerTokenAccount,
      tokenId: 1,
      amount: 200_000,
    });
    await lockChannelFundsForTest(ensured, 100_000, payer.wallet);
    await requestUnlockChannelFundsForTest(ensured, 1, payer.wallet);

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
  });

  it("channel signer rotation rejects invalid or missing pending updates", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const requestSignerUpdate = (newSigner: PublicKey) =>
      program.methods
        .requestUpdateChannelAuthorizedSigner(
          1,
          ensured.payeeParticipant.participantId,
          newSigner
        )
        .accounts({
          globalConfig: findGlobalConfigPda(),
          channelBucket: ensured.channelPda,
          ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
          owner: payer.wallet.publicKey,
        } as any)
        .signers([payer.wallet])
        .rpc();

    await expectProgramError(
      () => requestSignerUpdate(PublicKey.default),
      "InvalidAuthorizedSigner"
    );
    await expectProgramError(
      () => requestSignerUpdate(ensured.channel.authorizedSigner),
      "InvalidAuthorizedSigner"
    );

    await expectProgramError(
      () =>
        program.methods
          .executeUpdateChannelAuthorizedSigner(
            1,
            ensured.payeeParticipant.participantId
          )
          .accounts({
            globalConfig: findGlobalConfigPda(),
            channelBucket: ensured.channelPda,
            ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "NoAuthorizedSignerUpdatePending"
    );
  });

  it("update_config: rejects invalid authorities, fee recipients, and registration fees", async () => {
    await expectProgramError(
      () =>
        program.methods
          .updateConfig(PublicKey.default, null, null, null)
          .accounts({ authority: deployer.publicKey } as any)
          .signers([deployer])
          .rpc(),
      "InvalidAuthority"
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, PublicKey.default, null, null)
          .accounts({ authority: deployer.publicKey } as any)
          .signers([deployer])
          .rpc(),
      "InvalidFeeRecipient"
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, feeRecipientTokenAccount, null, null)
          .accounts({ authority: deployer.publicKey } as any)
          .remainingAccounts([
            {
              pubkey: feeRecipientTokenAccount,
              isSigner: false,
              isWritable: false,
            },
          ])
          .signers([deployer])
          .rpc(),
      "InvalidFeeRecipient"
    );

    await expectProgramError(
      () =>
        program.methods
          .updateConfig(null, null, null, new anchor.BN(11_000_000))
          .accounts({ authority: deployer.publicKey } as any)
          .signers([deployer])
          .rpc(),
      "InvalidRegistrationFee"
    );
  });

  it("settle_individual rejects malformed messages and invalid accounting", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const basePayload = {
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      tokenId: 1,
    };

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: Buffer.concat([
            createCommitmentMessage({
              ...basePayload,
              committedAmount: new anchor.BN(2_000_000),
            }),
            Buffer.from([0x01, 0x02]),
          ]),
          signer: payer.wallet,
          submitter: payee.wallet,
        }),
      "InvalidCommitmentMessage"
    );

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: createCommitmentMessage({
            ...basePayload,
            committedAmount: new anchor.BN(2_000_000),
            messageDomain: Buffer.alloc(16, 9),
          }),
          signer: payer.wallet,
          submitter: payee.wallet,
        }),
      "InvalidMessageDomain"
    );

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: createCommitmentMessage({
            ...basePayload,
            committedAmount: new anchor.BN(0),
          }),
          signer: payer.wallet,
          submitter: payee.wallet,
        }),
      "CommitmentAmountMustIncrease"
    );

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: createCommitmentMessage({
            ...basePayload,
            committedAmount: new anchor.BN(100_000_000),
          }),
          signer: payer.wallet,
          submitter: payee.wallet,
        }),
      "InsufficientBalance"
    );
  });

  it("lock_channel_funds rejects zero amount and insufficient balance", async () => {
    const ensured = await ensureChannel(user1, user2.publicKey, 1);

    const lockFunds = (amount: number) =>
      program.methods
        .lockChannelFunds(
          1,
          ensured.payeeParticipant.participantId,
          new anchor.BN(amount)
        )
        .accounts({
          tokenRegistry: findTokenRegistryPda(),
          channelBucket: ensured.channelPda,
          payerBucket: ensured.payerParticipantPda,
          ownerIndexBucket: findOwnerIndexBucketPda(user1.publicKey),
          owner: user1.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([user1])
        .rpc();

    await expectProgramError(() => lockFunds(0), "AmountMustBePositive");
    await expectProgramError(() => lockFunds(1_000_000_000_000), "InsufficientBalance");
  });
});
