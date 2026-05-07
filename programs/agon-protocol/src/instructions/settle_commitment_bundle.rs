use anchor_lang::prelude::*;

use crate::balance_deltas::{add_balance_delta, ParticipantBalanceDelta};
use crate::ed25519;
use crate::errors::VaultError;
use crate::events::CommitmentBundleSettled;
use crate::instructions::settle_individual::{parse_commitment_message, ParsedCommitmentMessage};
use crate::state::{ChannelBucket, GlobalConfig, ParticipantBucket, TokenRegistry};

struct ParsedBundleCommitment {
    parsed: ParsedCommitmentMessage,
    signer_pubkey: Pubkey,
}

fn insert_seen_sorted_u32(values: &mut Vec<u32>, value: u32) -> bool {
    match values.binary_search(&value) {
        Ok(_) => false,
        Err(index) => {
            values.insert(index, value);
            true
        }
    }
}

fn insert_unique_sorted_u64(values: &mut Vec<u64>, value: u64) -> Result<()> {
    match values.binary_search(&value) {
        Ok(_) => Err(error!(VaultError::InvalidCommitmentMessage)),
        Err(index) => {
            values.insert(index, value);
            Ok(())
        }
    }
}

fn lane_key(payer_id: u32, payee_id: u32) -> u64 {
    ((payer_id as u64) << 32) | payee_id as u64
}

