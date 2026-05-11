import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getAccount } from "@solana/spl-token";
import { expect } from "chai";
import {
  channelBucketIdForPair,
  createCommitmentMessage,
  createCrossInstructionMessageEd25519Instruction,
  createFundedTokenAccount,
  createTestParticipant,
  depositParticipantBalance,
  ensureChannel,
  expectProgramError,
  findChannelPda,
  findGlobalConfigPda,
  findOwnerIndexBucketPda,
  findTokenRegistryPda,
  findVaultTokenAccountPda,
  getCanonicalChannelParticipants,
  getFeeRecipientTokenAccount,
  individualSettlementRemainingAccounts,
  lockChannelFundsForTest,
  nextCommitmentAmount,
  parseProgramEvents,
  primaryMint,
  program,
  provider,
  registerTestToken,
  requestUnlockChannelFundsForTest,
  settleIndividualForTest,
  sleep,
  user1,
  user2,
  user4,
  deployer,
} from "./shared/setup";

const SECOND_TOKEN_ID = 2;
const EVENT_TOKEN_ID = 3;
const CHANNEL_EVENT_TOKEN_ID = 4;
const HIGH_DECIMAL_TOKEN_ID = 15;
const NON_ASCII_TOKEN_ID = 16;

describe("Audit Regressions", () => {
  it("rejects settling a token commitment against a channel for a different token", async () => {
    const secondToken = await registerTestToken(SECOND_TOKEN_ID, "USDT");
    const payerSecondTokenAccount = await createFundedTokenAccount(
      user1,
      secondToken.mint,
      25_000_000
    );

    await depositParticipantBalance({
      owner: user1,
      participantPda: undefined,
      ownerTokenAccount: payerSecondTokenAccount,
      tokenId: SECOND_TOKEN_ID,
      amount: 10_000_000,
    });

    const token1Channel = await ensureChannel(user1, user4.publicKey, 1);
    const token2Channel = await ensureChannel(
      user1,
      user4.publicKey,
      SECOND_TOKEN_ID
    );

    const message = createCommitmentMessage({
      payerId: token2Channel.channel.payerId,
      payeeId: token2Channel.channel.payeeId,
      committedAmount: nextCommitmentAmount(token2Channel.channel, 1_000_000),
      tokenId: SECOND_TOKEN_ID,
    });

    await expectProgramError(
      () =>
        settleIndividualForTest({
          ensured: token1Channel,
          message,
          signer: user1,
          submitter: user4,
        }),
      "InvalidTokenMint"
    );
  });

  it("rejects Ed25519 instructions that reference message bytes from another instruction", async () => {
    const channel = await ensureChannel(user1, user4.publicKey, 1);

    const settleIx = await program.methods
      .settleIndividual()
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        submitter: user4.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .remainingAccounts(
        individualSettlementRemainingAccounts({
          payerParticipantPda: channel.payerParticipantPda,
          payeeParticipantPda: channel.payeeParticipantPda,
          channelPda: channel.channelPda,
        })
      )
      .instruction();

    const ed25519Ix = createCrossInstructionMessageEd25519Instruction(
      user1,
      Buffer.from(settleIx.data),
      1
    );

    const tx = new anchor.web3.Transaction().add(ed25519Ix, settleIx);

    await expectProgramError(
      () => provider.sendAndConfirm(tx, [user4]),
      "InvalidEd25519Data"
    );
  });

  it("rejects executing a withdrawal to a destination different from the requested token account", async () => {
    const participant = await createTestParticipant();
    const legitimateDestination = await createFundedTokenAccount(
      participant.wallet,
      primaryMint,
      20_000_000
    );
    const attackerDestination = await createFundedTokenAccount(
      user2,
      primaryMint,
      0
    );

    await depositParticipantBalance({
      owner: participant.wallet,
      participantPda: participant.participantPda,
      ownerTokenAccount: legitimateDestination,
      tokenId: 1,
      amount: 8_000_000,
    });

    await program.methods
      .requestWithdrawal(1, new anchor.BN(2_000_000), legitimateDestination)
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        owner: participant.wallet.publicKey,
        participantBucket: participant.participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(participant.wallet.publicKey),
        withdrawalDestination: legitimateDestination,
      } as any)
      .signers([participant.wallet])
      .rpc();

    await expectProgramError(
      () =>
        program.methods
          .executeWithdrawalTimelocked(1, participant.participant.participantId)
          .accounts({
            tokenRegistry: findTokenRegistryPda(),
            globalConfig: findGlobalConfigPda(),
            participantBucket: participant.participantPda,
            vaultTokenAccount: findVaultTokenAccountPda(1),
            withdrawalDestination: attackerDestination,
            feeRecipientTokenAccount: getFeeRecipientTokenAccount(1),
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .rpc(),
      "InvalidWithdrawalDestination"
    );

    await program.methods
      .executeWithdrawalTimelocked(1, participant.participant.participantId)
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        participantBucket: participant.participantPda,
        vaultTokenAccount: findVaultTokenAccountPda(1),
        withdrawalDestination: legitimateDestination,
        feeRecipientTokenAccount: getFeeRecipientTokenAccount(1),
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  });

  it("supports fee collection for withdrawals of a second registered token", async () => {
    const secondToken = await registerTestToken(SECOND_TOKEN_ID, "USDT");
    const participant = await createTestParticipant();
    const destination = await createFundedTokenAccount(
      participant.wallet,
      secondToken.mint,
      15_000_000
    );
    const vaultTokenAccount = findVaultTokenAccountPda(SECOND_TOKEN_ID);

    await depositParticipantBalance({
      owner: participant.wallet,
      participantPda: participant.participantPda,
      ownerTokenAccount: destination,
      tokenId: SECOND_TOKEN_ID,
      amount: 10_000_000,
    });

    await program.methods
      .requestWithdrawal(
        SECOND_TOKEN_ID,
        new anchor.BN(10_000_000),
        destination
      )
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        owner: participant.wallet.publicKey,
        participantBucket: participant.participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(participant.wallet.publicKey),
        withdrawalDestination: destination,
      } as any)
      .signers([participant.wallet])
      .rpc();

    const destinationBefore = (await getAccount(provider.connection, destination))
      .amount;
    const feeRecipientBefore = (
      await getAccount(provider.connection, secondToken.feeRecipientTokenAccount)
    ).amount;
    const vaultBefore = (await getAccount(provider.connection, vaultTokenAccount))
      .amount;

    await program.methods
      .executeWithdrawalTimelocked(
        SECOND_TOKEN_ID,
        participant.participant.participantId
      )
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        participantBucket: participant.participantPda,
        vaultTokenAccount,
        withdrawalDestination: destination,
        feeRecipientTokenAccount: secondToken.feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const destinationAfter = (await getAccount(provider.connection, destination))
      .amount;
    const feeRecipientAfter = (
      await getAccount(provider.connection, secondToken.feeRecipientTokenAccount)
    ).amount;
    const vaultAfter = (await getAccount(provider.connection, vaultTokenAccount))
      .amount;

    const netReceived = Number(destinationAfter - destinationBefore);
    const feeReceived = Number(feeRecipientAfter - feeRecipientBefore);
    const vaultDecrease = Number(vaultBefore - vaultAfter);

    expect(netReceived).to.equal(9_950_000);
    expect(feeReceived).to.equal(50_000);
    expect(vaultDecrease).to.equal(netReceived + feeReceived);
  });

  it("rejects registering tokens with unsupported decimals or non-ASCII symbols", async () => {
    const highDecimalMint = await createMint(
      provider.connection,
      deployer,
      deployer.publicKey,
      null,
      21,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    await expectProgramError(
      () =>
        program.methods
          .registerToken(HIGH_DECIMAL_TOKEN_ID, [...Buffer.from("HIDECIM\x00")])
          .accounts({
            mint: highDecimalMint,
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidTokenDecimals"
    );

    const mint = await createMint(
      provider.connection,
      deployer,
      deployer.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    await expectProgramError(
      () =>
        program.methods
          .registerToken(NON_ASCII_TOKEN_ID, [0xff, 0, 0, 0, 0, 0, 0, 0])
          .accounts({
            mint,
            authority: deployer.publicKey,
          } as any)
          .signers([deployer])
          .rpc(),
      "InvalidTokenSymbol"
    );
  });

  it("rejects unlocking channel funds with a mismatched token id", async () => {
    const secondToken = await registerTestToken(SECOND_TOKEN_ID, "USDT");
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const payerTokenAccount = await createFundedTokenAccount(
      payer.wallet,
      secondToken.mint,
      5_000_000
    );

    await depositParticipantBalance({
      owner: payer.wallet,
      participantPda: payer.participantPda,
      ownerTokenAccount: payerTokenAccount,
      tokenId: SECOND_TOKEN_ID,
      amount: 2_000_000,
    });

    const channel = await ensureChannel(
      payer.wallet,
      payee.wallet.publicKey,
      SECOND_TOKEN_ID
    );

    await lockChannelFundsForTest(channel, 500_000, payer.wallet, SECOND_TOKEN_ID);
    await requestUnlockChannelFundsForTest(
      channel,
      200_000,
      payer.wallet,
      SECOND_TOKEN_ID
    );

    await sleep(3500);

    await expectProgramError(
      () =>
        program.methods
          .executeUnlockChannelFunds(1, channel.payeeParticipant.participantId)
          .accounts({
            globalConfig: findGlobalConfigPda(),
            payerBucket: channel.payerParticipantPda,
            channelBucket: channel.channelPda,
            ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
            owner: payer.wallet.publicKey,
          } as any)
          .signers([payer.wallet])
          .rpc(),
      "InvalidTokenMint"
    );

    await program.methods
      .executeUnlockChannelFunds(
        SECOND_TOKEN_ID,
        channel.payeeParticipant.participantId
      )
      .accounts({
        globalConfig: findGlobalConfigPda(),
        payerBucket: channel.payerParticipantPda,
        channelBucket: channel.channelPda,
        ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
        owner: payer.wallet.publicKey,
      } as any)
      .signers([payer.wallet])
      .rpc();
  });

  it("uses a two-step token registry authority handoff", async () => {
    const tokenRegistryPda = findTokenRegistryPda();
    const newAuthority = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        newAuthority.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      )
    );

    await program.methods
      .updateRegistryAuthority(newAuthority.publicKey)
      .accounts({
        tokenRegistry: tokenRegistryPda,
        currentAuthority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();

    let registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);
    expect(registry.authority.toString()).to.equal(
      deployer.publicKey.toString()
    );
    expect(registry.pendingAuthority.toString()).to.equal(
      newAuthority.publicKey.toString()
    );

    await expectProgramError(
      () =>
        program.methods
          .acceptRegistryAuthority()
          .accounts({
            tokenRegistry: tokenRegistryPda,
            pendingAuthority: user1.publicKey,
          } as any)
          .signers([user1])
          .rpc(),
      "UnauthorizedPendingAuthority"
    );

    await program.methods
      .acceptRegistryAuthority()
      .accounts({
        tokenRegistry: tokenRegistryPda,
        pendingAuthority: newAuthority.publicKey,
      } as any)
      .signers([newAuthority])
      .rpc();

    registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);
    expect(registry.authority.toString()).to.equal(
      newAuthority.publicKey.toString()
    );
    expect(registry.pendingAuthority.toString()).to.equal(
      anchor.web3.PublicKey.default.toString()
    );

    await program.methods
      .updateRegistryAuthority(deployer.publicKey)
      .accounts({
        tokenRegistry: tokenRegistryPda,
        currentAuthority: newAuthority.publicKey,
      } as any)
      .signers([newAuthority])
      .rpc();

    await program.methods
      .acceptRegistryAuthority()
      .accounts({
        tokenRegistry: tokenRegistryPda,
        pendingAuthority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();
  });

  it("emits token_id on deposit events for allowlisted tokens", async () => {
    const eventToken = await registerTestToken(EVENT_TOKEN_ID, "PYUSD");
    const participant = await createTestParticipant();
    const participantTokenAccount = await createFundedTokenAccount(
      participant.wallet,
      eventToken.mint,
      5_000_000
    );

    const signature = await program.methods
      .deposit(EVENT_TOKEN_ID, new anchor.BN(1_000_000))
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        owner: participant.wallet.publicKey,
        participantBucket: participant.participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(participant.wallet.publicKey),
        ownerTokenAccount: participantTokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(EVENT_TOKEN_ID),
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([participant.wallet])
      .rpc();

    const events = await parseProgramEvents(signature);
    const deposited = events.find(
      (event) => event.name === "Deposited" || event.name === "deposited"
    );

    expect(deposited, "Deposited event should be present").to.exist;
    expect(deposited!.data.tokenId).to.equal(EVENT_TOKEN_ID);
    expect(deposited!.data.participantId).to.equal(
      participant.participant.participantId
    );
    expect(deposited!.data.amount.toNumber()).to.equal(1_000_000);
  });

  it("emits token_id on channel creation events for non-default allowlisted tokens", async () => {
    await registerTestToken(CHANNEL_EVENT_TOKEN_ID, "EURC");
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const channelPda = findChannelPda(
      payer.participant.participantId,
      payee.participant.participantId,
      CHANNEL_EVENT_TOKEN_ID
    );
    const { lowerParticipantId, higherParticipantId } =
      getCanonicalChannelParticipants(
        payer.participant.participantId,
        payee.participant.participantId
      );

    const signature = await program.methods
      .createChannel(
        CHANNEL_EVENT_TOKEN_ID,
        lowerParticipantId,
        higherParticipantId,
        new anchor.BN(
          channelBucketIdForPair(
            payer.participant.participantId,
            payee.participant.participantId
          )
        ),
        null
      )
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        owner: payer.wallet.publicKey,
        payerBucket: payer.participantPda,
        payeeBucket: payee.participantPda,
        ownerIndexBucket: findOwnerIndexBucketPda(payer.wallet.publicKey),
        payeeOwner: payee.wallet.publicKey,
        channelBucket: channelPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer.wallet, payee.wallet])
      .rpc();

    const events = await parseProgramEvents(signature);
    const channelCreated = events.find(
      (event) =>
        event.name === "ChannelCreated" || event.name === "channelCreated"
    );

    expect(channelCreated, "ChannelCreated event should be present").to.exist;
    expect(channelCreated!.data.tokenId).to.equal(CHANNEL_EVENT_TOKEN_ID);
    expect(channelCreated!.data.payerId).to.equal(
      payer.participant.participantId
    );
    expect(channelCreated!.data.payeeId).to.equal(
      payee.participant.participantId
    );
  });
});
