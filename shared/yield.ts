/**
 * Thin mirror of the SDK's USDC<->shares helpers for use inside the agon-protocol repo's own
 * ts-mocha tests and devnet demo scripts. The SDK at `@agonx402/sdk` is the canonical source —
 * this file deliberately stays in sync with `packages/sdk/src/yield.ts` and only re-implements
 * the math without importing the SDK package (so the protocol repo can run its tests / demos
 * without a workspace dep on the SDK).
 */

import * as anchor from "@coral-xyz/anchor";

export const Q64 = 1n << 64n;

export interface YieldStrategySnapshot {
  userIndexQ64: bigint;
}

function toBigInt(value: anchor.BN | bigint | number | string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return BigInt(value.toString());
}

export function usdcToAgShares(
  strategy: YieldStrategySnapshot,
  usdc: bigint | number | string | anchor.BN
): bigint {
  const usdcBig = toBigInt(usdc);
  if (usdcBig === 0n) return 0n;
  const indexQ64 = toBigInt(strategy.userIndexQ64);
  if (indexQ64 === 0n) {
    throw new Error("YieldStrategy.user_index_q64 is zero; uninitialized strategy");
  }
  return (usdcBig * Q64) / indexQ64;
}

export function agSharesToUsdc(
  strategy: YieldStrategySnapshot,
  shares: bigint | number | string | anchor.BN
): bigint {
  const sharesBig = toBigInt(shares);
  if (sharesBig === 0n) return 0n;
  const indexQ64 = toBigInt(strategy.userIndexQ64);
  return (sharesBig * indexQ64) >> 64n;
}

export function nextCommitmentAmountUsd(params: {
  settledCumulativeShares: anchor.BN | bigint | number | string;
  deltaUsdc: bigint | number | string | anchor.BN;
  strategy: YieldStrategySnapshot;
}): bigint {
  const prior = toBigInt(params.settledCumulativeShares);
  const newShares = usdcToAgShares(params.strategy, params.deltaUsdc);
  return prior + newShares;
}

export function formatUsdc(amount: bigint, decimals: number = 6): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const wholeStr = whole.toString();
  const body = fracStr.length === 0 ? wholeStr : `${wholeStr}.${fracStr}`;
  return negative ? `-${body}` : body;
}
