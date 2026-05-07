# Ryvo Public Messaging

Status: Current  
Date: 2026-03-26

## Positioning Lines

Use these as the default framing:

- Ryvo is the non-custodial clearing layer for machine payments on Solana.
- Solana provides execution and final settlement.
- Ryvo decouples payment execution from settlement.
- Latest cumulative commitments improve `1:1` scaling.
- Clearing rounds preserve `1:many` and `many:many` scaling.

Short taglines:

- Solana settles. Ryvo clears.
- The clearing layer for machine payments.
- Payment execution off-chain. Clearing on-chain.

## Demo Intro

Short version:

> Payments do not scale one transaction at a time.
>
> Ryvo is the non-custodial clearing layer for machine payments on Solana.
>
> It decouples payment execution from settlement, so payment activity can scale off-chain while Solana handles final settlement.
>
> In this demo, we show latest commitment settlement for `1:1`, bundled commitment settlement for many buyers, and clearing rounds for single-payer, bilateral, and multilateral clearing.
>
> Let's run it.

Even shorter version:

> Ryvo is the non-custodial clearing layer for machine payments on Solana.
>
> Payment execution stays off-chain. Solana handles final settlement.
>
> This demo shows latest commitments, bundle settlement, and clearing rounds in action.

## Demo Outro

Recommended close:

> What you just saw is the core Ryvo model in practice.
>
> Latest cumulative commitments make `1:1` payment flow much simpler to scale, while clearing rounds let many unilateral channels be advanced together and settled by net participant balance change.
>
> That means Ryvo can scale `1:1`, `1:many`, and `many:many` payment flow without requiring every payment to become its own on-chain transaction.
>
> Solana settles. Ryvo clears.

## Short X Post

> Ryvo decouples payment execution from settlement.
>
> Latest commitments scale `1:1`.
> Clearing rounds scale `1:many` and `many:many`.
>
> Solana settles.
> Ryvo clears.

## Demo Thread Follow-Up

Thread continuation after the video:

> In this demo:
>
> - latest cumulative commitments handle direct `1:1` flow
> - bundle settlement lets one seller settle many buyer channels in one tx
> - clearing rounds advance many channels and apply only net participant balance changes
>
> That is the important distinction:
>
> - commitments are the authorization primitive
> - locked funds are the liquidity guarantee primitive
> - clearing rounds are the compression primitive

Worked example for the thread:

> If `A -> B = 50`, `B -> C = 10`, and `C -> A = 10`, Ryvo advances all included unilateral channels and applies only the net result:
>
> - `A = -40`
> - `B = +40`
> - `C = 0`

## Builder Chat Message

> Hey everyone, I just posted a demo of what I've been working on. If this is in your area of interest, feel free to reach out — always looking to connect with like-minded builders.
