use anchor_lang::prelude::*;

use crate::bls::{
    aggregate_pubkey_with_compressed_be, verify_same_message_aggregate_signature,
    BLS_CLEARING_ROUND_MESSAGE_VERSION, BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE, BLS_SCHEME_VERSION_V1,
    BLS_SIGNATURE_COMPRESSED_SIZE,
};
use crate::ed25519;
use crate::errors::VaultError;
use crate::events::ClearingRoundSettled;
use crate::instructions::clearing_round_message::{
    parse_channel_entry, parse_clearing_round_layout_with_version,
};
use crate::state::{
    ChannelBucket, GlobalConfig, ParticipantBucket, ParticipantBucketSlot, TokenRegistry,
};

struct ParticipantRoundState {
    participant_id: u32,
    bucket_account_index: usize,
    token_total_balance: u64,
    net_position: i128,
}

#[derive(Clone, Copy)]
struct ParticipantBucketBinding {
    bucket_id: u32,
    account_index: usize,
}

#[derive(Clone, Copy)]
struct ChannelBucketBinding {
    bucket_id: u64,
    account_index: usize,
}

fn insert_unique_sorted_u32(values: &mut Vec<u32>, value: u32) -> Result<()> {
    match values.binary_search(&value) {
        Ok(_) => Err(error!(VaultError::InvalidClearingRoundMessage)),
        Err(index) => {
            values.insert(index, value);
            Ok(())
        }
    }
}

