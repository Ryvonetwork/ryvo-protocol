import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { measureClearingRoundCapacity } from "../scripts/lib/clearing-round-capacity";

describe("Bucketed multilateral capacity", () => {
  const programId = new PublicKey("11111111111111111111111111111111");

  it("models 32 participants / 80 directed channels as bucket locks instead of account-per-row locks", () => {
    const measurement = measureClearingRoundCapacity({
      programId,
      mode: "hypothetical-bls-v0-alt",
      participantCount: 32,
      channelCount: 80,
    });

    expect(measurement.participantBucketCount).to.equal(Math.ceil(32 / 9));
    expect(measurement.channelBucketCount).to.be.greaterThan(0);
    expect(measurement.dynamicWritableAccountCount).to.equal(
      measurement.participantBucketCount + measurement.channelBucketCount
    );
    expect(measurement.dynamicWritableAccountCount).to.be.lessThan(32 + 80);
  });

  it("keeps 100 participants / 256 channels below account-per-row locking", () => {
    const measurement = measureClearingRoundCapacity({
      programId,
      mode: "hypothetical-bls-v0-alt",
      participantCount: 100,
      channelCount: 256,
    });

    expect(measurement.participantBucketCount).to.equal(Math.ceil(100 / 9));
    expect(measurement.channelBucketCount).to.be.greaterThan(0);
    expect(measurement.dynamicWritableAccountCount).to.equal(
      measurement.participantBucketCount + measurement.channelBucketCount
    );
    expect(measurement.dynamicWritableAccountCount).to.be.lessThan(100 + 256);
  });
});
