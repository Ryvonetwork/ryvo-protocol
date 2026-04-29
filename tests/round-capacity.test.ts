import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  findLargestCycleRound,
  findLargestOverallRound,
  measureClearingRoundCapacity,
} from "../scripts/lib/clearing-round-capacity";

describe("BLS clearing round capacity sizing", function () {
  this.timeout(30_000);
  const programId = new PublicKey("11111111111111111111111111111111");
  const maxParticipants = 16;

  it("models the canonical BLS v0 + ALT path", () => {
    const threeParticipantCycle = measureClearingRoundCapacity({
      programId,
      mode: "bls-v0-alt",
      participantCount: 3,
      channelCount: 3,
    });

    expect(threeParticipantCycle.fits).to.equal(true);
    expect(threeParticipantCycle.participantBucketCount).to.equal(1);
    expect(threeParticipantCycle.channelBucketCount).to.equal(1);
  });

  it("shows v0 + ALT improves BLS packet capacity", () => {
    const blsOverall = findLargestOverallRound({
      programId,
      mode: "bls",
      maxParticipants,
    });
    const blsV0AltOverall = findLargestOverallRound({
      programId,
      mode: "bls-v0-alt",
      maxParticipants,
    });

    expect(blsV0AltOverall.fits).to.equal(true);
    expect(blsV0AltOverall.channelCount).to.be.greaterThan(
      blsOverall.channelCount
    );
  });

  it("finds balanced and overall BLS capacity ceilings", () => {
    const blsCycle = findLargestCycleRound({
      programId,
      mode: "bls-v0-alt",
      maxParticipants,
    });
    const blsOverall = findLargestOverallRound({
      programId,
      mode: "bls-v0-alt",
      maxParticipants,
    });

    expect(blsCycle.fits).to.equal(true);
    expect(blsOverall.fits).to.equal(true);
    expect(blsOverall.channelCount).to.be.greaterThanOrEqual(
      blsCycle.channelCount
    );
  });

  it("models bucketed BLS clearing locks as participant buckets plus channel buckets", () => {
    const denseHundredParticipantRound = measureClearingRoundCapacity({
      programId,
      mode: "bls-v0-alt",
      participantCount: 100,
      channelCount: 9_900,
    });
    const reciprocalSixtyFourParticipantRound = measureClearingRoundCapacity({
      programId,
      mode: "bls-v0-alt",
      participantCount: 64,
      channelCount: 128,
    });

    expect(denseHundredParticipantRound.participantBucketCount).to.equal(2);
    expect(denseHundredParticipantRound.channelBucketCount).to.equal(39);
    expect(denseHundredParticipantRound.dynamicWritableAccountCount).to.equal(
      41
    );
    expect(reciprocalSixtyFourParticipantRound.participantBucketCount).to.equal(
      1
    );
    expect(reciprocalSixtyFourParticipantRound.channelBucketCount).to.equal(16);
    expect(
      reciprocalSixtyFourParticipantRound.dynamicWritableAccountCount
    ).to.equal(17);
  });
});
