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

    expect(measurement.participantBucketCount).to.equal(1);
    expect(measurement.channelBucketCount).to.equal(1);
    expect(measurement.dynamicWritableAccountCount).to.equal(2);
  });

  it("keeps 100 participants / 256 channels account-lock feasible under the bucket model", () => {
    const measurement = measureClearingRoundCapacity({
      programId,
      mode: "hypothetical-bls-v0-alt",
      participantCount: 100,
      channelCount: 256,
    });

    expect(measurement.participantBucketCount).to.equal(2);
    expect(measurement.dynamicWritableAccountCount).to.be.lessThan(64);
  });
});
