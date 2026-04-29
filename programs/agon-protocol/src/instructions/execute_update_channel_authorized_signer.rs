use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelAuthorizedSignerUpdated;
use crate::state::{ChannelBucket, GlobalConfig, OwnerIndexBucket};

pub fn handler(
    ctx: Context<ExecuteUpdateChannelAuthorizedSigner>,
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
        lane.has_pending_authorized_signer_update(),
        VaultError::NoAuthorizedSignerUpdatePending
    );

    let activate_at = lane
        .authorized_signer_update_requested_at
        .checked_add(
            ctx.accounts
                .global_config
                .effective_channel_unlock_timelock_seconds()?,
        )
        .ok_or(error!(VaultError::MathOverflow))?;
    require!(
        Clock::get()?.unix_timestamp >= activate_at,
        VaultError::WithdrawalLocked
    );

    let (previous_authorized_signer, new_authorized_signer) = {
        let channel_bucket_info = ctx.accounts.channel_bucket.to_account_info();
        let mut channel_bucket_data = channel_bucket_info.try_borrow_mut_data()?;
        ChannelBucket::execute_authorized_signer_update_in_data(
            channel_bucket_data.as_mut(),
            payer_id,
            payee_participant_id,
        )?
    };

    emit!(ChannelAuthorizedSignerUpdated {
        payer_id,
        payee_id: payee_participant_id,
        token_id,
        previous_authorized_signer,
        new_authorized_signer,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteUpdateChannelAuthorizedSigner<'info> {
    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// CHECK: Verified with ChannelBucket::verify_account_info before raw lane mutation.
    #[account(mut)]
    pub channel_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Account<'info, OwnerIndexBucket>,

    pub owner: Signer<'info>,
}
