use anchor_lang::prelude::*;

use crate::ed25519;
use crate::errors::VaultError;
use crate::events::IndividualSettled;
use crate::state::{ChannelBucket, GlobalConfig, ParticipantBucket, TokenRegistry};

pub const COMMITMENT_MESSAGE_KIND: u8 = 0x01;
pub const COMMITMENT_MESSAGE_VERSION: u8 = 0x05;
pub const COMMITMENT_FLAG_AUTHORIZED_SETTLER: u8 = 1 << 0;
pub const COMMITMENT_FIXED_HEADER_SIZE: usize = 19;
pub const COMMITMENT_MIN_MSG_SIZE: usize = 24;

pub struct ParsedCommitmentMessage {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub committed_amount: u64,
    pub authorized_settler: Option<Pubkey>,
}

fn read_varint_u64(msg: &[u8], offset: &mut usize) -> Result<u64> {
    let mut shift = 0u32;
    let mut value = 0u64;

    loop {
        require!(*offset < msg.len(), VaultError::InvalidCommitmentMessage);
        let byte = msg[*offset];
        *offset += 1;

        let chunk = (byte & 0x7f) as u64;
        if shift == 63 {
            require!(chunk <= 1, VaultError::InvalidCommitmentMessage);
        }
        value |= chunk
            .checked_shl(shift)
            .ok_or(error!(VaultError::InvalidCommitmentMessage))?;

        if (byte & 0x80) == 0 {
            return Ok(value);
        }

        shift = shift
            .checked_add(7)
            .ok_or(error!(VaultError::InvalidCommitmentMessage))?;
        require!(shift < 64, VaultError::InvalidCommitmentMessage);
    }
}

fn read_varint_u32(msg: &[u8], offset: &mut usize) -> Result<u32> {
    let value = read_varint_u64(msg, offset)?;
    require!(
        value <= u32::MAX as u64,
        VaultError::InvalidCommitmentMessage
    );
    Ok(value as u32)
}

pub fn parse_commitment_message(
    msg: &[u8],
    global_config: &GlobalConfig,
) -> Result<ParsedCommitmentMessage> {
    require!(
        msg.len() >= COMMITMENT_MIN_MSG_SIZE,
        VaultError::InvalidCommitmentMessage
    );
    require!(
        msg[0] == COMMITMENT_MESSAGE_KIND && msg[1] == COMMITMENT_MESSAGE_VERSION,
        VaultError::InvalidCommitmentMessage
    );
    require!(
        msg[2..18] == global_config.message_domain,
        VaultError::InvalidMessageDomain
    );

    let flags = msg[18];
    require!(
        flags & !COMMITMENT_FLAG_AUTHORIZED_SETTLER == 0,
        VaultError::InvalidCommitmentMessage
    );

    let mut offset = COMMITMENT_FIXED_HEADER_SIZE;
    let payer_id = read_varint_u32(msg, &mut offset)?;
    let payee_id = read_varint_u32(msg, &mut offset)?;
    require!(
        msg.len() >= offset + 2,
        VaultError::InvalidCommitmentMessage
    );
    let token_id = u16::from_le_bytes(msg[offset..offset + 2].try_into().unwrap());
    offset += 2;

    let committed_amount = read_varint_u64(msg, &mut offset)?;

    let authorized_settler = if (flags & COMMITMENT_FLAG_AUTHORIZED_SETTLER) != 0 {
        require!(
            msg.len() >= offset + 32,
            VaultError::InvalidCommitmentMessage
        );
        let settler = Pubkey::new_from_array(msg[offset..offset + 32].try_into().unwrap());
        offset += 32;
        Some(settler)
    } else {
        None
    };

    require!(offset == msg.len(), VaultError::InvalidCommitmentMessage);

    Ok(ParsedCommitmentMessage {
        payer_id,
        payee_id,
        token_id,
        committed_amount,
        authorized_settler,
    })
}

