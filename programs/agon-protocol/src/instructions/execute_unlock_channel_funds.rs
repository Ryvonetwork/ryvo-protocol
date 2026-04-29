use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelFundsUnlocked;
use crate::state::{ChannelBucket, GlobalConfig, OwnerIndexBucket, ParticipantBucket};

pub fn handler(
    ctx: Context<ExecuteUnlockChannelFunds>,
    token_id: u16,
    payee_participant_id: u32,
) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    let payer_id = ctx
        .accounts
        .owner_index_bucket
        .participant_id_for_verified_owner(
            &ctx.accounts.owner_index_bucket.key(),
            &owner,
            ctx.program_id,
        )?;
    let (lower_id, higher_id, _) = ChannelBucket::canonicalize(payer_id, payee_participant_id)?;
    ChannelBucket::verify_account_info(
        &ctx.accounts.channel_bucket.to_account_info(),
        token_id,
        ChannelBucket::bucket_id_for_pair(lower_id, higher_id)?,
        ctx.program_id,
    )?;
    let lane = {
        let channel_bucket_info = ctx.accounts.channel_bucket.to_account_info();
        let channel_bucket_data = channel_bucket_info.try_borrow_data()?;
        ChannelBucket::read_resolved_lane_core_from_data(
            channel_bucket_data.as_ref(),
            payer_id,
            payee_participant_id,
        )?
    };
    require!(lane.initialized, VaultError::ChannelNotInitialized);
    require!(
        lane.has_pending_unlock(),
        VaultError::NoChannelUnlockPending
    );

    let unlock_at = lane
        .unlock_requested_at
        .checked_add(
            ctx.accounts
                .global_config
                .effective_channel_unlock_timelock_seconds()?,
        )
        .ok_or(error!(VaultError::MathOverflow))?;
    require!(
        Clock::get()?.unix_timestamp >= unlock_at,
        VaultError::WithdrawalLocked
    );

    let released_amount = lane.pending_unlock_amount.min(lane.locked_balance);
    if released_amount > 0 {
        ParticipantBucket::verify_account_info(
            &ctx.accounts.payer_bucket.to_account_info(),
            ParticipantBucket::bucket_id_for_participant_id(payer_id),
            ctx.program_id,
        )?;
    }

    let (released_amount, remaining_locked) = {
        let channel_bucket_info = ctx.accounts.channel_bucket.to_account_info();
        let mut channel_bucket_data = channel_bucket_info.try_borrow_mut_data()?;
        ChannelBucket::execute_lane_unlock_in_data(
            channel_bucket_data.as_mut(),
            payer_id,
            payee_participant_id,
        )?
    };
    if released_amount > 0 {
        let payer_bucket_info = ctx.accounts.payer_bucket.to_account_info();
        let mut payer_bucket_data = payer_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::apply_token_delta_in_data(
            payer_bucket_data.as_mut(),
            payer_id,
            token_id,
            i128::from(released_amount),
        )?;
    }

    emit!(ChannelFundsUnlocked {
        payer_id,
        payee_id: payee_participant_id,
        token_id,
        released_amount,
        remaining_locked,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteUnlockChannelFunds<'info> {
    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw balance mutation.
    #[account(mut)]
    pub payer_bucket: UncheckedAccount<'info>,

    /// CHECK: Verified with ChannelBucket::verify_account_info before raw lane mutation.
    #[account(mut)]
    pub channel_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Account<'info, OwnerIndexBucket>,

    pub owner: Signer<'info>,
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn unlock_release_amount_is_capped_by_remaining_locked_balance(
            pending_unlock_amount in 1u64..=1_000_000u64,
            locked_balance in 0u64..=1_000_000u64,
        ) {
            let released_amount = pending_unlock_amount.min(locked_balance);
            let remaining_locked = locked_balance - released_amount;

            prop_assert!(released_amount <= pending_unlock_amount);
            prop_assert!(released_amount <= locked_balance);
            prop_assert_eq!(
                remaining_locked as u128 + released_amount as u128,
                locked_balance as u128
            );
        }
    }
}
