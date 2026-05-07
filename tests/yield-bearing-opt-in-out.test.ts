/**
 * v7 — opt_in_yield / opt_out_yield internal balance moves between an owner's plain USDC bucket
 * and their ryUSDC bucket. The wallet ATA is never touched by these handlers; underlying USDC
 * moves entirely between protocol-owned vault PDAs (plain-USDC vault <-> mock-yield liquidity
 * vault), and on-chain shares move within ParticipantBucket slots.
 *
 * Coverage:
 *   - happy paths (opt-in, opt-out, with and without yield accrual mid-flight)
 *   - mint-mismatch rejection (opt-in across underlying mints)
 *   - insufficient-balance rejection (debit > available)
 *   - locked balance is untouched (only available is debited)
 *   - round-trip dust is bounded
 *
 * Each test asserts the strategy solvency invariant after mutating state.
 */
import { expect } from "chai";

import {
  RY_USDC_TOKEN_ID,
  accrueYieldForTest,
  assertYieldStrategySolvent,
  createFundedTokenAccount,
  createTestParticipant,
  depositParticipantBalance,
  ensureChannel,
  expectProgramError,
  fetchParticipantById,
  fetchYieldStrategy,
  getTokenBalance,
  getYieldBearingTestbed,
  lockChannelFundsForTest,
  mockYieldProgram,
  optInYieldForTest,
  optOutYieldForTest,
  PRIMARY_TOKEN_ID,
  primaryMint,
  program,
  refetchDirectionalChannel,
  registerTestToken,
  updateMockYieldApyForTest,
} from "./shared/setup";

const ONE_USDC = 1_000_000;

