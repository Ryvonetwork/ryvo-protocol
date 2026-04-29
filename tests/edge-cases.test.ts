import * as anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import {
  createCommitmentMessage,
  createMultiSigEd25519Instruction,
  depositParticipantBalance,
  ensureChannel,
  expectProgramError,
  findGlobalConfigPda,
  findTokenRegistryPda,
  individualSettlementRemainingAccounts,
  nextCommitmentAmount,
  program,
  settleIndividualForTest,
  user1,
  user1TokenAccount,
  user2,
  user4,
} from "./shared/setup";

async function settleIndividualWithPreInstructions(
  ensured: Awaited<ReturnType<typeof ensureChannel>>,
  submitter: anchor.web3.Keypair,
  preInstructions: anchor.web3.TransactionInstruction[]
) {
  return program.methods
    .settleIndividual()
    .accounts({
      tokenRegistry: findTokenRegistryPda(),
      globalConfig: findGlobalConfigPda(),
      submitter: submitter.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts(
      individualSettlementRemainingAccounts({
        payerParticipantPda: ensured.payerParticipantPda,
        payeeParticipantPda: ensured.payeeParticipantPda,
        channelPda: ensured.channelPda,
      })
    )
    .preInstructions(preInstructions)
    .signers([submitter])
    .rpc();
}

describe("Edge cases", () => {
  it("deposit: minimum amount (1 unit) succeeds", async () => {
    await depositParticipantBalance({
      owner: user1,
      ownerTokenAccount: user1TokenAccount,
      tokenId: 1,
      amount: 1,
    });
  });

  it("settle_individual: rejects malformed commitment messages", async () => {
    const ensured = await ensureChannel(user1, user4.publicKey, 1);
    const invalidMsg = Buffer.alloc(50);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: user1.secretKey,
      message: invalidMsg,
    });

    await expectProgramError(
      () => settleIndividualWithPreInstructions(ensured, user1, [ed25519Ix]),
      "InvalidCommitmentMessage"
    );
  });

  it("settle_individual: rejects InvalidSignature", async () => {
    const ensured = await ensureChannel(user1, user4.publicKey, 1);
    const msg = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      committedAmount: new anchor.BN(2_000_000),
      tokenId: 1,
    });

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: msg,
          signer: user2,
          submitter: user4,
        }),
      "InvalidSignature"
    );
  });

  it("settle_individual: rejects UnauthorizedSettler", async () => {
    const ensured = await ensureChannel(user1, user4.publicKey, 1);
    const msg = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      committedAmount: new anchor.BN(2_000_000),
      tokenId: 1,
      authorizedSettler: user2.publicKey,
    });

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: msg,
          signer: user1,
          submitter: user1,
        }),
      "UnauthorizedSettler"
    );
  });

  it("settle_individual: rejects replay via stale cumulative amount", async () => {
    const ensured = await ensureChannel(user1, user4.publicKey, 1);
    const msg = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      committedAmount: nextCommitmentAmount(ensured.channel, 1_000_000),
      tokenId: 1,
    });

    await settleIndividualForTest({
      ensured,
      message: msg,
      signer: user1,
      submitter: user4,
    });

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: msg,
          signer: user1,
          submitter: user4,
        }),
      "CommitmentAmountMustIncrease"
    );
  });

  it("settle_individual: rejects Ed25519 instructions with extra signatures", async () => {
    const ensured = await ensureChannel(user1, user4.publicKey, 1);
    const msg = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      committedAmount: nextCommitmentAmount(ensured.channel, 1_000_000),
      tokenId: 1,
    });
    const ed25519Ix = createMultiSigEd25519Instruction([user1, user2], msg);

    await expectProgramError(
      () => settleIndividualWithPreInstructions(ensured, user4, [ed25519Ix]),
      "InvalidEd25519Data"
    );
  });

  it("settle_individual: rejects commitment messages with unsupported trailing bytes", async () => {
    const ensured = await ensureChannel(user1, user4.publicKey, 1);
    const invalidMessage = Buffer.concat([
      createCommitmentMessage({
        payerId: ensured.channel.payerId,
        payeeId: ensured.channel.payeeId,
        committedAmount: nextCommitmentAmount(ensured.channel, 1_000_000),
        tokenId: 1,
      }),
      Buffer.from([0x09, 0x09]),
    ]);

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured,
          message: invalidMessage,
          signer: user1,
          submitter: user4,
        }),
      "InvalidCommitmentMessage"
    );
  });

  it("authorized settler validation works correctly", async () => {
    const ensured = await ensureChannel(user1, user4.publicKey, 1);
    const msg = createCommitmentMessage({
      payerId: ensured.channel.payerId,
      payeeId: ensured.channel.payeeId,
      committedAmount: nextCommitmentAmount(ensured.channel, 1_000_000),
      tokenId: 1,
      authorizedSettler: user2.publicKey,
    });

    await settleIndividualForTest({
      ensured,
      message: msg,
      signer: user1,
      submitter: user2,
    });
  });
});
