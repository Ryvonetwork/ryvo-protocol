import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";

import {
  bundleSettlementRemainingAccounts,
  createCommitmentMessage,
  createFundedTokenAccount,
  createMultiMessageEd25519Instruction,
  createTestParticipant,
  depositParticipantBalance,
  ensureChannel,
  expectProgramError,
  fetchParticipant,
  findGlobalConfigPda,
  findTokenRegistryPda,
  getTokenBalance,
  nextCommitmentAmount,
  primaryMint,
  program,
  settleIndividualForTest,
} from "./shared/setup";

type TestParticipant = Awaited<ReturnType<typeof createTestParticipant>>;

async function depositToVault(
  owner: Keypair,
  participantPda: PublicKey,
  ownerTokenAccount: PublicKey,
  tokenId: number,
  amount: number
): Promise<void> {
  await depositParticipantBalance({
    owner,
    participantPda,
    ownerTokenAccount,
    tokenId,
    amount,
  });
}

async function createPrimaryFundedParticipant(
  amount: number
): Promise<TestParticipant & { ownerTokenAccount: PublicKey }> {
  const participant = await createTestParticipant();
  const ownerTokenAccount = await createFundedTokenAccount(
    participant.wallet,
    primaryMint,
    amount
  );
  await depositToVault(
    participant.wallet,
    participant.participantPda,
    ownerTokenAccount,
    1,
    amount
  );
  return {
    ...participant,
    ownerTokenAccount,
  };
}

describe("Message v5", () => {
  it("settles an individual v5 commitment", async () => {
    const payer = await createPrimaryFundedParticipant(5_000_000);
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const message = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(ensured.channel, 1_250_000),
    });

    const payerBefore = await fetchParticipant(payer.wallet.publicKey);
    const payeeBefore = await fetchParticipant(payee.wallet.publicKey);

    await settleIndividualForTest({
      ensured,
      message,
      signer: payer.wallet,
      submitter: payee.wallet,
    });

    const payerAfter = await fetchParticipant(payer.wallet.publicKey);
    const payeeAfter = await fetchParticipant(payee.wallet.publicKey);

    expect(
      getTokenBalance(payerAfter, 1).availableBalance.toNumber() -
        getTokenBalance(payerBefore, 1).availableBalance.toNumber()
    ).to.equal(-1_250_000);
    expect(
      getTokenBalance(payeeAfter, 1).availableBalance.toNumber() -
        getTokenBalance(payeeBefore, 1).availableBalance.toNumber()
    ).to.equal(1_250_000);
  });

  it("settles a bundle of v5 commitments for one payee", async () => {
    const payee = await createTestParticipant();
    const payers = [
      await createPrimaryFundedParticipant(6_000_000),
      await createPrimaryFundedParticipant(6_000_000),
    ];
    const deltas = [1_000_000, 1_500_000];

    const channels = [];
    for (const payer of payers) {
      const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);
      channels.push({
        ...ensured,
        payer,
      });
    }

    const bundleEntries = channels.map((channelEntry, index) => ({
      signer: channelEntry.payer.wallet,
      message: createCommitmentMessage({
        payerId: channelEntry.channel.payerId,
        payeeId: channelEntry.channel.payeeId,
        tokenId: 1,
        committedAmount: nextCommitmentAmount(channelEntry.channel, deltas[index]),
      }),
    }));

    const payeeBefore = await fetchParticipant(payee.wallet.publicKey);

    await program.methods
      .settleCommitmentBundle(bundleEntries.length)
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        submitter: payee.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .remainingAccounts(
        bundleSettlementRemainingAccounts({
          payeeParticipantPda: payee.participantPda,
          payerParticipantPdas: channels.map(
            (channelEntry) => channelEntry.payerParticipantPda
          ),
          channelPdas: channels.map((channelEntry) => channelEntry.channelPda),
        })
      )
      .preInstructions([createMultiMessageEd25519Instruction(bundleEntries)])
      .signers([payee.wallet])
      .rpc();

    const payeeAfter = await fetchParticipant(payee.wallet.publicKey);
    expect(
      getTokenBalance(payeeAfter, 1).availableBalance.toNumber() -
        getTokenBalance(payeeBefore, 1).availableBalance.toNumber()
    ).to.equal(2_500_000);
  });

  it("rejects replaying a stale v5 commitment after the lane has already advanced", async () => {
    const payer = await createPrimaryFundedParticipant(5_000_000);
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const staleMessage = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      tokenId: 1,
      committedAmount: nextCommitmentAmount(ensured.channel, 1_000_000),
    });

    await settleIndividualForTest({
      ensured,
      message: staleMessage,
      signer: payer.wallet,
      submitter: payee.wallet,
    });

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: staleMessage,
          signer: payer.wallet,
          submitter: payee.wallet,
        }),
      "CommitmentAmountMustIncrease"
    );
  });
});
