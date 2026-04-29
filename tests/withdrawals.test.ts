import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { expect } from "chai";
import {
  program,
  provider,
  primaryMint,
  user1,
  user1TokenAccount,
  feeRecipientTokenAccount,
  depositParticipantBalance,
  fetchParticipant,
  findGlobalConfigPda,
  findOwnerIndexBucketPda,
  findParticipantPda,
  findTokenRegistryPda,
  findVaultTokenAccountPda,
  getTokenBalance,
  knownParticipantId,
  registerTestToken,
  createFundedTokenAccount,
  getFeeRecipientTokenAccount,
  createTestParticipant,
  ensureChannel,
  createCommitmentMessage,
  expectProgramError,
  participantBucketMetasForOwners,
  settleIndividualForTest,
} from "./shared/setup";

const SECOND_WITHDRAWAL_TOKEN_ID = 12;

describe("Withdrawal", () => {
  it("should request withdrawal", async () => {
    const participantPda = findParticipantPda(user1.publicKey);
    const withdrawAmount = 5_000_000; // 5 primary-token units

    await program.methods
      .requestWithdrawal(1, new anchor.BN(withdrawAmount), user1TokenAccount) // token_id = 1
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        owner: user1.publicKey,
        participantBucket: participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(user1.publicKey),
        withdrawalDestination: user1TokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    const participant = await fetchParticipant(user1.publicKey);
    const primaryTokenBalance = getTokenBalance(participant, 1);
    expect(primaryTokenBalance.withdrawingBalance.toNumber()).to.equal(withdrawAmount);
    expect(primaryTokenBalance.withdrawalUnlockAt.toNumber()).to.be.greaterThan(0);
    expect(primaryTokenBalance.withdrawalDestination.toString()).to.equal(
      user1TokenAccount.toString()
    );
  });

  it("should make requested withdrawals executable immediately", async () => {
    const participant = await fetchParticipant(user1.publicKey);
    const primaryTokenBalance = getTokenBalance(participant, 1);
    const now = Math.floor(Date.now() / 1000);

    expect(primaryTokenBalance.withdrawingBalance.toNumber()).to.be.greaterThan(0);
    expect(primaryTokenBalance.withdrawalUnlockAt.toNumber()).to.be.at.most(
      now + 5
    );
  });

  it("should cancel withdrawal", async () => {
    const participantPda = findParticipantPda(user1.publicKey);

    await program.methods
      .cancelWithdrawal(1) // token_id = 1 (primary token)
      .accounts({
        participantBucket: participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(user1.publicKey),
        owner: user1.publicKey,
      } as any)
      .signers([user1])
      .rpc();

    const participant = await fetchParticipant(user1.publicKey);
    const primaryTokenBalance = getTokenBalance(participant, 1);
    expect(primaryTokenBalance.withdrawingBalance.toNumber()).to.equal(0);
    expect(primaryTokenBalance.withdrawalUnlockAt.toNumber()).to.equal(0);
    expect(primaryTokenBalance.availableBalance.toNumber()).to.be.greaterThan(0);
  });

  it("should request withdrawal and execute immediately", async () => {
    const participantPda = findParticipantPda(user1.publicKey);
    const vaultTokenAccount = findVaultTokenAccountPda(1);
    const withdrawAmount = 10_000_000; // 10 primary-token units

    await program.methods
      .requestWithdrawal(1, new anchor.BN(withdrawAmount), user1TokenAccount) // token_id = 1
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        owner: user1.publicKey,
        participantBucket: participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(user1.publicKey),
        withdrawalDestination: user1TokenAccount,
      } as any)
      .signers([user1])
      .rpc();

    const user1BalanceBefore = (
      await getAccount(provider.connection, user1TokenAccount)
    ).amount;
    const feeRecipientBefore = (
      await getAccount(provider.connection, feeRecipientTokenAccount)
    ).amount;
    const vaultBefore = (
      await getAccount(provider.connection, vaultTokenAccount)
    ).amount;

    await program.methods
      .executeWithdrawalTimelocked(1, knownParticipantId(user1.publicKey)) // token_id = 1 (primary token)
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        participantBucket: participantPda,
        vaultTokenAccount,
        withdrawalDestination: user1TokenAccount,
        feeRecipientTokenAccount: feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const participant = await fetchParticipant(user1.publicKey);
    const primaryTokenBalance = getTokenBalance(participant, 1);
    expect(primaryTokenBalance.withdrawingBalance.toNumber()).to.equal(0);
    expect(primaryTokenBalance.withdrawalUnlockAt.toNumber()).to.equal(0);

    const user1BalanceAfter = (
      await getAccount(provider.connection, user1TokenAccount)
    ).amount;
    const feeRecipientAfter = (
      await getAccount(provider.connection, feeRecipientTokenAccount)
    ).amount;
    const vaultAfter = (
      await getAccount(provider.connection, vaultTokenAccount)
    ).amount;

    const netReceived = Number(user1BalanceAfter - user1BalanceBefore);
    const feeReceived = Number(feeRecipientAfter - feeRecipientBefore);
    const vaultDecrease = Number(vaultBefore - vaultAfter);

    // Fee = max(minimum floor, percentage fee) = 50_000 for this withdrawal
    const expectedFee = 50_000;
    const expectedNet = withdrawAmount - expectedFee;
    expect(
      netReceived,
      "Net received must match withdrawAmount - fee"
    ).to.equal(expectedNet);
    expect(feeReceived, "Fee must respect the minimum floor").to.equal(expectedFee);
    expect(vaultDecrease).to.equal(
      netReceived + feeReceived,
      "Vault must decrease by net + fee"
    );
  });

  it("should execute a withdrawal for a second allowlisted token", async () => {
    const secondToken = await registerTestToken(SECOND_WITHDRAWAL_TOKEN_ID, "PYUSD");
    const participantPda = findParticipantPda(user1.publicKey);
    const vaultTokenAccount = findVaultTokenAccountPda(SECOND_WITHDRAWAL_TOKEN_ID);
    const destination = await createFundedTokenAccount(
      user1,
      secondToken.mint,
      12_000_000
    );
    const withdrawAmount = 4_000_000;

    await depositParticipantBalance({
      owner: user1,
      participantPda,
      ownerTokenAccount: destination,
      tokenId: SECOND_WITHDRAWAL_TOKEN_ID,
      amount: 6_000_000,
    });

    await program.methods
      .requestWithdrawal(
        SECOND_WITHDRAWAL_TOKEN_ID,
        new anchor.BN(withdrawAmount),
        destination
      )
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        owner: user1.publicKey,
        participantBucket: participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(user1.publicKey),
        withdrawalDestination: destination,
      } as any)
      .signers([user1])
      .rpc();

    const destinationBefore = (await getAccount(provider.connection, destination)).amount;
    const feeRecipientBefore = (
      await getAccount(
        provider.connection,
        getFeeRecipientTokenAccount(SECOND_WITHDRAWAL_TOKEN_ID)
      )
    ).amount;
    const vaultBefore = (await getAccount(provider.connection, vaultTokenAccount)).amount;

    await program.methods
      .executeWithdrawalTimelocked(
        SECOND_WITHDRAWAL_TOKEN_ID,
        knownParticipantId(user1.publicKey)
      )
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        participantBucket: participantPda,
        vaultTokenAccount,
        withdrawalDestination: destination,
        feeRecipientTokenAccount: getFeeRecipientTokenAccount(
          SECOND_WITHDRAWAL_TOKEN_ID
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const participant = await fetchParticipant(user1.publicKey);
    const secondTokenBalance = getTokenBalance(
      participant,
      SECOND_WITHDRAWAL_TOKEN_ID
    );
    const destinationAfter = (await getAccount(provider.connection, destination)).amount;
    const feeRecipientAfter = (
      await getAccount(
        provider.connection,
        getFeeRecipientTokenAccount(SECOND_WITHDRAWAL_TOKEN_ID)
      )
    ).amount;
    const vaultAfter = (await getAccount(provider.connection, vaultTokenAccount)).amount;

    expect(secondTokenBalance.withdrawingBalance.toNumber()).to.equal(0);
    expect(secondTokenBalance.withdrawalUnlockAt.toNumber()).to.equal(0);
    expect(Number(destinationAfter - destinationBefore)).to.equal(3_950_000);
    expect(Number(feeRecipientAfter - feeRecipientBefore)).to.equal(50_000);
    expect(Number(vaultBefore - vaultAfter)).to.equal(4_000_000);
  });

  it("deposit rejects token accounts whose mint does not match the requested token id", async () => {
    const participant = await createTestParticipant();
    const secondToken = await registerTestToken(SECOND_WITHDRAWAL_TOKEN_ID, "PYUSD");
    const wrongMintAccount = await createFundedTokenAccount(
      participant.wallet,
      secondToken.mint,
      2_000_000
    );

    await expectProgramError(
      () =>
        program.methods
          .deposit(1, new anchor.BN(1_000_000))
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            owner: participant.wallet.publicKey,
            participantBucket: participant.participantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(participant.wallet.publicKey),
            ownerTokenAccount: wrongMintAccount,
            vaultTokenAccount: findVaultTokenAccountPda(1),
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "InvalidTokenMint"
    );
  });

  it("deposit_for rejects funder token accounts whose mint does not match the requested token id", async () => {
    const participant = await createTestParticipant();
    const secondToken = await registerTestToken(SECOND_WITHDRAWAL_TOKEN_ID, "PYUSD");
    const wrongMintAccount = await createFundedTokenAccount(
      participant.wallet,
      secondToken.mint,
      2_000_000
    );

    await expectProgramError(
      () =>
        program.methods
          .depositFor(
            1,
            [participant.participant.participantId],
            [new anchor.BN(1_000_000)]
          )
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            funderTokenAccount: wrongMintAccount,
            vaultTokenAccount: findVaultTokenAccountPda(1),
            funder: participant.wallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .remainingAccounts(
            participantBucketMetasForOwners([participant.wallet.publicKey])
          )
          .signers([participant.wallet])
          .rpc(),
      "InvalidTokenMint"
    );
  });

  it("request_withdrawal rejects destination token accounts whose mint does not match the requested token id", async () => {
    const participant = await createTestParticipant();
    const tokenAccount = await createFundedTokenAccount(
      participant.wallet,
      primaryMint,
      3_000_000
    );
    const secondToken = await registerTestToken(SECOND_WITHDRAWAL_TOKEN_ID, "PYUSD");
    const wrongDestination = await createFundedTokenAccount(
      participant.wallet,
      secondToken.mint,
      0
    );

    await depositParticipantBalance({
      owner: participant.wallet,
      participantPda: participant.participantPda,
      ownerTokenAccount: tokenAccount,
      tokenId: 1,
      amount: 2_000_000,
    });

    await expectProgramError(
      () =>
        program.methods
          .requestWithdrawal(1, new anchor.BN(1_000_000), wrongDestination)
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            owner: participant.wallet.publicKey,
            participantBucket: participant.participantPda,
            ownerIndexBucket: findOwnerIndexBucketPda(participant.wallet.publicKey),
            withdrawalDestination: wrongDestination,
          } as any)
          .signers([participant.wallet])
          .rpc(),
      "InvalidTokenMint"
    );
  });

  it("clears a pending withdrawal with zero payout when settlement fully drains it during the timelock", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const payerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      primaryMint,
      4_000_000
    );
    const { channelPda, payerParticipantPda, payeeParticipantPda, channel } =
      await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);
    const withdrawAmount = 2_000_000;

    await depositParticipantBalance({
      owner: payer.wallet,
      participantPda: payerParticipantPda,
      ownerTokenAccount: payerTokenAccount,
      tokenId: 1,
      amount: withdrawAmount,
    });

    await program.methods
      .requestWithdrawal(1, new anchor.BN(withdrawAmount), payerTokenAccount)
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        owner: payer.wallet.publicKey,
        participantBucket: payerParticipantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
        withdrawalDestination: payerTokenAccount,
      } as any)
      .signers([payer.wallet])
      .rpc();

    const commitmentMessage = createCommitmentMessage({
      payerId: channel.payerId,
      payeeId: channel.payeeId,
      committedAmount: new anchor.BN(withdrawAmount),
      tokenId: 1,
    });
    await settleIndividualForTest({
      ensured: {
        channelPda,
        payerParticipantPda,
        payeeParticipantPda,
      } as any,
      message: commitmentMessage,
      signer: payer.wallet,
      submitter: payee.wallet,
    });

    const payerAfterSettlement = await fetchParticipant(payer.wallet.publicKey);
    const drainedBalance = getTokenBalance(payerAfterSettlement, 1);
    expect(drainedBalance.availableBalance.toNumber()).to.equal(0);
    expect(drainedBalance.withdrawingBalance.toNumber()).to.equal(0);
    expect(drainedBalance.withdrawalUnlockAt.toNumber()).to.be.greaterThan(0);

    const destinationBefore = (await getAccount(provider.connection, payerTokenAccount)).amount;
    const feeRecipientBefore = (
      await getAccount(provider.connection, feeRecipientTokenAccount)
    ).amount;
    const vaultBefore = (
      await getAccount(provider.connection, findVaultTokenAccountPda(1))
    ).amount;

    await program.methods
      .executeWithdrawalTimelocked(1, payer.participant.participantId)
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        participantBucket: payerParticipantPda,
        vaultTokenAccount: findVaultTokenAccountPda(1),
        withdrawalDestination: payerTokenAccount,
        feeRecipientTokenAccount: feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const destinationAfter = (await getAccount(provider.connection, payerTokenAccount)).amount;
    const feeRecipientAfter = (
      await getAccount(provider.connection, feeRecipientTokenAccount)
    ).amount;
    const vaultAfter = (
      await getAccount(provider.connection, findVaultTokenAccountPda(1))
    ).amount;
    const payerAfterExecution = await fetchParticipant(payer.wallet.publicKey);
    const clearedBalance = getTokenBalance(payerAfterExecution, 1);

    expect(Number(destinationAfter - destinationBefore)).to.equal(0);
    expect(Number(feeRecipientAfter - feeRecipientBefore)).to.equal(0);
    expect(Number(vaultBefore - vaultAfter)).to.equal(0);
    expect(clearedBalance.withdrawingBalance.toNumber()).to.equal(0);
    expect(clearedBalance.withdrawalUnlockAt.toNumber()).to.equal(0);
    expect(clearedBalance.withdrawalDestination.toString()).to.equal(
      PublicKey.default.toString()
    );
  });
});
