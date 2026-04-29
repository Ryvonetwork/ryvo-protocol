export function getCanonicalChannelParticipants(
  payerId: number,
  payeeId: number
) {
  return {
    lowerParticipantId: Math.min(payerId, payeeId),
    higherParticipantId: Math.max(payerId, payeeId),
  };
}

export function normalizeChannelBucketState(
  channelBucket: any,
  payerId: number,
  payeeId: number,
  channelBucketSlotIndexForPair: (payerId: number, payeeId: number) => number
) {
  const { lowerParticipantId, higherParticipantId } =
    getCanonicalChannelParticipants(payerId, payeeId);
  const slot =
    channelBucket.slots[channelBucketSlotIndexForPair(payerId, payeeId)];
  if (
    !slot?.initialized ||
    slot.lowerParticipantId !== lowerParticipantId ||
    slot.higherParticipantId !== higherParticipantId
  ) {
    throw new Error(
      `Channel bucket slot is not initialized for ${payerId}->${payeeId}`
    );
  }
  return {
    tokenId: channelBucket.tokenId,
    lowerParticipantId,
    higherParticipantId,
    lowerToHigher: slot.lowerToHigher,
    higherToLower: slot.higherToLower,
  };
}

export function getDirectionalLaneState(
  pairChannel: {
    lowerParticipantId: number;
    higherParticipantId: number;
    lowerToHigher: any;
    higherToLower: any;
  },
  payerId: number,
  payeeId: number
) {
  if (payerId === payeeId) {
    throw new Error("Self channels are not supported");
  }

  const { lowerParticipantId, higherParticipantId } =
    getCanonicalChannelParticipants(payerId, payeeId);

  if (
    pairChannel.lowerParticipantId !== lowerParticipantId ||
    pairChannel.higherParticipantId !== higherParticipantId
  ) {
    throw new Error(
      `Pair channel does not match direction ${payerId}->${payeeId}`
    );
  }

  return payerId < payeeId
    ? pairChannel.lowerToHigher
    : pairChannel.higherToLower;
}

export function normalizeDirectionalChannelState(
  pairChannel: {
    tokenId: number;
    lowerParticipantId: number;
    higherParticipantId: number;
    lowerToHigher: any;
    higherToLower: any;
  },
  payerId: number,
  payeeId: number
) {
  return {
    payerId,
    payeeId,
    tokenId: pairChannel.tokenId,
    ...getDirectionalLaneState(pairChannel, payerId, payeeId),
  };
}

export function normalizeParticipantBucketSlot(slot: any) {
  return {
    owner: slot.owner,
    participantId: slot.participantId,
    tokenBalances: (slot.tokenBalances ?? [])
      .filter((balance: any) => balance.initialized)
      .map((balance: any) => ({
        tokenId: balance.tokenId,
        availableBalance: balance.availableBalance,
        withdrawingBalance: balance.withdrawingBalance,
        withdrawalUnlockAt: balance.withdrawalUnlockAt,
        withdrawalDestination: balance.withdrawalDestination,
      })),
    bump: 0,
    inboundChannelPolicy: slot.inboundChannelPolicy,
    blsSchemeVersion: slot.blsSchemeVersion,
    blsPubkeyCompressed: slot.blsPubkeyCompressed,
  };
}
