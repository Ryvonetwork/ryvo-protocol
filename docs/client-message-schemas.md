# Client Message Schemas

Status: Current  
Date: 2026-04-08

This document describes the only supported signed message formats in the protocol today.

Replay protection comes from:

- an immutable 16-byte `message_domain` derived in-program from `program_id` and an environment-specific `chain_id`
- the signed `token_id`
- the signed payer/payee participant ids
- monotonic `committed_amount` / `target_cumulative`

Participant IDs are permanent for the lifetime of a deployment, and payment lanes are permanent per `payer_id + payee_id + token_id`.

## `ryvo-cmt-v5`

`ryvo-cmt-v5` is the unilateral cumulative commitment format used by:

- `settle_individual`
- `settle_commitment_bundle`

### Fixed Header

| Offset | Size | Field |
| ------ | ---- | ----- |
| `0` | `1` | `message_kind = 0x01` |
| `1` | `1` | `version = 0x05` |
| `2` | `16` | `message_domain` |
| `18` | `1` | `flags` |

Flag bits:

- bit `0`: `authorized_settler` present

### Dynamic Body

After the fixed header, fields are encoded in this order:

1. `payer_id` as compact unsigned varint
2. `payee_id` as compact unsigned varint
3. `token_id` as `u16` little endian
4. `committed_amount` as compact unsigned varint
5. optional `authorized_settler` as 32 raw bytes

### Settlement Rules

- The Ed25519 signer must match `channel_state.authorized_signer`.
- `message_domain` must equal `global_config.message_domain`.
- `payer_id`, `payee_id`, and `token_id` must match the target channel.
- `committed_amount` must be strictly greater than `channel_state.settled_cumulative`.
- The settled delta is `committed_amount - settled_cumulative`.
- The submitter must be:
  - the payee owner, or
  - the encoded `authorized_settler`

Operator or coordinator compensation is not embedded in the unilateral message.
If a service flow needs to pay an operator, that payment should be represented as
its own ordinary lane commitment.

## `ryvo-round-v4`

`ryvo-round-v4` is the cooperative clearing-round format used by `settle_clearing_round`.

### Fixed Header

| Offset | Size | Field |
| ------ | ---- | ----- |
| `0` | `1` | `message_kind = 0x02` |
| `1` | `1` | `version = 0x04` |
| `2` | `16` | `message_domain` |
| `18` | `2` | `token_id` (`u16`, little endian) |
| `20` | `1` | `participant_count` (`u8`) |

### Participant Blocks

The message then contains `participant_count` blocks.

Each participant block is:

1. `participant_id` as compact unsigned varint
2. `entry_count` as `u8`
3. `entry_count` channel entries

Each channel entry is:

1. `payee_ref` as `u8`
2. `target_cumulative` as compact unsigned varint

`payee_ref` is the zero-based index of the credited participant block inside the signed participant roster.

### Settlement Rules

- `message_domain` must equal `global_config.message_domain`.
- `token_id` must match every included channel.
- Every participant block must be unique by `participant_id`.
- Every credited payee must appear in the signed participant roster.
- For each included channel:
  - the payer must equal the enclosing block's `participant_id`
  - the payee must equal the participant referenced by `payee_ref`
  - `target_cumulative` must be strictly greater than `settled_cumulative`
- The round must carry one Ed25519 signature per participant block today.

### Submission Notes

The live cooperative path today is:

- one shared `ryvo-round-v4` message
- one Ed25519 signature per participant
- optional v0 transactions with Address Lookup Tables to compress account keys

BLS can later replace the per-participant signature overhead without changing the signed round body.
