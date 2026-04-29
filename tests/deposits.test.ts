import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { expect } from "chai";
import {
  program,
  provider,
  user1,
  user2,
  user3,
  user4,
  user1TokenAccount,
  depositParticipantBalance,
  fetchParticipant,
  findParticipantPda,
  findGlobalConfigPda,
  findTokenRegistryPda,
  getTokenBalance,
  knownParticipantId,
  participantBucketMetasForOwners,
  findVaultTokenAccountPda,
  registerTestToken,
  createFundedTokenAccount,
} from "./shared/setup";

const SECOND_DEPOSIT_TOKEN_ID = 11;

describe("Deposit", () => {
  it("should deposit the primary test token into participant balance", async () => {
    const participantPda = findParticipantPda(user1.publicKey);
    const vaultTokenAccount = findVaultTokenAccountPda(1);

    const depositAmount = 50000000; // 50 primary-token units (6 decimals)

    // Check balances before
    const userTokenAccountBefore = await getAccount(provider.connection, user1TokenAccount);
    const vaultTokenAccountBefore = await getAccount(provider.connection, vaultTokenAccount);
    const participantBefore = await fetchParticipant(user1.publicKey);

    await depositParticipantBalance({
      owner: user1,
      participantPda,
      ownerTokenAccount: user1TokenAccount,
      tokenId: 1,
      amount: depositAmount,
    });

    // Check balances after
    const userTokenAccountAfter = await getAccount(provider.connection, user1TokenAccount);
    const vaultTokenAccountAfter = await getAccount(provider.connection, vaultTokenAccount);
    const participantAfter = await fetchParticipant(user1.publicKey);

    // Verify token transfer
    expect(userTokenAccountAfter.amount - userTokenAccountBefore.amount).to.equal(-BigInt(depositAmount));
    expect(vaultTokenAccountAfter.amount - vaultTokenAccountBefore.amount).to.equal(BigInt(depositAmount));
    // Conservation: total tokens unchanged
    expect(userTokenAccountAfter.amount + vaultTokenAccountAfter.amount).to.equal(
      userTokenAccountBefore.amount + vaultTokenAccountBefore.amount
    );

    // Verify participant balance update (token-specific)
    const tokenBalanceBefore = getTokenBalance(participantBefore, 1).availableBalance.toNumber();
    const tokenBalanceAfter = getTokenBalance(participantAfter, 1).availableBalance.toNumber();
    expect(tokenBalanceAfter - tokenBalanceBefore).to.equal(depositAmount);
  });

  it("should deposit_for multiple agents at once", async () => {
    const amounts = [10000000, 20000000, 30000000, 5000000]; // 10, 20, 30, 5 token units

    const participant1Before = await fetchParticipant(user1.publicKey);
    const participant2Before = await fetchParticipant(user2.publicKey);
    const participant3Before = await fetchParticipant(user3.publicKey);
    const participant4Before = await fetchParticipant(user4.publicKey);

    await program.methods
      .depositFor(
        1,
        [user1, user2, user3, user4].map((user) =>
          knownParticipantId(user.publicKey)
        ),
        amounts.map((a) => new anchor.BN(a))
      )
      .accounts({
        tokenRegistry: findTokenRegistryPda(),
        globalConfig: findGlobalConfigPda(),
        funderTokenAccount: user1TokenAccount,
        vaultTokenAccount: findVaultTokenAccountPda(1),
        funder: user1.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      } as any)
      .remainingAccounts(
        participantBucketMetasForOwners([
          user1.publicKey,
          user2.publicKey,
          user3.publicKey,
          user4.publicKey,
        ])
      )
      .signers([user1])
      .rpc();

    const participant1After = await fetchParticipant(user1.publicKey);
    const participant2After = await fetchParticipant(user2.publicKey);
    const participant3After = await fetchParticipant(user3.publicKey);
    const participant4After = await fetchParticipant(user4.publicKey);

    expect(
      getTokenBalance(participant1After, 1).availableBalance.toNumber() -
        getTokenBalance(participant1Before, 1).availableBalance.toNumber()
    ).to.equal(amounts[0]);
    expect(
      getTokenBalance(participant2After, 1).availableBalance.toNumber() -
        getTokenBalance(participant2Before, 1).availableBalance.toNumber()
    ).to.equal(amounts[1]);
    expect(
      getTokenBalance(participant3After, 1).availableBalance.toNumber() -
        getTokenBalance(participant3Before, 1).availableBalance.toNumber()
    ).to.equal(amounts[2]);
    expect(
      getTokenBalance(participant4After, 1).availableBalance.toNumber() -
        getTokenBalance(participant4Before, 1).availableBalance.toNumber()
    ).to.equal(amounts[3]);
  });

  it("should deposit a second allowlisted token into participant balance", async () => {
    const secondToken = await registerTestToken(SECOND_DEPOSIT_TOKEN_ID, "EURC");
    const participantPda = findParticipantPda(user1.publicKey);
    const secondTokenAccount = await createFundedTokenAccount(
      user1,
      secondToken.mint,
      25_000_000
    );
    const vaultTokenAccount = findVaultTokenAccountPda(SECOND_DEPOSIT_TOKEN_ID);
    const depositAmount = 7_000_000;

    const userTokenAccountBefore = await getAccount(
      provider.connection,
      secondTokenAccount
    );
    const vaultTokenAccountBefore = await getAccount(
      provider.connection,
      vaultTokenAccount
    );
    const participantBefore = await fetchParticipant(user1.publicKey);

    await depositParticipantBalance({
      owner: user1,
      participantPda,
      ownerTokenAccount: secondTokenAccount,
      tokenId: SECOND_DEPOSIT_TOKEN_ID,
      amount: depositAmount,
    });

    const userTokenAccountAfter = await getAccount(
      provider.connection,
      secondTokenAccount
    );
    const vaultTokenAccountAfter = await getAccount(
      provider.connection,
      vaultTokenAccount
    );
    const participantAfter = await fetchParticipant(user1.publicKey);

    expect(userTokenAccountAfter.amount - userTokenAccountBefore.amount).to.equal(
      -BigInt(depositAmount)
    );
    expect(
      vaultTokenAccountAfter.amount - vaultTokenAccountBefore.amount
    ).to.equal(BigInt(depositAmount));

    const tokenBalanceBefore = getTokenBalance(
      participantBefore,
      SECOND_DEPOSIT_TOKEN_ID
    ).availableBalance.toNumber();
    const tokenBalanceAfter = getTokenBalance(
      participantAfter,
      SECOND_DEPOSIT_TOKEN_ID
    ).availableBalance.toNumber();

    expect(tokenBalanceAfter - tokenBalanceBefore).to.equal(depositAmount);
  });
});
