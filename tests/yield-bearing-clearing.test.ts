/**
 * v6 — verifies that yield-bearing tokens (agUSDC) play correctly with the protocol's channel
 * lifecycle and all three settlement modes:
 *
 *   1. Bilateral commitment settlement (`settle_individual` / `settle_commitment_bundle`)
 *   2. BLS aggregated clearing-round settlement (`settle_clearing_round`)
 *   3. Cooperative bilateral unlock (`cooperative_unlock_channel_funds`)
 *   4. Unilateral timelocked unlock (`request_unlock_channel_funds` + `execute_unlock_channel_funds`)
 *
 * Plus: yield accrual mid-channel-life and the end-to-end yield-bearing withdrawal path. All
 * settlements operate on share counts (rate-blind by design) — yield only changes the redemption
 * exchange rate at deposit/withdrawal boundaries. Each test asserts the solvency invariant after
 * mutating state.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { expect } from "chai";

import {
  AG_USDC_TOKEN_ID,
  accrueYieldForTest,
  aggregateBlsSignatures,
  assertYieldStrategySolvent,
  BLS_CLEARING_ROUND_MESSAGE_VERSION,
  cooperativeUnlockChannelFundsForTest,
  createBlsKeypair,
  createClearingRoundMessage,
  createCommitmentMessage,
  createTestParticipant,
  createBlsRegistrationMessage,
  depositYieldBearingForTest,
  ensureChannel,
  executeUnlockChannelFundsForTest,
  fetchParticipantById,
  fetchYieldStrategy,
  findGlobalConfigPda,
  findTokenRegistryPda,
  findParticipantPda,
  getTokenBalance,
  getYieldBearingTestbed,
  lockChannelFundsForTest,
  primaryMint,
  program,
  refetchDirectionalChannel,
  registerParticipantBlsKey,
  requestUnlockChannelFundsForTest,
  settleIndividualForTest,
  signBlsMessage,
  sleep,
  TEST_MESSAGE_DOMAIN,
  withdrawYieldBearingForTest,
  YieldStrategySnapshot,
} from "./shared/setup";

const ONE_USDC = 1_000_000; // 6 decimals
const BLS_TEST_COMPUTE_UNIT_LIMIT = 1_400_000;
const BLS_TEST_HEAP_FRAME_BYTES = 256 * 1024;

function strategySnapshotKey(s: YieldStrategySnapshot): string {
  return `userIndex=${s.userIndexQ64} totalShares=${s.totalUserShares} protocolOwed=${s.protocolOwedUnderlying} lastSettled=${s.lastSettledUnderlying}`;
}

describe("v6 — yield-bearing channel + clearing flows", () => {
  before(async function () {
    this.timeout(120_000);
    await getYieldBearingTestbed();
  });

  describe("Bilateral commitment settlement (settle_individual)", () => {
    it("moves agUSDC shares between buckets without changing the yield index", async function () {
      this.timeout(60_000);

      // Fresh participants so balances are isolated from other tests.
      const alice = await createTestParticipant();
      const bob = await createTestParticipant();

      await depositYieldBearingForTest({
        owner: alice.wallet,
        participantPda: alice.participantPda,
        amountUsdc: 10 * ONE_USDC,
      });
      await depositYieldBearingForTest({
        owner: bob.wallet,
        participantPda: bob.participantPda,
        amountUsdc: 1 * ONE_USDC,
      });

      // Alice opens a channel to Bob and locks 4 USDC (= 4M shares at index ≈ 1.0). The lock isn't
      // strictly required for `settle_individual` to work (settlement debits the payer's available
      // balance directly), but exercising it here verifies the lock + settle + accrue interleaving.
      const ensured = await ensureChannel(
        alice.wallet,
        bob.wallet.publicKey,
        AG_USDC_TOKEN_ID,
        { payeeOwnerSigner: bob.wallet }
      );
      await lockChannelFundsForTest(
        ensured,
        4 * ONE_USDC,
        alice.wallet,
        AG_USDC_TOKEN_ID
      );

      // Snapshot pre-settlement state.
      const strategyBefore = await fetchYieldStrategy();
      const aliceBefore = await fetchParticipantById(alice.participant.participantId);
      const bobBefore = await fetchParticipantById(bob.participant.participantId);
      const aliceAvBefore = getTokenBalance(aliceBefore, AG_USDC_TOKEN_ID).availableBalance.toNumber();
      const bobAvBefore = getTokenBalance(bobBefore, AG_USDC_TOKEN_ID).availableBalance.toNumber();

      // Alice signs a v5 commitment for cumulative_amount = 1.5 USDC of shares. Settled is the
      // delta vs the channel's current settledCumulative (which is 0).
      const targetCumulative = new anchor.BN(1_500_000);
      const message = createCommitmentMessage({
        payerId: alice.participant.participantId,
        payeeId: bob.participant.participantId,
        tokenId: AG_USDC_TOKEN_ID,
        committedAmount: targetCumulative,
      });
      await settleIndividualForTest({
        ensured,
        message,
        signer: alice.wallet,
        submitter: bob.wallet,
      });

      // Assertions.
      const strategyAfter = await fetchYieldStrategy();
      const aliceAfter = await fetchParticipantById(alice.participant.participantId);
      const bobAfter = await fetchParticipantById(bob.participant.participantId);
      const aliceAvAfter = getTokenBalance(aliceAfter, AG_USDC_TOKEN_ID).availableBalance.toNumber();
      const bobAvAfter = getTokenBalance(bobAfter, AG_USDC_TOKEN_ID).availableBalance.toNumber();
      const channelAfter = await refetchDirectionalChannel(ensured);

      // Bob's available rose by exactly the cumulative; Alice's locked dropped by the same.
      expect(bobAvAfter - bobAvBefore).to.equal(1_500_000);
      expect(channelAfter.settledCumulative.toNumber()).to.equal(1_500_000);
      expect(channelAfter.lockedBalance.toNumber()).to.equal(4 * ONE_USDC - 1_500_000);
      expect(aliceAvAfter).to.equal(aliceAvBefore); // settlement consumed locked, not available

      // Settlement is rate-blind — the index and total_user_shares are unaffected by intra-protocol
      // share movement.
      expect(strategyAfter.totalUserShares).to.equal(
        strategyBefore.totalUserShares,
        `total_user_shares changed during bilateral settle: ` +
          `${strategySnapshotKey(strategyBefore)} -> ${strategySnapshotKey(strategyAfter)}`
      );
      // user_index_q64 may have advanced if any time elapsed (deposit auto-accrues), so we only
      // assert it's monotonic.
      expect(strategyAfter.userIndexQ64 >= strategyBefore.userIndexQ64).to.be.true;

      await assertYieldStrategySolvent();
    });

    it("yield accruing mid-channel does not corrupt settled share counts", async function () {
      this.timeout(60_000);

      const alice = await createTestParticipant();
      const bob = await createTestParticipant();
      await depositYieldBearingForTest({
        owner: alice.wallet,
        participantPda: alice.participantPda,
        amountUsdc: 5 * ONE_USDC,
      });
      await depositYieldBearingForTest({
        owner: bob.wallet,
        participantPda: bob.participantPda,
        amountUsdc: 1 * ONE_USDC,
      });
      const ensured = await ensureChannel(
        alice.wallet,
        bob.wallet.publicKey,
        AG_USDC_TOKEN_ID,
        { payeeOwnerSigner: bob.wallet }
      );
      await lockChannelFundsForTest(
        ensured,
        2 * ONE_USDC,
        alice.wallet,
        AG_USDC_TOKEN_ID
      );

      const indexBefore = (await fetchYieldStrategy()).userIndexQ64;
      await accrueYieldForTest();
      const indexAfterAccrue = (await fetchYieldStrategy()).userIndexQ64;
      // Index either grew or held steady (clock-tick-dependent). Either way, share counts shouldn't
      // change.

      // Alice signs cumulative=0.5 USDC of shares, Bob settles.
      const message = createCommitmentMessage({
        payerId: alice.participant.participantId,
        payeeId: bob.participant.participantId,
        tokenId: AG_USDC_TOKEN_ID,
        committedAmount: new anchor.BN(500_000),
      });
      await settleIndividualForTest({
        ensured,
        message,
        signer: alice.wallet,
        submitter: bob.wallet,
      });

      const channelAfter = await refetchDirectionalChannel(ensured);
      expect(channelAfter.settledCumulative.toNumber()).to.equal(500_000);
      expect(channelAfter.lockedBalance.toNumber()).to.equal(2 * ONE_USDC - 500_000);

      const indexAfterSettle = (await fetchYieldStrategy()).userIndexQ64;
      expect(indexAfterSettle).to.equal(indexAfterAccrue);
      expect(indexAfterAccrue >= indexBefore).to.be.true;

      await assertYieldStrategySolvent();
    });
  });

  describe("BLS aggregated clearing-round (settle_clearing_round)", () => {
    it("settles a 3-participant / 6-directed-channel round through the BLS path on agUSDC", async function () {
      this.timeout(180_000);

      // Three participants. Each deposits enough agUSDC to act as both payer and payee.
      const fixtures = [] as Array<{
        participant: Awaited<ReturnType<typeof createTestParticipant>>;
        blsKeypair: Awaited<ReturnType<typeof registerParticipantBlsKey>>["blsKeypair"];
      }>;
      for (let i = 0; i < 3; i += 1) {
        const participant = await createTestParticipant();
        await depositYieldBearingForTest({
          owner: participant.wallet,
          participantPda: participant.participantPda,
          amountUsdc: 30 * ONE_USDC,
        });
        const reg = await registerParticipantBlsKey({
          owner: participant.wallet,
          participantPda: participant.participantPda,
          participant: participant.participant,
        });
        fixtures.push({ participant, blsKeypair: reg.blsKeypair });
      }

      // Create the 6 directed pair channels.
      const directedPairs: Array<[number, number]> = [
        [0, 1], [1, 0], [0, 2], [2, 0], [1, 2], [2, 1],
      ];
      const channels = new Map<string, Awaited<ReturnType<typeof ensureChannel>>>();
      for (const [pIdx, qIdx] of directedPairs) {
        const channel = await ensureChannel(
          fixtures[pIdx].participant.wallet,
          fixtures[qIdx].participant.wallet.publicKey,
          AG_USDC_TOKEN_ID,
          { payeeOwnerSigner: fixtures[qIdx].participant.wallet }
        );
        channels.set(`${pIdx}>${qIdx}`, channel);
      }

      // Round deltas chosen so net flows are non-trivial — copies the pattern from
      // bls-clearing-rounds.test.ts:
      //   participant 0: pays out (5 + 4) - (1.5 + 7.5) = 0
      //   participant 1: pays out (1.5 + 2.25) - (5 + 3.25) = -4.5
      //   participant 2: pays out (7.5 + 3.25) - (4 + 2.25) = +4.5
      const deltas = [5_000_000, 1_500_000, 4_000_000, 7_500_000, 2_250_000, 3_250_000];
      const blocks = fixtures.map((fixture, payerIdx) => ({
        participantId: fixture.participant.participant.participantId,
        entries: directedPairs.flatMap(([candidatePayerIdx, payeeIdx], entryIdx) => {
          if (candidatePayerIdx !== payerIdx) return [];
          const channel = channels.get(`${candidatePayerIdx}>${payeeIdx}`)!;
          return [
            {
              payeeRef: payeeIdx,
              targetCumulative: channel.channel.settledCumulative.add(
                new anchor.BN(deltas[entryIdx])
              ),
            },
          ];
        }),
      }));

      const message = createClearingRoundMessage({
        tokenId: AG_USDC_TOKEN_ID,
        version: BLS_CLEARING_ROUND_MESSAGE_VERSION,
        blocks,
      });
      const aggregateSignature = aggregateBlsSignatures(
        fixtures.map((f) => signBlsMessage(f.blsKeypair, message))
      );

      // Build remaining accounts: unique participant buckets, then unique pair-channel PDAs.
      // Dedupe both: when participant ids share a bucket slot (PARTICIPANT_BUCKET_SLOT_COUNT=9),
      // multiple fixtures can map to the same bucket PDA, and pair-channel PDAs are bidirectional
      // so 0>1 and 1>0 also collide.
      const seenChannels = new Set<string>();
      const channelMetas = directedPairs.flatMap(([pIdx, qIdx]) => {
        const channel = channels.get(`${pIdx}>${qIdx}`)!;
        const key = channel.channelPda.toString();
        if (seenChannels.has(key)) return [];
        seenChannels.add(key);
        return [{ pubkey: channel.channelPda, isSigner: false, isWritable: true }];
      });
      const seenBuckets = new Set<string>();
      const participantMetas = fixtures.flatMap((f) => {
        const key = f.participant.participantPda.toString();
        if (seenBuckets.has(key)) return [];
        seenBuckets.add(key);
        return [
          {
            pubkey: f.participant.participantPda,
            isSigner: false,
            isWritable: true,
          },
        ];
      });

      const balancesBefore = await Promise.all(
        fixtures.map((f) => fetchParticipantById(f.participant.participant.participantId))
      );
      const strategyBefore = await fetchYieldStrategy();

      await program.methods
        .settleClearingRound(message, [...aggregateSignature])
        .accounts({
          tokenRegistry: findTokenRegistryPda(),
          globalConfig: findGlobalConfigPda(),
          submitter: fixtures[0].participant.wallet.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        } as any)
        .remainingAccounts([...participantMetas, ...channelMetas])
        .preInstructions([
          ComputeBudgetProgram.requestHeapFrame({ bytes: BLS_TEST_HEAP_FRAME_BYTES }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: BLS_TEST_COMPUTE_UNIT_LIMIT }),
        ])
        .signers([fixtures[0].participant.wallet])
        .rpc();

      const balancesAfter = await Promise.all(
        fixtures.map((f) => fetchParticipantById(f.participant.participant.participantId))
      );
      const strategyAfter = await fetchYieldStrategy();

      const deltasObserved = balancesBefore.map((before, idx) => {
        const beforeBalance = getTokenBalance(before, AG_USDC_TOKEN_ID).availableBalance.toNumber();
        const afterBalance = getTokenBalance(balancesAfter[idx], AG_USDC_TOKEN_ID).availableBalance.toNumber();
        return afterBalance - beforeBalance;
      });
      // Net per the deltas above.
      expect(deltasObserved).to.deep.equal([0, 4_500_000, -4_500_000]);

      // Channel state.
      directedPairs.forEach(async ([pIdx, qIdx], entryIdx) => {
        const channel = channels.get(`${pIdx}>${qIdx}`)!;
        const after = await refetchDirectionalChannel(channel);
        expect(after.settledCumulative.toNumber()).to.equal(deltas[entryIdx]);
      });

      // Strategy is rate-blind: total_user_shares unchanged.
      expect(strategyAfter.totalUserShares).to.equal(strategyBefore.totalUserShares);

      await assertYieldStrategySolvent();
    });
  });

  describe("Cooperative unlock (cooperative_unlock_channel_funds)", () => {
    it("returns leftover locked agUSDC to the payer when both parties consent", async function () {
      this.timeout(60_000);

      const alice = await createTestParticipant();
      const bob = await createTestParticipant();
      await depositYieldBearingForTest({
        owner: alice.wallet,
        participantPda: alice.participantPda,
        amountUsdc: 5 * ONE_USDC,
      });
      await depositYieldBearingForTest({
        owner: bob.wallet,
        participantPda: bob.participantPda,
        amountUsdc: 1 * ONE_USDC,
      });

      const ensured = await ensureChannel(
        alice.wallet,
        bob.wallet.publicKey,
        AG_USDC_TOKEN_ID,
        { payeeOwnerSigner: bob.wallet }
      );
      await lockChannelFundsForTest(
        ensured,
        2 * ONE_USDC,
        alice.wallet,
        AG_USDC_TOKEN_ID
      );

      const aliceBefore = await fetchParticipantById(alice.participant.participantId);
      const aliceAvBefore = getTokenBalance(aliceBefore, AG_USDC_TOKEN_ID).availableBalance.toNumber();

      // Both signers agree to release the full 2 USDC of locked collateral back to Alice.
      await cooperativeUnlockChannelFundsForTest(
        ensured,
        2 * ONE_USDC,
        alice.wallet,
        bob.wallet,
        AG_USDC_TOKEN_ID
      );

      const aliceAfter = await fetchParticipantById(alice.participant.participantId);
      const aliceAvAfter = getTokenBalance(aliceAfter, AG_USDC_TOKEN_ID).availableBalance.toNumber();
      const channelAfter = await refetchDirectionalChannel(ensured);

      expect(aliceAvAfter - aliceAvBefore).to.equal(2 * ONE_USDC);
      expect(channelAfter.lockedBalance.toNumber()).to.equal(0);

      await assertYieldStrategySolvent();
    });
  });

  describe("Unilateral timelocked unlock (request + execute)", () => {
    it("releases locked agUSDC after the localnet 2-second channel-unlock timelock", async function () {
      this.timeout(60_000);

      const alice = await createTestParticipant();
      const bob = await createTestParticipant();
      await depositYieldBearingForTest({
        owner: alice.wallet,
        participantPda: alice.participantPda,
        amountUsdc: 5 * ONE_USDC,
      });
      await depositYieldBearingForTest({
        owner: bob.wallet,
        participantPda: bob.participantPda,
        amountUsdc: 1 * ONE_USDC,
      });

      const ensured = await ensureChannel(
        alice.wallet,
        bob.wallet.publicKey,
        AG_USDC_TOKEN_ID,
        { payeeOwnerSigner: bob.wallet }
      );
      await lockChannelFundsForTest(
        ensured,
        3 * ONE_USDC,
        alice.wallet,
        AG_USDC_TOKEN_ID
      );

      const aliceAvBefore = getTokenBalance(
        await fetchParticipantById(alice.participant.participantId),
        AG_USDC_TOKEN_ID
      ).availableBalance.toNumber();

      // Alice initiates a unilateral 1.5 USDC unlock (Bob is unresponsive; no countersig needed).
      await requestUnlockChannelFundsForTest(
        ensured,
        Math.floor(1.5 * ONE_USDC),
        alice.wallet,
        AG_USDC_TOKEN_ID
      );

      // Wait out the localnet timelock (chain_id=3 → channel_unlock_timelock_seconds=2).
      await sleep(3_000);

      await executeUnlockChannelFundsForTest(
        ensured,
        alice.wallet,
        AG_USDC_TOKEN_ID
      );

      const aliceAvAfter = getTokenBalance(
        await fetchParticipantById(alice.participant.participantId),
        AG_USDC_TOKEN_ID
      ).availableBalance.toNumber();
      const channelAfter = await refetchDirectionalChannel(ensured);

      expect(aliceAvAfter - aliceAvBefore).to.equal(Math.floor(1.5 * ONE_USDC));
      expect(channelAfter.lockedBalance.toNumber()).to.equal(
        3 * ONE_USDC - Math.floor(1.5 * ONE_USDC)
      );

      await assertYieldStrategySolvent();
    });
  });

  describe("End-to-end: deposit → settle (mixed) → accrue → withdraw", () => {
    it("preserves solvency through bilateral + BLS settlement, mid-flight yield accrual, and withdrawal", async function () {
      this.timeout(180_000);

      // Two participants. Alice will pay Bob both bilaterally and via a BLS-aggregated round.
      const alice = await createTestParticipant();
      const bob = await createTestParticipant();
      await depositYieldBearingForTest({
        owner: alice.wallet,
        participantPda: alice.participantPda,
        amountUsdc: 20 * ONE_USDC,
      });
      await depositYieldBearingForTest({
        owner: bob.wallet,
        participantPda: bob.participantPda,
        amountUsdc: 1 * ONE_USDC,
      });

      // Channel + lock 6 USDC.
      const ensured = await ensureChannel(
        alice.wallet,
        bob.wallet.publicKey,
        AG_USDC_TOKEN_ID,
        { payeeOwnerSigner: bob.wallet }
      );
      await lockChannelFundsForTest(
        ensured,
        6 * ONE_USDC,
        alice.wallet,
        AG_USDC_TOKEN_ID
      );

      // 1) Bilateral: cumulative_amount = 1 USDC.
      const msg1 = createCommitmentMessage({
        payerId: alice.participant.participantId,
        payeeId: bob.participant.participantId,
        tokenId: AG_USDC_TOKEN_ID,
        committedAmount: new anchor.BN(ONE_USDC),
      });
      await settleIndividualForTest({
        ensured,
        message: msg1,
        signer: alice.wallet,
        submitter: bob.wallet,
      });
      await assertYieldStrategySolvent();

      // 2) Accrue some yield to advance the index, then a second bilateral settlement at
      // cumulative=2 USDC (delta=1 USDC). Settlement is rate-blind — the delta moves regardless of
      // the current index.
      await accrueYieldForTest();
      const msg2 = createCommitmentMessage({
        payerId: alice.participant.participantId,
        payeeId: bob.participant.participantId,
        tokenId: AG_USDC_TOKEN_ID,
        committedAmount: new anchor.BN(2 * ONE_USDC),
      });
      await settleIndividualForTest({
        ensured,
        message: msg2,
        signer: alice.wallet,
        submitter: bob.wallet,
      });
      await assertYieldStrategySolvent();

      // 3) Cooperative unlock of remaining 4 USDC.
      await cooperativeUnlockChannelFundsForTest(
        ensured,
        4 * ONE_USDC,
        alice.wallet,
        bob.wallet,
        AG_USDC_TOKEN_ID
      );
      await assertYieldStrategySolvent();

      // 4) Withdraw — Alice's remaining 18 USDC (= 20 deposited - 2 paid), Bob's 3 USDC (= 1 + 2).
      const aliceParticipant = await fetchParticipantById(alice.participant.participantId);
      const bobParticipant = await fetchParticipantById(bob.participant.participantId);
      const aliceShares = getTokenBalance(aliceParticipant, AG_USDC_TOKEN_ID).availableBalance;
      const bobShares = getTokenBalance(bobParticipant, AG_USDC_TOKEN_ID).availableBalance;

      // Allow a 1-microunit dust window — `accrue_strategy` runs at deposit time and converts the
      // deposited USDC to shares at the current index using floor division, so a 20 USDC deposit
      // can mint 19_999_999 shares when the index has already advanced. Bob's deposit was earlier
      // so it tends to round cleanly.
      expect(aliceShares.toNumber()).to.be.within(18 * ONE_USDC - 2, 18 * ONE_USDC);
      expect(bobShares.toNumber()).to.be.within(3 * ONE_USDC - 2, 3 * ONE_USDC);

      const { destinationUsdcAta: aliceUsdcAta } = await withdrawYieldBearingForTest({
        owner: alice.wallet,
        shares: aliceShares,
      });
      const { destinationUsdcAta: bobUsdcAta } = await withdrawYieldBearingForTest({
        owner: bob.wallet,
        shares: bobShares,
      });

      const [aliceUsdcAcc, bobUsdcAcc] = await Promise.all([
        getAccount(program.provider.connection, aliceUsdcAta),
        getAccount(program.provider.connection, bobUsdcAta),
      ]);

      // Withdrawal pays gross_usdc - max(0.3% pct fee, 0.05 USDC min fee). With 18 USDC gross, the
      // pct fee (0.054 USDC) wins; with 3 USDC gross, the floor (0.05 USDC) wins. Yield boosts
      // these slightly upward, so we assert against an envelope that bounds the rounding.
      const aliceReceived = Number(aliceUsdcAcc.amount);
      const bobReceived = Number(bobUsdcAcc.amount);

      expect(aliceReceived).to.be.greaterThan(18 * ONE_USDC - 60_000); // ≤ 0.06 fee+rounding
      expect(aliceReceived).to.be.lessThanOrEqual(18 * ONE_USDC + 100); // tiny yield uplift OK
      expect(bobReceived).to.be.greaterThan(3 * ONE_USDC - 60_000);
      expect(bobReceived).to.be.lessThanOrEqual(3 * ONE_USDC + 100); // tiny yield uplift OK

      // Final solvency: only the protocol's owed yield + un-withdrawn dust remains.
      const final = await assertYieldStrategySolvent();
      expect(final >= 0n).to.be.true;
    });
  });
});