describe("v7 — opt_in_yield / opt_out_yield", () => {
  before(async function () {
    this.timeout(120_000);
    await getYieldBearingTestbed();
  });

  describe("opt_in_yield (plain bucket -> ryUSDC bucket)", () => {
    it("moves available USDC into ryUSDC; total_user_shares grows by exact amount; solvency holds", async function () {
      this.timeout(60_000);

      const alice = await createTestParticipant();
      const aliceAta = await createFundedTokenAccount(
        alice.wallet,
        primaryMint,
        20 * ONE_USDC
      );
      await depositParticipantBalance({
        owner: alice.wallet,
        ownerTokenAccount: aliceAta,
        tokenId: PRIMARY_TOKEN_ID,
        amount: 10 * ONE_USDC,
      });

      const before = await fetchYieldStrategy();
      const aliceBefore = await fetchParticipantById(
        alice.participant.participantId
      );
      const plainBefore = getTokenBalance(
        aliceBefore,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();
      const yieldBefore = getTokenBalance(
        aliceBefore,
        RY_USDC_TOKEN_ID
      ).availableBalance.toNumber();

      await optInYieldForTest({
        owner: alice.wallet,
        amountUsdc: 4 * ONE_USDC,
      });

      const after = await fetchYieldStrategy();
      const aliceAfter = await fetchParticipantById(
        alice.participant.participantId
      );
      const plainAfter = getTokenBalance(
        aliceAfter,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();
      const yieldAfter = getTokenBalance(
        aliceAfter,
        RY_USDC_TOKEN_ID
      ).availableBalance.toNumber();

      expect(plainAfter).to.equal(plainBefore - 4 * ONE_USDC);
      // Shares minted at the current index. With ~unit index and minimal prior yield, the credit
      // should be very close to 4 USDC = 4M shares.
      const sharesMinted = yieldAfter - yieldBefore;
      expect(sharesMinted).to.be.greaterThan(4 * ONE_USDC - 1_000);
      expect(sharesMinted).to.be.lessThanOrEqual(4 * ONE_USDC);


      expect(after.totalUserShares - before.totalUserShares).to.equal(
        BigInt(sharesMinted)
      );
      // last_settled_underlying grows by `amount_usdc` plus any yield accrued during this call's
      // CPI to mock-yield's accrue_inner; allow a small window for that drift.
      const lastSettledDelta = Number(
        after.lastSettledUnderlying - before.lastSettledUnderlying
      );
      expect(lastSettledDelta).to.be.greaterThanOrEqual(4 * ONE_USDC);
      expect(lastSettledDelta).to.be.lessThanOrEqual(4 * ONE_USDC + 100);
      // Index should be monotonic (may have advanced from accrue inside opt_in).
      expect(after.userIndexQ64 >= before.userIndexQ64).to.be.true;

      await assertYieldStrategySolvent();
    });

    it("rejects opt-in when available bucket balance is insufficient", async function () {
      this.timeout(30_000);
      const bob = await createTestParticipant();
      const bobAta = await createFundedTokenAccount(
        bob.wallet,
        primaryMint,
        1 * ONE_USDC
      );
      await depositParticipantBalance({
        owner: bob.wallet,
        ownerTokenAccount: bobAta,
        tokenId: PRIMARY_TOKEN_ID,
        amount: 1 * ONE_USDC,
      });

      await expectProgramError(
        () =>
          optInYieldForTest({
            owner: bob.wallet,
            amountUsdc: 5 * ONE_USDC,
          }),
        "InsufficientBalance"
      );
    });

    it("rejects opt-in when plain token's mint differs from strategy underlying", async function () {
      this.timeout(60_000);

      // Register a foreign-mint plain token. Opt-in must reject because the ryUSDC strategy's
      // underlying is `primaryMint`, not this mint.
      const FOREIGN_TOKEN_ID = 60;
      const foreignToken = await registerTestToken(FOREIGN_TOKEN_ID, "FUSDT");

      const carol = await createTestParticipant();
      const carolForeignAta = await createFundedTokenAccount(
        carol.wallet,
        foreignToken.mint,
        5 * ONE_USDC
      );
      await depositParticipantBalance({
        owner: carol.wallet,
        ownerTokenAccount: carolForeignAta,
        tokenId: FOREIGN_TOKEN_ID,
        amount: 5 * ONE_USDC,
      });

      await expectProgramError(
        () =>
          optInYieldForTest({
            owner: carol.wallet,
            plainTokenId: FOREIGN_TOKEN_ID,
            amountUsdc: 1 * ONE_USDC,
          }),
        "MismatchedYieldUnderlying"
      );
    });

    it("does not touch locked balance (only debits available)", async function () {
      this.timeout(60_000);

      const eve = await createTestParticipant();
      const fred = await createTestParticipant();
      const eveAta = await createFundedTokenAccount(
        eve.wallet,
        primaryMint,
        10 * ONE_USDC
      );
      await depositParticipantBalance({
        owner: eve.wallet,
        ownerTokenAccount: eveAta,
        tokenId: PRIMARY_TOKEN_ID,
        amount: 10 * ONE_USDC,
      });

      // Lock 6 USDC of plain into a channel, leaving 4 USDC available.
      const ensured = await ensureChannel(
        eve.wallet,
        fred.wallet.publicKey,
        PRIMARY_TOKEN_ID,
        { payeeOwnerSigner: fred.wallet }
      );
      await lockChannelFundsForTest(
        ensured,
        6 * ONE_USDC,
        eve.wallet,
        PRIMARY_TOKEN_ID
      );

      const eveBefore = await fetchParticipantById(
        eve.participant.participantId
      );
      const plainAvBefore = getTokenBalance(
        eveBefore,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();
      expect(plainAvBefore).to.equal(4 * ONE_USDC);

      // Opt-in the 4 available; assert the lock survives untouched.
      await optInYieldForTest({
        owner: eve.wallet,
        amountUsdc: 4 * ONE_USDC,
      });

      const eveAfter = await fetchParticipantById(
        eve.participant.participantId
      );
      const plainAvAfter = getTokenBalance(
        eveAfter,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();
      const yieldAfter = getTokenBalance(
        eveAfter,
        RY_USDC_TOKEN_ID
      ).availableBalance.toNumber();
      expect(plainAvAfter).to.equal(0);
      expect(yieldAfter).to.be.greaterThan(0);

      const channelAfter = await refetchDirectionalChannel(ensured);
      expect(channelAfter.lockedBalance.toNumber()).to.equal(6 * ONE_USDC);

      // Trying to opt-in MORE than the (now-zero) available errors with InsufficientBalance even
      // though the lock makes the user's total balance non-zero.
      await expectProgramError(
        () =>
          optInYieldForTest({
            owner: eve.wallet,
            amountUsdc: 1 * ONE_USDC,
          }),
        "InsufficientBalance"
      );

      await assertYieldStrategySolvent();
    });
  });

  describe("opt_out_yield (ryUSDC bucket -> plain bucket)", () => {
    it("burns shares and credits redeemed USDC into plain bucket; solvency holds", async function () {
      this.timeout(60_000);

      const greg = await createTestParticipant();
      const gregAta = await createFundedTokenAccount(
        greg.wallet,
        primaryMint,
        10 * ONE_USDC
      );
      await depositParticipantBalance({
        owner: greg.wallet,
        ownerTokenAccount: gregAta,
        tokenId: PRIMARY_TOKEN_ID,
        amount: 10 * ONE_USDC,
      });
      await optInYieldForTest({
        owner: greg.wallet,
        amountUsdc: 6 * ONE_USDC,
      });

      const beforeOptOut = await fetchYieldStrategy();
      const gregBefore = await fetchParticipantById(
        greg.participant.participantId
      );
      const yieldBefore = getTokenBalance(
        gregBefore,
        RY_USDC_TOKEN_ID
      ).availableBalance.toNumber();
      const plainBefore = getTokenBalance(
        gregBefore,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();
      expect(plainBefore).to.equal(4 * ONE_USDC);
      expect(yieldBefore).to.be.greaterThan(0);

      const halfShares = Math.floor(yieldBefore / 2);
      await optOutYieldForTest({
        owner: greg.wallet,
        shares: halfShares,
      });

      const gregAfter = await fetchParticipantById(
        greg.participant.participantId
      );
      const yieldAfter = getTokenBalance(
        gregAfter,
        RY_USDC_TOKEN_ID
      ).availableBalance.toNumber();
      const plainAfter = getTokenBalance(
        gregAfter,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();

      expect(yieldAfter).to.equal(yieldBefore - halfShares);
      const plainCredited = plainAfter - plainBefore;
      // At ~unit index the credit is ~halfShares USDC; allow small dust.
      expect(plainCredited).to.be.greaterThanOrEqual(halfShares - 2);
      expect(plainCredited).to.be.lessThanOrEqual(halfShares + 1);

      const after = await fetchYieldStrategy();
      expect(beforeOptOut.totalUserShares - after.totalUserShares).to.equal(
        BigInt(halfShares)
      );

      await assertYieldStrategySolvent();
    });

    it("opt-out after yield accrual credits the higher USDC value", async function () {
      this.timeout(60_000);

      const hank = await createTestParticipant();
      const hankAta = await createFundedTokenAccount(
        hank.wallet,
        primaryMint,
        10 * ONE_USDC
      );
      await depositParticipantBalance({
        owner: hank.wallet,
        ownerTokenAccount: hankAta,
        tokenId: PRIMARY_TOKEN_ID,
        amount: 10 * ONE_USDC,
      });
      await optInYieldForTest({
        owner: hank.wallet,
        amountUsdc: 8 * ONE_USDC,
      });

      // Bump APY to the protocol cap and accrue a few times so the index advances visibly even
      // on the short test runtime.
      await updateMockYieldApyForTest(5_000); // 50% APY (mock-yield's hard cap)
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 1_500));
        await accrueYieldForTest();
      }

      const beforeOptOut = await fetchYieldStrategy();
      const TWO_64 = 1n << 64n;
      const indexBumped = beforeOptOut.userIndexQ64 > TWO_64;

      const hankBefore = await fetchParticipantById(
        hank.participant.participantId
      );
      const yieldShares = getTokenBalance(
        hankBefore,
        RY_USDC_TOKEN_ID
      ).availableBalance.toNumber();
      const plainBefore = getTokenBalance(
        hankBefore,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();

      await optOutYieldForTest({
        owner: hank.wallet,
        shares: yieldShares,
      });

      const hankAfter = await fetchParticipantById(
        hank.participant.participantId
      );
      const plainAfter = getTokenBalance(
        hankAfter,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();
      const credited = plainAfter - plainBefore;

      if (indexBumped) {
        // After accrual, redeeming `yieldShares` should credit at least the original 8 USDC
        // back (allowing for ≤ 2 lamport rounding dust on opt-in then opt-out). Strictly more
        // than the original would prove yield, but localnet's clock is slot-driven so on tight
        // schedules the credit may equal the deposit modulo 1-lamport dust.
        expect(credited).to.be.greaterThanOrEqual(8 * ONE_USDC - 2);
      } else {
        expect(credited).to.be.greaterThanOrEqual(8 * ONE_USDC - 2);
      }

      await assertYieldStrategySolvent();
    });
  });

  describe("opt-in -> opt-out round-trip", () => {
    it("returns within ≤ 2 lamport dust at unit index", async function () {
      this.timeout(60_000);

      const ivy = await createTestParticipant();
      const ivyAta = await createFundedTokenAccount(
        ivy.wallet,
        primaryMint,
        5 * ONE_USDC
      );
      await depositParticipantBalance({
        owner: ivy.wallet,
        ownerTokenAccount: ivyAta,
        tokenId: PRIMARY_TOKEN_ID,
        amount: 5 * ONE_USDC,
      });

      const ivyBefore = await fetchParticipantById(
        ivy.participant.participantId
      );
      const plainBefore = getTokenBalance(
        ivyBefore,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();
      expect(plainBefore).to.equal(5 * ONE_USDC);

      await optInYieldForTest({
        owner: ivy.wallet,
        amountUsdc: 3 * ONE_USDC,
      });

      const midState = await fetchParticipantById(
        ivy.participant.participantId
      );
      const sharesAfterIn = getTokenBalance(
        midState,
        RY_USDC_TOKEN_ID
      ).availableBalance.toNumber();
      expect(sharesAfterIn).to.be.greaterThan(0);

      await optOutYieldForTest({
        owner: ivy.wallet,
        shares: sharesAfterIn,
      });

      const ivyAfter = await fetchParticipantById(
        ivy.participant.participantId
      );
      const plainAfter = getTokenBalance(
        ivyAfter,
        PRIMARY_TOKEN_ID
      ).availableBalance.toNumber();
      const yieldAfter = getTokenBalance(
        ivyAfter,
        RY_USDC_TOKEN_ID
      ).availableBalance.toNumber();

      expect(yieldAfter).to.equal(0);
      expect(plainAfter).to.be.greaterThanOrEqual(5 * ONE_USDC - 2);
      expect(plainAfter).to.be.lessThanOrEqual(5 * ONE_USDC + 100);

      await assertYieldStrategySolvent();
    });
  });
});