fn find_bucket_account_index(bindings: &[(u32, usize)], bucket_id: u32) -> Result<usize> {
    bindings
        .binary_search_by_key(&bucket_id, |(bound_bucket_id, _)| *bound_bucket_id)
        .map(|index| bindings[index].1)
        .map_err(|_| error!(VaultError::ParticipantNotFound))
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleCommitmentBundle<'info>>,
    count: u8,
) -> Result<()> {
    let program_id = ctx.program_id;

    ed25519::assert_no_cpi(&ctx.accounts.instructions_sysvar, program_id)?;
    require!(count > 0, VaultError::InvalidCommitmentMessage);

    let ix_data = ed25519::verify_ed25519_ix(&ctx.accounts.instructions_sysvar, 0)?;
    require!(
        ix_data.first().copied() == Some(count),
        VaultError::InvalidCommitmentMessage
    );
    let remaining = &ctx.remaining_accounts;
    let submitter = ctx.accounts.submitter.key();

    let mut token_id: Option<u16> = None;
    let mut payee_id: Option<u32> = None;
    let mut total: u64 = 0;
    let mut seen_lane_keys = Vec::with_capacity(count as usize);
    let mut parsed_commitments = Vec::with_capacity(count as usize);
    let mut seen_participant_bucket_ids = Vec::with_capacity(count as usize + 1);
    let mut participant_bucket_ids: Vec<u32> = Vec::with_capacity(count as usize + 1);
    let mut channel_bucket_bindings: Vec<(u64, usize)> = Vec::with_capacity(count as usize);
    let mut processed_channel_count = 0u16;
    let mut balance_deltas: Vec<ParticipantBalanceDelta> = Vec::with_capacity((count as usize) + 1);

    for i in 0..count as usize {
        let offsets = ed25519::parse_ed25519_offsets(&ix_data, i as u16)?;
        let signer_pubkey = ed25519::extract_pubkey(&ix_data, &offsets)?;
        let message = ed25519::extract_message(&ix_data, &offsets)?;

        let parsed = parse_commitment_message(&message, &ctx.accounts.global_config)?;

        match token_id {
            Some(existing) => require!(
                existing == parsed.token_id,
                VaultError::InvalidCommitmentMessage
            ),
            None => token_id = Some(parsed.token_id),
        }
        match payee_id {
            Some(existing) => require!(existing == parsed.payee_id, VaultError::AccountIdMismatch),
            None => {
                payee_id = Some(parsed.payee_id);
                let payee_bucket_id =
                    ParticipantBucket::bucket_id_for_participant_id(parsed.payee_id);
                if insert_seen_sorted_u32(&mut seen_participant_bucket_ids, payee_bucket_id) {
                    participant_bucket_ids.push(payee_bucket_id);
                }
            }
        }
        let payer_bucket_id = ParticipantBucket::bucket_id_for_participant_id(parsed.payer_id);
        if insert_seen_sorted_u32(&mut seen_participant_bucket_ids, payer_bucket_id) {
            participant_bucket_ids.push(payer_bucket_id);
        }
        parsed_commitments.push(ParsedBundleCommitment {
            parsed,
            signer_pubkey,
        });
    }

    let batch_token_id = token_id.ok_or(error!(VaultError::InvalidCommitmentMessage))?;
    ctx.accounts
        .token_registry
        .find_token(batch_token_id)
        .ok_or(VaultError::TokenNotFound)?;
    let payee_id = payee_id.ok_or(error!(VaultError::InvalidCommitmentMessage))?;
    require!(
        remaining.len() >= participant_bucket_ids.len(),
        VaultError::InvalidCommitmentMessage
    );

    let mut participant_bucket_bindings: Vec<(u32, usize)> =
        Vec::with_capacity(participant_bucket_ids.len());
    for (index, bucket_id) in participant_bucket_ids.iter().enumerate() {
        ParticipantBucket::verify_account_info(&remaining[index], *bucket_id, program_id)?;
        let insert_index = participant_bucket_bindings
            .binary_search_by_key(bucket_id, |(bound_bucket_id, _)| *bound_bucket_id)
            .unwrap_err();
        participant_bucket_bindings.insert(insert_index, (*bucket_id, index));
    }

    let payee_bucket_index = find_bucket_account_index(
        &participant_bucket_bindings,
        ParticipantBucket::bucket_id_for_participant_id(payee_id),
    )?;
    let payee_data = remaining[payee_bucket_index].try_borrow_data()?;
    let payee_owner = ParticipantBucket::read_slot_owner_from_data(payee_data.as_ref(), payee_id)?;
    drop(payee_data);

    let mut next_channel_bucket_account_index = participant_bucket_ids.len();
    for commitment in &parsed_commitments {
        let parsed = &commitment.parsed;
        let submitter_ok = submitter == payee_owner
            || parsed
                .authorized_settler
                .map(|settler| settler == submitter)
                .unwrap_or(false);
        require!(submitter_ok, VaultError::UnauthorizedSettler);
        insert_unique_sorted_u64(
            &mut seen_lane_keys,
            lane_key(parsed.payer_id, parsed.payee_id),
        )?;

        let (lower_id, higher_id, lane_selector) =
            ChannelBucket::canonicalize(parsed.payer_id, parsed.payee_id)?;
        let channel_bucket_id = ChannelBucket::bucket_id_for_pair(lower_id, higher_id)?;
        let channel_bucket_index = if let Some((_, index)) = channel_bucket_bindings
            .binary_search_by_key(&channel_bucket_id, |(bound_bucket_id, _)| *bound_bucket_id)
            .ok()
            .map(|binding_index| channel_bucket_bindings[binding_index])
        {
            index
        } else {
            require!(
                next_channel_bucket_account_index < remaining.len(),
                VaultError::InvalidCommitmentMessage
            );
            let channel_info = &remaining[next_channel_bucket_account_index];
            ChannelBucket::verify_account_info(
                channel_info,
                parsed.token_id,
                channel_bucket_id,
                program_id,
            )?;
            let insert_index = channel_bucket_bindings
                .binary_search_by_key(&channel_bucket_id, |(bound_bucket_id, _)| *bound_bucket_id)
                .unwrap_err();
            channel_bucket_bindings.insert(
                insert_index,
                (channel_bucket_id, next_channel_bucket_account_index),
            );
            next_channel_bucket_account_index += 1;
            next_channel_bucket_account_index - 1
        };

        let channel_data = remaining[channel_bucket_index].try_borrow_data()?;
        let lane = ChannelBucket::read_lane_commitment_for_selector_from_data(
            channel_data.as_ref(),
            lower_id,
            higher_id,
            lane_selector,
        )?;
        require!(
            commitment.signer_pubkey == lane.authorized_signer,
            VaultError::InvalidSignature
        );
        require!(
            parsed.committed_amount > lane.settled_cumulative,
            VaultError::CommitmentAmountMustIncrease
        );
        let amount = parsed
            .committed_amount
            .checked_sub(lane.settled_cumulative)
            .ok_or(error!(VaultError::MathOverflow))?;
        let lane_locked_balance = lane.locked_balance;
        let locked_consumed = lane_locked_balance.min(amount);
        drop(channel_data);

        let payer_bucket_id = ParticipantBucket::bucket_id_for_participant_id(parsed.payer_id);
        let payer_bucket_index =
            find_bucket_account_index(&participant_bucket_bindings, payer_bucket_id)?;
        let payer_data = remaining[payer_bucket_index].try_borrow_data()?;
        let total_available = lane_locked_balance
            .checked_add(ParticipantBucket::read_token_total_balance_from_data(
                payer_data.as_ref(),
                parsed.payer_id,
                parsed.token_id,
            )?)
            .ok_or(error!(VaultError::MathOverflow))?;
        drop(payer_data);
        require!(total_available >= amount, VaultError::InsufficientBalance);

        let shared_debit = amount
            .checked_sub(locked_consumed)
            .ok_or(error!(VaultError::MathOverflow))?;
        total = total
            .checked_add(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        add_balance_delta(
            &mut balance_deltas,
            parsed.payer_id,
            -(shared_debit as i128),
        )?;
        add_balance_delta(&mut balance_deltas, parsed.payee_id, amount as i128)?;

        let mut channel_data = remaining[channel_bucket_index].try_borrow_mut_data()?;
        ChannelBucket::apply_lane_settlement_at_offset_in_data(
            channel_data.as_mut(),
            lane.lane_offset,
            parsed.committed_amount,
            locked_consumed,
        )?;
        processed_channel_count = processed_channel_count
            .checked_add(1)
            .ok_or(error!(VaultError::MathOverflow))?;
    }

    require!(
        next_channel_bucket_account_index == remaining.len(),
        VaultError::InvalidCommitmentMessage
    );

    for (bucket_index, bucket_id) in participant_bucket_ids.iter().enumerate() {
        let mut participant_data = remaining[bucket_index].try_borrow_mut_data()?;
        for delta in &balance_deltas {
            if ParticipantBucket::bucket_id_for_participant_id(delta.participant_id) == *bucket_id {
                ParticipantBucket::apply_token_delta_in_data(
                    participant_data.as_mut(),
                    delta.participant_id,
                    batch_token_id,
                    delta.amount_delta,
                )?;
            }
        }
    }

    emit!(CommitmentBundleSettled {
        payee_id,
        token_id: batch_token_id,
        channel_count: processed_channel_count,
        total,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleCommitmentBundle<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub submitter: Signer<'info>,

    /// CHECK: Instructions sysvar for Ed25519 and CPI verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::balance_deltas::find_balance_delta;
    use proptest::prelude::*;

    #[derive(Clone, Debug)]
    struct BundleModelEntry {
        payer_id: u32,
        amount: u64,
        locked_balance: u64,
        shared_balance: u64,
    }

    proptest! {
        #[test]
        fn bundle_settlement_preserves_total_value_and_payee_gain(
            payee_starting_balance in 0u64..=1_000_000u64,
            raw_entries in prop::collection::vec(
                (1u64..=250_000u64, 0u64..=250_000u64, 0u64..=250_000u64),
                1..=6
            )
        ) {
            let entries: Vec<BundleModelEntry> = raw_entries
                .into_iter()
                .enumerate()
                .map(|(index, (amount, locked_balance, shared_balance))| BundleModelEntry {
                    payer_id: (index + 1) as u32,
                    amount,
                    locked_balance,
                    shared_balance,
                })
                .collect();

            prop_assume!(entries.iter().all(|entry| {
                entry
                    .locked_balance
                    .checked_add(entry.shared_balance)
                    .map(|available| available >= entry.amount)
                    .unwrap_or(false)
            }));

            let mut balance_deltas: Vec<ParticipantBalanceDelta> = Vec::new();
            let before_total = payee_starting_balance as u128
                + entries
                    .iter()
                    .map(|entry| entry.locked_balance as u128 + entry.shared_balance as u128)
                    .sum::<u128>();
            let mut after_locked_total = 0u128;
            let mut expected_payee_gain = 0u64;

            for entry in &entries {
                let locked_consumed = entry.locked_balance.min(entry.amount);
                let shared_debit = entry.amount - locked_consumed;

                after_locked_total += (entry.locked_balance - locked_consumed) as u128;
                expected_payee_gain += entry.amount;

                add_balance_delta(
                    &mut balance_deltas,
                    entry.payer_id,
                    -(shared_debit as i128),
                ).unwrap();
                add_balance_delta(&mut balance_deltas, 55, entry.amount as i128).unwrap();
            }

            let participant_delta_sum: i128 =
                balance_deltas.iter().map(|delta| delta.amount_delta).sum();
            let after_total = after_locked_total
                + (payee_starting_balance as i128 + find_balance_delta(&balance_deltas, 55)) as u128
                + entries
                    .iter()
                    .map(|entry| {
                        (entry.shared_balance as i128
                            + find_balance_delta(&balance_deltas, entry.payer_id))
                            as u128
                    })
                    .sum::<u128>();

            prop_assert_eq!(
                participant_delta_sum as u128,
                before_total
                    - after_locked_total
                    - entries
                        .iter()
                        .map(|entry| entry.shared_balance as u128)
                        .sum::<u128>()
                    - payee_starting_balance as u128
            );
            prop_assert_eq!(find_balance_delta(&balance_deltas, 55), expected_payee_gain as i128);
            prop_assert_eq!(before_total, after_total);
        }
    }
}
