import { expect } from "chai";
import {
  createTestParticipant,
  ensureChannel,
  refetchDirectionalChannel,
} from "./shared/setup";

describe("Bucketed Clearing Runtime Assumptions", () => {
  it("creates a bucket-backed unilateral lane with zero cumulative settlement", async () => {
    const payer = await createTestParticipant();
    const payee = await createTestParticipant();
    const { channel } = await ensureChannel(payer.wallet, payee.wallet.publicKey, 1);

    expect(channel.settledCumulative.toNumber()).to.equal(0);
    expect(channel.lockedBalance.toNumber()).to.equal(0);
  });

  it("stores reciprocal lanes inside the same pair-channel bucket account", async () => {
    const alice = await createTestParticipant();
    const bob = await createTestParticipant();
    const aliceToBob = await ensureChannel(
      alice.wallet,
      bob.wallet.publicKey,
      1
    );
    const bobToAlice = await ensureChannel(
      bob.wallet,
      alice.wallet.publicKey,
      1
    );

    expect(aliceToBob.channelPda.toString()).to.equal(
      bobToAlice.channelPda.toString()
    );

    const aliceLane = await refetchDirectionalChannel(aliceToBob);
    const bobLane = await refetchDirectionalChannel(bobToAlice);
    expect(aliceLane.payerId).to.equal(alice.participant.participantId);
    expect(aliceLane.payeeId).to.equal(bob.participant.participantId);
    expect(bobLane.payerId).to.equal(bob.participant.participantId);
    expect(bobLane.payeeId).to.equal(alice.participant.participantId);
  });
});
