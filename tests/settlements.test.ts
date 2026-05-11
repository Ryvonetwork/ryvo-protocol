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
  findParticipantPda,
  findTokenRegistryPda,
  getTokenBalance,
  nextCommitmentAmount,
  primaryMint,
  program,
  refetchDirectionalChannel,
  registerTestToken,
  settleIndividualForTest,
  user1,
  user1TokenAccount,
  user4,
} from "./shared/setup";

const SECOND_SETTLEMENT_TOKEN_ID = 14;

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

function availableDelta(after: any, before: any, tokenId: number): number {
  return (
    getTokenBalance(after, tokenId).availableBalance.toNumber() -
    getTokenBalance(before, tokenId).availableBalance.toNumber()
  );
}

describe("Settle Individual", () => {
  it("should settle individual commitment (user1->user4)", async () => {
    const ensured = await ensureChannel(user1, user4.publicKey, 1);

    await depositToVault(
      user1,
      ensured.payerParticipantPda,
      user1TokenAccount,
      1,
      3_000_000
    );

    const msg = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      committedAmount: nextCommitmentAmount(ensured.channel, 2_000_000),
      tokenId: 1,
    });

    const payerBefore = await fetchParticipant(user1.publicKey);
    const payeeBefore = await fetchParticipant(user4.publicKey);

    await settleIndividualForTest({
      ensured,
      message: msg,
      signer: user1,
      submitter: user4,
    });

    const payerAfter = await fetchParticipant(user1.publicKey);
    const payeeAfter = await fetchParticipant(user4.publicKey);

    expect(availableDelta(payerAfter, payerBefore, 1)).to.equal(-2_000_000);
    expect(availableDelta(payeeAfter, payeeBefore, 1)).to.equal(2_000_000);
  });

  it("should settle individual commitment for a second allowlisted token", async () => {
    const secondToken = await registerTestToken(
      SECOND_SETTLEMENT_TOKEN_ID,
      "USDT"
    );
    const payerParticipantPda = findParticipantPda(user1.publicKey);
    const payerSecondTokenAccount = await createFundedTokenAccount(
      user1,
      secondToken.mint,
      20_000_000
    );

    await depositToVault(
      user1,
      payerParticipantPda,
      payerSecondTokenAccount,
      SECOND_SETTLEMENT_TOKEN_ID,
      5_000_000
    );

    const ensured = await ensureChannel(
      user1,
      user4.publicKey,
      SECOND_SETTLEMENT_TOKEN_ID
    );

    const message = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      committedAmount: nextCommitmentAmount(ensured.channel, 1_500_000),
      tokenId: SECOND_SETTLEMENT_TOKEN_ID,
    });

    const payerBefore = await fetchParticipant(user1.publicKey);
    const payeeBefore = await fetchParticipant(user4.publicKey);

    await settleIndividualForTest({
      ensured,
      message,
      signer: user1,
      submitter: user4,
    });

    const payerAfter = await fetchParticipant(user1.publicKey);
    const payeeAfter = await fetchParticipant(user4.publicKey);

    expect(
      availableDelta(payerAfter, payerBefore, SECOND_SETTLEMENT_TOKEN_ID)
    ).to.equal(-1_500_000);
    expect(
      availableDelta(payeeAfter, payeeBefore, SECOND_SETTLEMENT_TOKEN_ID)
    ).to.equal(1_500_000);
  });

  it("should settle a higher cumulative commitment without intermediate checkpoints", async () => {
    const payer = await createPrimaryFundedParticipant(6_000_000);
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const firstMessage = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      committedAmount: nextCommitmentAmount(ensured.channel, 1_000_000),
      tokenId: 1,
    });

    await settleIndividualForTest({
      ensured,
      message: firstMessage,
      signer: payer.wallet,
      submitter: payee.wallet,
    });

    const channelAfterFirst = await refetchDirectionalChannel(ensured);
    const payerBeforeSecond = await fetchParticipant(payer.wallet.publicKey);
    const payeeBeforeSecond = await fetchParticipant(payee.wallet.publicKey);

    const secondTarget = nextCommitmentAmount(channelAfterFirst, 1_500_000);
    const secondMessage = createCommitmentMessage({
      payerId: channelAfterFirst.payerId,
      payeeId: channelAfterFirst.payeeId,
      committedAmount: secondTarget,
      tokenId: 1,
    });

    await settleIndividualForTest({
      ensured,
      message: secondMessage,
      signer: payer.wallet,
      submitter: payee.wallet,
    });

    const payerAfterSecond = await fetchParticipant(payer.wallet.publicKey);
    const payeeAfterSecond = await fetchParticipant(payee.wallet.publicKey);
    const channelAfterSecond = await refetchDirectionalChannel(ensured);

    expect(availableDelta(payerAfterSecond, payerBeforeSecond, 1)).to.equal(
      -1_500_000
    );
    expect(availableDelta(payeeAfterSecond, payeeBeforeSecond, 1)).to.equal(
      1_500_000
    );
    expect(channelAfterSecond.settledCumulative.toNumber()).to.equal(
      secondTarget.toNumber()
    );
  });

  it("should settle commitment bundle (many buyers -> one payee)", async () => {
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
        payer,
        ...ensured,
      });
    }

    const payeeBefore = await fetchParticipant(payee.wallet.publicKey);
    const payerBalancesBefore = await Promise.all(
      channels.map(({ payer }) => fetchParticipant(payer.wallet.publicKey))
    );

    const bundleEntries = channels.map(({ payer, channel }, index) => ({
      signer: payer.wallet,
      message: createCommitmentMessage({
        payerId: channel.payerId,
        payeeId: channel.payeeId,
        committedAmount: nextCommitmentAmount(channel, deltas[index]),
        tokenId: 1,
      }),
    }));

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
            ({ payerParticipantPda }) => payerParticipantPda
          ),
          channelPdas: channels.map(({ channelPda }) => channelPda),
        })
      )
      .preInstructions([createMultiMessageEd25519Instruction(bundleEntries)])
      .signers([payee.wallet])
      .rpc();

    const payeeAfter = await fetchParticipant(payee.wallet.publicKey);
    const payerBalancesAfter = await Promise.all(
      channels.map(({ payer }) => fetchParticipant(payer.wallet.publicKey))
    );
    const channelsAfter = await Promise.all(
      channels.map((channel) => refetchDirectionalChannel(channel))
    );

    expect(availableDelta(payeeAfter, payeeBefore, 1)).to.equal(
      deltas.reduce((sum, value) => sum + value, 0)
    );
    payerBalancesAfter.forEach((payerAfter, index) => {
      expect(
        availableDelta(payerAfter, payerBalancesBefore[index], 1)
      ).to.equal(-deltas[index]);
      expect(channelsAfter[index].settledCumulative.toNumber()).to.equal(
        deltas[index]
      );
    });
  });

  it("rejects bundle settlement when count does not match the signature count", async () => {
    const payee = await createTestParticipant();
    const payer = await createPrimaryFundedParticipant(4_000_000);
    const extraPayer = await createPrimaryFundedParticipant(4_000_000);
    const primaryChannel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      1
    );
    const extraChannel = await ensureChannel(
      extraPayer.wallet,
      payee.wallet.publicKey,
      1
    );

    const bundleEntries = [
      {
        signer: payer.wallet,
        message: createCommitmentMessage({
          payerId: primaryChannel.channel.payerId,
          payeeId: primaryChannel.channel.payeeId,
          committedAmount: nextCommitmentAmount(primaryChannel.channel, 500_000),
          tokenId: 1,
        }),
      },
      {
        signer: extraPayer.wallet,
        message: createCommitmentMessage({
          payerId: extraChannel.channel.payerId,
          payeeId: extraChannel.channel.payeeId,
          committedAmount: nextCommitmentAmount(extraChannel.channel, 750_000),
          tokenId: 1,
        }),
      },
    ];

    await expectProgramError(
      () =>
        program.methods
          .settleCommitmentBundle(1)
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            submitter: payee.wallet.publicKey,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .remainingAccounts(
            bundleSettlementRemainingAccounts({
              payeeParticipantPda: payee.participantPda,
              payerParticipantPdas: [primaryChannel.payerParticipantPda],
              channelPdas: [primaryChannel.channelPda],
            })
          )
          .preInstructions([createMultiMessageEd25519Instruction(bundleEntries)])
          .signers([payee.wallet])
          .rpc(),
      "InvalidCommitmentMessage"
    );
  });

  it("should pay an operator through a separate seller->operator lane", async () => {
    const buyer = await createPrimaryFundedParticipant(5_000_000);
    const seller = await createTestParticipant();
    const operator = await createTestParticipant();
    const buyerToSeller = await ensureChannel(
      buyer.wallet,
      seller.wallet.publicKey,
      1
    );
    const sellerToOperator = await ensureChannel(
      seller.wallet,
      operator.wallet.publicKey,
      1
    );

    const paymentAmount = 2_000_000;
    const operatorFee = 50_000;

    const buyerBefore = await fetchParticipant(buyer.wallet.publicKey);
    const sellerBefore = await fetchParticipant(seller.wallet.publicKey);
    const operatorBefore = await fetchParticipant(operator.wallet.publicKey);

    await settleIndividualForTest({
      ensured: buyerToSeller,
      message: createCommitmentMessage({
        payerId: buyerToSeller.channel.payerId,
        payeeId: buyerToSeller.channel.payeeId,
        committedAmount: nextCommitmentAmount(
          buyerToSeller.channel,
          paymentAmount
        ),
        tokenId: 1,
      }),
      signer: buyer.wallet,
      submitter: seller.wallet,
    });

    await settleIndividualForTest({
      ensured: sellerToOperator,
      message: createCommitmentMessage({
        payerId: sellerToOperator.channel.payerId,
        payeeId: sellerToOperator.channel.payeeId,
        committedAmount: nextCommitmentAmount(
          sellerToOperator.channel,
          operatorFee
        ),
        tokenId: 1,
      }),
      signer: seller.wallet,
      submitter: operator.wallet,
    });

    const buyerAfter = await fetchParticipant(buyer.wallet.publicKey);
    const sellerAfter = await fetchParticipant(seller.wallet.publicKey);
    const operatorAfter = await fetchParticipant(operator.wallet.publicKey);

    expect(availableDelta(buyerAfter, buyerBefore, 1)).to.equal(-paymentAmount);
    expect(availableDelta(sellerAfter, sellerBefore, 1)).to.equal(
      paymentAmount - operatorFee
    );
    expect(availableDelta(operatorAfter, operatorBefore, 1)).to.equal(
      operatorFee
    );
  });

  it("should settle individual commitment with authorized_settler", async () => {
    const payer = await createPrimaryFundedParticipant(4_000_000);
    const payee = await createTestParticipant();
    const ensured = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    const message = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      committedAmount: nextCommitmentAmount(ensured.channel, 1_500_000),
      tokenId: 1,
      authorizedSettler: user1.publicKey,
    });

    const payerBefore = await fetchParticipant(payer.wallet.publicKey);
    const payeeBefore = await fetchParticipant(payee.wallet.publicKey);

    await settleIndividualForTest({
      ensured,
      message,
      signer: payer.wallet,
      submitter: user1,
    });

    const payerAfter = await fetchParticipant(payer.wallet.publicKey);
    const payeeAfter = await fetchParticipant(payee.wallet.publicKey);

    expect(availableDelta(payerAfter, payerBefore, 1)).to.equal(-1_500_000);
    expect(availableDelta(payeeAfter, payeeBefore, 1)).to.equal(1_500_000);
  });
});