fn negative_position_abs_to_u64(position: i128) -> Result<u64> {
    let abs_position = position
        .checked_neg()
        .ok_or(error!(VaultError::MathOverflow))?;
    u64::try_from(abs_position).map_err(|_| error!(VaultError::MathOverflow))
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleClearingRound<'info>>,
    message: Vec<u8>,
    aggregate_signature_compressed: [u8; BLS_SIGNATURE_COMPRESSED_SIZE],
) -> Result<()> {
    let program_id = ctx.program_id;

    ed25519::assert_no_cpi(&ctx.accounts.instructions_sysvar, program_id)?;

    let parsed = parse_clearing_round_layout_with_version(
        &message,
        &ctx.accounts.global_config,
        BLS_CLEARING_ROUND_MESSAGE_VERSION,
    )?;

    ctx.accounts
        .token_registry
        .find_token(parsed.token_id)
        .ok_or(VaultError::TokenNotFound)?;

    let remaining = &ctx.remaining_accounts;
    let participant_count = parsed.blocks.len();

    let mut participant_states = Vec::with_capacity(participant_count);
    let mut seen_participant_ids = Vec::with_capacity(participant_count);
    let mut participant_bucket_bindings: Vec<ParticipantBucketBinding> =
        Vec::with_capacity(participant_count);
    let mut channel_bucket_bindings: Vec<ChannelBucketBinding> =
        Vec::with_capacity(parsed.channel_count);
    let mut aggregate_pubkey = None::<[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE]>;
    let mut next_participant_bucket_account_index = 0usize;
    let mut total_gross = 0u64;

    for block in &parsed.blocks {
        insert_unique_sorted_u32(&mut seen_participant_ids, block.participant_id)?;
        let bucket_id = ParticipantBucket::bucket_id_for_participant_id(block.participant_id);
        let participant_bucket_index = if let Ok(binding_index) = participant_bucket_bindings
            .binary_search_by_key(&bucket_id, |binding| binding.bucket_id)
        {
            participant_bucket_bindings[binding_index].account_index
        } else {
            require!(
                next_participant_bucket_account_index < remaining.len(),
                VaultError::InvalidClearingRoundMessage
            );
            let participant_info = &remaining[next_participant_bucket_account_index];
            ParticipantBucket::verify_account_info(participant_info, bucket_id, program_id)?;
            let account_index = next_participant_bucket_account_index;
            let insert_index = participant_bucket_bindings
                .binary_search_by_key(&bucket_id, |binding| binding.bucket_id)
                .unwrap_err();
            participant_bucket_bindings.insert(
                insert_index,
                ParticipantBucketBinding {
                    bucket_id,
                    account_index,
                },
            );
            next_participant_bucket_account_index += 1;
            account_index
        };
        let participant_info = &remaining[participant_bucket_index];
        let participant_data = participant_info.try_borrow_data()?;
        let participant_snapshot = ParticipantBucket::read_clearing_snapshot_from_data(
            participant_data.as_ref(),
            block.participant_id,
            parsed.token_id,
        )?;
        drop(participant_data);
        require!(
            participant_snapshot.owner != Pubkey::default(),
            VaultError::ParticipantNotFound
        );
        participant_states.push(ParticipantRoundState {
            participant_id: block.participant_id,
            bucket_account_index: participant_bucket_index,
            token_total_balance: participant_snapshot.token_total_balance,
            net_position: 0,
        });
        if block.entry_count > 0 {
            require!(
                participant_snapshot.bls_scheme_version
                    != ParticipantBucketSlot::BLS_SCHEME_VERSION_UNREGISTERED,
                VaultError::ParticipantBlsKeyNotFound
            );
            require!(
                participant_snapshot.bls_scheme_version == BLS_SCHEME_VERSION_V1,
                VaultError::AccountBlsKeyMismatch
            );
            aggregate_pubkey = Some(aggregate_pubkey_with_compressed_be(
                aggregate_pubkey,
                &participant_snapshot.bls_pubkey_compressed,
            )?);
        }
    }

    let aggregate_pubkey = aggregate_pubkey.ok_or(error!(VaultError::ParticipantBlsKeyNotFound))?;
    verify_same_message_aggregate_signature(
        &message,
        &aggregate_signature_compressed,
        &aggregate_pubkey,
    )?;

    for (block_index, block) in parsed.blocks.iter().enumerate() {
        let mut entry_offset = block.entries_offset;
        let mut seen_payee_ref_words = [0u64; 4];
        for _ in 0..block.entry_count {
            let entry = parse_channel_entry(&message, &mut entry_offset)?;
            require!(
                (entry.payee_ref as usize) < participant_states.len(),
                VaultError::InvalidClearingRoundMessage
            );
            let payee_ref = entry.payee_ref as usize;
            let payee_ref_word = payee_ref / 64;
            let payee_ref_mask = 1u64 << (payee_ref % 64);
            require!(
                seen_payee_ref_words[payee_ref_word] & payee_ref_mask == 0,
                VaultError::InvalidClearingRoundMessage
            );
            seen_payee_ref_words[payee_ref_word] |= payee_ref_mask;
            let payer_id = participant_states[block_index].participant_id;
            let payee_id = participant_states[payee_ref].participant_id;

            let (lower_participant_id, higher_participant_id, lane_selector) =
                ChannelBucket::canonicalize(payer_id, payee_id)?;
            let channel_bucket_id =
                ChannelBucket::bucket_id_for_pair(lower_participant_id, higher_participant_id)?;
            let channel_bucket_index = if let Ok(binding_index) = channel_bucket_bindings
                .binary_search_by_key(&channel_bucket_id, |binding| binding.bucket_id)
            {
                channel_bucket_bindings[binding_index].account_index
            } else {
                let next_channel_bucket_account_index =
                    next_participant_bucket_account_index + channel_bucket_bindings.len();
                require!(
                    next_channel_bucket_account_index < remaining.len(),
                    VaultError::InvalidClearingRoundMessage
                );
                let channel_info = &remaining[next_channel_bucket_account_index];
                ChannelBucket::verify_account_info(
                    channel_info,
                    parsed.token_id,
                    channel_bucket_id,
                    program_id,
                )?;
                let account_index = next_channel_bucket_account_index;
                let insert_index = channel_bucket_bindings
                    .binary_search_by_key(&channel_bucket_id, |binding| binding.bucket_id)
                    .unwrap_err();
                channel_bucket_bindings.insert(
                    insert_index,
                    ChannelBucketBinding {
                        bucket_id: channel_bucket_id,
                        account_index,
                    },
                );
                account_index
            };

            let channel_info = &remaining[channel_bucket_index];
            let channel_data = channel_info.try_borrow_data()?;
            let lane_snapshot = ChannelBucket::read_lane_settlement_for_selector_from_data(
                channel_data.as_ref(),
                lower_participant_id,
                higher_participant_id,
                lane_selector,
            )?;
            drop(channel_data);
            require!(
                entry.target_cumulative > lane_snapshot.settled_cumulative,
                VaultError::CommitmentAmountMustIncrease
            );

            let delta = entry
                .target_cumulative
                .checked_sub(lane_snapshot.settled_cumulative)
                .ok_or(error!(VaultError::MathOverflow))?;
            total_gross = total_gross
                .checked_add(delta)
                .ok_or(error!(VaultError::MathOverflow))?;
            let locked_consumed = lane_snapshot.locked_balance.min(delta);
            let uncovered_delta = delta
                .checked_sub(locked_consumed)
                .ok_or(error!(VaultError::MathOverflow))?;

            participant_states[block_index].net_position = participant_states[block_index]
                .net_position
                .checked_sub(i128::from(uncovered_delta))
                .ok_or(error!(VaultError::MathOverflow))?;
            participant_states[payee_ref].net_position = participant_states[payee_ref]
                .net_position
                .checked_add(i128::from(delta))
                .ok_or(error!(VaultError::MathOverflow))?;

            let mut channel_data = channel_info.try_borrow_mut_data()?;
            ChannelBucket::apply_lane_settlement_at_offset_in_data(
                channel_data.as_mut(),
                lane_snapshot.lane_offset,
                entry.target_cumulative,
                locked_consumed,
            )?;
        }
    }

    require!(
        next_participant_bucket_account_index + channel_bucket_bindings.len() == remaining.len(),
        VaultError::InvalidClearingRoundMessage
    );

    let mut total_net_adjusted = 0u64;
    for participant in &participant_states {
        if participant.net_position < 0 {
            let abs_position = negative_position_abs_to_u64(participant.net_position)?;
            require!(
                participant.token_total_balance >= abs_position,
                VaultError::InsufficientBalance
            );
        } else {
            require!(
                participant.net_position <= i128::from(u64::MAX),
                VaultError::MathOverflow
            );
            total_net_adjusted = total_net_adjusted
                .checked_add(
                    u64::try_from(participant.net_position)
                        .map_err(|_| error!(VaultError::MathOverflow))?,
                )
                .ok_or(error!(VaultError::MathOverflow))?;
        }
    }

    for participant in &participant_states {
        let position = participant.net_position;
        if position == 0 {
            continue;
        }
        let participant_info = &remaining[participant.bucket_account_index];
        let mut participant_data = participant_info.try_borrow_mut_data()?;
        ParticipantBucket::apply_token_delta_in_data(
            participant_data.as_mut(),
            participant.participant_id,
            parsed.token_id,
            position,
        )?;
    }

    emit!(ClearingRoundSettled {
        token_id: parsed.token_id,
        participant_count: u16::try_from(participant_count)
            .map_err(|_| error!(VaultError::MathOverflow))?,
        channel_count: u16::try_from(parsed.channel_count)
            .map_err(|_| error!(VaultError::MathOverflow))?,
        total_gross,
        total_net_adjusted,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleClearingRound<'info> {
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

    /// CHECK: Instructions sysvar used only for CPI guard verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_net_position_conversion_rejects_values_larger_than_u64() {
        assert_eq!(negative_position_abs_to_u64(-42).unwrap(), 42);
        assert!(negative_position_abs_to_u64(-(i128::from(u64::MAX) + 1)).is_err());
    }
}