pub fn handler(ctx: Context<SettleIndividual>) -> Result<()> {
    let program_id = ctx.program_id;

    ed25519::assert_no_cpi(&ctx.accounts.instructions_sysvar, program_id)?;

    let ix_data = ed25519::verify_ed25519_ix(&ctx.accounts.instructions_sysvar, 0)?;
    require!(
        ix_data.first().copied() == Some(1),
        VaultError::InvalidEd25519Data
    );
    let offsets = ed25519::parse_ed25519_offsets(&ix_data, 0)?;

    let signer_pubkey = ed25519::extract_pubkey(&ix_data, &offsets)?;
    let message = ed25519::extract_message(&ix_data, &offsets)?;
    let parsed = parse_commitment_message(&message, &ctx.accounts.global_config)?;

    ctx.accounts
        .token_registry
        .find_token(parsed.token_id)
        .ok_or(VaultError::TokenNotFound)?;

    let payer_bucket_id = ParticipantBucket::bucket_id_for_participant_id(parsed.payer_id);
    let payee_bucket_id = ParticipantBucket::bucket_id_for_participant_id(parsed.payee_id);
    let mut participant_bucket_ids = vec![payer_bucket_id];
    if payee_bucket_id != payer_bucket_id {
        participant_bucket_ids.push(payee_bucket_id);
    }
    let (lower_id, higher_id, lane_selector) =
        ChannelBucket::canonicalize(parsed.payer_id, parsed.payee_id)?;
    let channel_bucket_id = ChannelBucket::bucket_id_for_pair(lower_id, higher_id)?;
    require!(
        ctx.remaining_accounts.len() == participant_bucket_ids.len() + 1,
        VaultError::InvalidCommitmentMessage
    );

    for (index, bucket_id) in participant_bucket_ids.iter().enumerate() {
        let info = &ctx.remaining_accounts[index];
        ParticipantBucket::verify_account_info(info, *bucket_id, ctx.program_id)?;
    }
    let channel_info = &ctx.remaining_accounts[participant_bucket_ids.len()];
    ChannelBucket::verify_account_info(
        channel_info,
        parsed.token_id,
        channel_bucket_id,
        ctx.program_id,
    )?;
    let channel_data = channel_info.try_borrow_data()?;
    let lane = ChannelBucket::read_lane_commitment_for_selector_from_data(
        channel_data.as_ref(),
        lower_id,
        higher_id,
        lane_selector,
    )?;
    require!(
        signer_pubkey == lane.authorized_signer,
        VaultError::InvalidSignature
    );
    drop(channel_data);

    let payee_bucket_index = participant_bucket_ids
        .iter()
        .position(|bucket_id| *bucket_id == payee_bucket_id)
        .ok_or(error!(VaultError::ParticipantNotFound))?;
    let payee_data = ctx.remaining_accounts[payee_bucket_index].try_borrow_data()?;
    let payee_owner =
        ParticipantBucket::read_slot_owner_from_data(payee_data.as_ref(), parsed.payee_id)?;

    let submitter_ok = ctx.accounts.submitter.key() == payee_owner
        || parsed
            .authorized_settler
            .map(|settler| settler == ctx.accounts.submitter.key())
            .unwrap_or(false);
    require!(submitter_ok, VaultError::UnauthorizedSettler);
    drop(payee_data);

    require!(
        parsed.committed_amount > lane.settled_cumulative,
        VaultError::CommitmentAmountMustIncrease
    );

    let amount = parsed
        .committed_amount
        .checked_sub(lane.settled_cumulative)
        .ok_or(error!(VaultError::MathOverflow))?;
    let total_debit = amount;

    let payer_bucket_index = participant_bucket_ids
        .iter()
        .position(|bucket_id| *bucket_id == payer_bucket_id)
        .ok_or(error!(VaultError::ParticipantNotFound))?;
    let payer_data = ctx.remaining_accounts[payer_bucket_index].try_borrow_data()?;
    let payer_token_balance = ParticipantBucket::read_token_total_balance_from_data(
        payer_data.as_ref(),
        parsed.payer_id,
        parsed.token_id,
    )?;
    drop(payer_data);
    let total_available = lane
        .locked_balance
        .checked_add(payer_token_balance)
        .ok_or(error!(VaultError::MathOverflow))?;
    require!(
        total_available >= total_debit,
        VaultError::InsufficientBalance
    );

    let locked_consumed = lane.locked_balance.min(amount);
    let shared_debit = amount
        .checked_sub(locked_consumed)
        .ok_or(error!(VaultError::MathOverflow))?;
    let from_locked = locked_consumed > 0;

    let mut channel_data = channel_info.try_borrow_mut_data()?;
    ChannelBucket::apply_lane_settlement_at_offset_in_data(
        channel_data.as_mut(),
        lane.lane_offset,
        parsed.committed_amount,
        locked_consumed,
    )?;

    let payer_delta = -(shared_debit as i128);
    let payee_delta = amount as i128;

    for (bucket_index, bucket_id) in participant_bucket_ids.iter().enumerate() {
        let mut participant_data = ctx.remaining_accounts[bucket_index].try_borrow_mut_data()?;
        if *bucket_id == payer_bucket_id {
            ParticipantBucket::apply_token_delta_in_data(
                participant_data.as_mut(),
                parsed.payer_id,
                parsed.token_id,
                payer_delta,
            )?;
        }
        if *bucket_id == payee_bucket_id {
            ParticipantBucket::apply_token_delta_in_data(
                participant_data.as_mut(),
                parsed.payee_id,
                parsed.token_id,
                payee_delta,
            )?;
        }
    }

    emit!(IndividualSettled {
        payer_id: parsed.payer_id,
        payee_id: parsed.payee_id,
        token_id: parsed.token_id,
        amount,
        committed_amount: parsed.committed_amount,
        from_locked,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleIndividual<'info> {
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
    use crate::state::GlobalConfig;
    use proptest::prelude::*;

    fn test_global_config(message_domain: [u8; 16]) -> GlobalConfig {
        GlobalConfig {
            authority: Pubkey::default(),
            fee_recipient: Pubkey::default(),
            fee_bps: 0,
            withdrawal_timelock_seconds: 0,
            channel_unlock_timelock_seconds: 0,
            registration_fee_lamports: 0,
            next_participant_id: 1,
            bump: 0,
            chain_id: GlobalConfig::DEVNET_CHAIN_ID,
            message_domain,
            pending_authority: Pubkey::default(),
            _reserved: [0u8; 6],
        }
    }

    fn encode_varint_u64(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value > 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
        out
    }

    fn encode_varint_u32(value: u32) -> Vec<u8> {
        encode_varint_u64(value as u64)
    }

    fn build_commitment_message_bytes(
        message_domain: [u8; 16],
        payer_id: u32,
        payee_id: u32,
        token_id: u16,
        committed_amount: u64,
        authorized_settler: Option<Pubkey>,
    ) -> Vec<u8> {
        let mut flags = 0u8;
        if authorized_settler.is_some() {
            flags |= COMMITMENT_FLAG_AUTHORIZED_SETTLER;
        }

        let mut out = Vec::new();
        out.push(COMMITMENT_MESSAGE_KIND);
        out.push(COMMITMENT_MESSAGE_VERSION);
        out.extend_from_slice(&message_domain);
        out.push(flags);
        out.extend_from_slice(&encode_varint_u32(payer_id));
        out.extend_from_slice(&encode_varint_u32(payee_id));
        out.extend_from_slice(&token_id.to_le_bytes());
        out.extend_from_slice(&encode_varint_u64(committed_amount));
        if let Some(settler) = authorized_settler {
            out.extend_from_slice(settler.as_ref());
        }
        out
    }

    proptest! {
        #[test]
        fn commitment_message_round_trips_random_v5_payloads(
            payer_id in any::<u32>(),
            payee_id in any::<u32>(),
            token_id in any::<u16>(),
            committed_amount in 0u64..=u32::MAX as u64,
            authorized_settler_bytes in proptest::option::of(any::<[u8; 32]>()),
            message_domain in any::<[u8; 16]>(),
        ) {
            let authorized_settler =
                authorized_settler_bytes.map(Pubkey::new_from_array);
            let config = test_global_config(message_domain);
            let message = build_commitment_message_bytes(
                message_domain,
                payer_id,
                payee_id,
                token_id,
                committed_amount,
                authorized_settler,
            );

            let parsed = parse_commitment_message(&message, &config).unwrap();
            prop_assert_eq!(parsed.payer_id, payer_id);
            prop_assert_eq!(parsed.payee_id, payee_id);
            prop_assert_eq!(parsed.token_id, token_id);
            prop_assert_eq!(parsed.committed_amount, committed_amount);
            prop_assert_eq!(parsed.authorized_settler, authorized_settler);
        }

        #[test]
        fn individual_settlement_preserves_total_value_across_locked_and_shared_balances(
            amount in 1u64..=1_000_000u64,
            locked_balance in 0u64..=1_000_000u64,
            payer_shared_balance in 0u64..=1_000_000u64,
            payee_balance in 0u64..=1_000_000u64,
        ) {
            prop_assume!(locked_balance.checked_add(payer_shared_balance).unwrap() >= amount);

            let locked_consumed = locked_balance.min(amount);
            let shared_debit = amount - locked_consumed;

            let before_total = locked_balance as u128
                + payer_shared_balance as u128
                + payee_balance as u128;
            let after_total = (locked_balance - locked_consumed) as u128
                + (payer_shared_balance - shared_debit) as u128
                + (payee_balance + amount) as u128;

            prop_assert_eq!(before_total, after_total);
        }
    }

    #[test]
    fn commitment_message_rejects_truncated_authorized_settler() {
        let message_domain = [7u8; 16];
        let config = test_global_config(message_domain);
        let mut message = build_commitment_message_bytes(
            message_domain,
            1,
            2,
            1,
            500,
            Some(Pubkey::new_unique()),
        );
        message.pop();

        assert!(parse_commitment_message(&message, &config).is_err());
    }
}
