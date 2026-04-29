use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelUnlockRequested;
use crate::state::{ChannelBucket, GlobalConfig, OwnerIndexBucket};

pub fn handler(
    ctx: Context<RequestUnlockChannelFunds>,
    token_id: u16,
    payee_participant_id: u32,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, VaultError::AmountMustBePositive);

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

    let clock = Clock::get()?;
    let unlock_at = clock
        .unix_timestamp
        .checked_add(
            ctx.accounts
                .global_config
                .effective_channel_unlock_timelock_seconds()?,
        )
        .ok_or(error!(VaultError::MathOverflow))?;
    {
        let channel_bucket_info = ctx.accounts.channel_bucket.to_account_info();
        let mut channel_bucket_data = channel_bucket_info.try_borrow_mut_data()?;
        ChannelBucket::request_lane_unlock_in_data(
            channel_bucket_data.as_mut(),
            payer_id,
            payee_participant_id,
            amount,
            clock.unix_timestamp,
        )?;
    }

    emit!(ChannelUnlockRequested {
        payer_id,
        payee_id: payee_participant_id,
        token_id,
        requested_amount: amount,
        unlock_at,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct RequestUnlockChannelFunds<'info> {
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
