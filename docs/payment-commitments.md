# Ryvo Payment Commitments

Status: Current  
Date: 2026-04-08

## Summary

Ryvo uses cumulative payment commitments as the unilateral hot path.

A commitment is:

- signed by the payer-side channel signer
- scoped to one permanent unilateral lane
- cumulative rather than per-payment
- settled by redeeming only the delta above the lane's previously settled amount

Ryvo's protocol surface is:

- **direct edge primitive**: unilateral cumulative commitments
- **operational batching primitive**: bundle settlement across many unilateral lanes
- **network compression primitive**: cooperative clearing rounds that advance many lanes and apply only net participant balance changes

## Lane Semantics

For any relationship between two agents, Ryvo keeps two unilateral lanes per token:

- `A -> B`
- `B -> A`

Each lane is permanent for the life of the deployment and is identified on-chain by:

- `payer_id`
- `payee_id`
- `token_id`

Participant identities are permanent per wallet. A wallet can register once, keeps the same `participant_id` for the lifetime of the deployment, and must use a different wallet if it wants a different identity.

Each lane stores:

- `settled_cumulative`
- `locked_balance`
- `authorized_signer`
- optional pending unlock state
- optional pending signer-rotation state

Across deployments, replay protection comes from the immutable `message_domain`
that Ryvo derives in-program from the deployed `program_id` and configured
`chain_id` during bootstrap. `mainnet`, `devnet`, `testnet`, and `localnet`
use distinct chain ids.

## Direct Settlement

The signed unilateral message format is `ryvo-cmt-v5`.

See `docs/client-message-schemas.md` for the exact byte layout.

When a payee settles a commitment, the program:

1. verifies the Ed25519 signature
2. verifies the `message_domain`
3. verifies `payer_id`, `payee_id`, and `token_id`
4. verifies `committed_amount > settled_cumulative`
5. computes `delta = committed_amount - settled_cumulative`
6. debits the payer by the delta
7. credits the payee internally inside the Ryvo vault
8. updates `settled_cumulative`

The payee does not need intermediate checkpoints. The latest valid cumulative commitment is enough.

If an operator or coordinator needs to be paid, that compensation should be
modeled as an ordinary lane payment such as `seller -> operator` or
`payer -> coordinator`, not as a special field embedded inside the unilateral
commitment.

## Bundle Settlement

Bundle settlement is the right batching model for one seller with many buyers.

Example:

- buyer 1 signs a latest commitment on `B1 -> Seller`
- buyer 2 signs a latest commitment on `B2 -> Seller`
- buyer 3 signs a latest commitment on `B3 -> Seller`

The seller can submit all of those latest commitments in one transaction.

Important:

- this is **not** multilateral netting
- each lane is settled independently
- bundle settlement only reduces transaction count for many unilateral redemptions

## Clearing Rounds

Clearing rounds are where Ryvo goes beyond plain unilateral settlement.

A clearing round:

- references many unilateral lanes
- advances each lane to a higher `target_cumulative`
- computes the delta on each included lane
- applies only the **net participant balance changes**

So the same cumulative edge model can be used in two ways:

- **directly** through unilateral or bundle settlement
- **cooperatively** through facilitator- or participant-proposed clearing rounds

The signed round format is `ryvo-round-v4`.

It uses:

- a shared `message_domain`
- a signed participant roster
- `payee_ref` indexes instead of repeated payee ids
- compact varints for ids and cumulative amounts

## Worked Example

Suppose a clearing round includes these lane deltas:

- `A -> B = 50`
- `B -> C = 10`
- `C -> A = 10`

Ryvo advances all included unilateral lanes to their latest cumulative targets, then applies only the residual participant balance changes:

- `A = -40`
- `B = +40`
- `C = 0`

That is the key distinction:

- lanes still advance individually
- participant balances move only by the net result

## Locked And Trust-Based Flows

Ryvo supports both risk modes on the same lane model:

- **locked mode**: the payer locks lane-specific collateral with `lock_channel_funds`
- **trust-based mode**: the payee accepts unsecured commitments based on external trust policy

If collateral is present, settlement drains in this order:

1. `locked_balance`
2. payer available balance
3. payer withdrawing balance

Permanent lanes use maintenance flows instead of close/reopen:

- `request_unlock_channel_funds` / `execute_unlock_channel_funds`
- `request_update_channel_authorized_signer` / `execute_update_channel_authorized_signer`

So:

- a commitment is the authorization primitive
- locked balance is the liquidity guarantee primitive
- clearing rounds are the compression primitive
