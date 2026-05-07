use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ChannelFundsLocked;
use crate::state::{ChannelBucket, OwnerIndexBucket, ParticipantBucket, TokenRegistry};

pub fn handler(
    ctx: Context<LockChannelFunds>,
    token_id: u16,
    payee_participant_id: u32,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, VaultError::AmountMustBePositive);
    ctx.accounts
        .token_registry
        .find_token(token_id)
        .ok_or(VaultError::TokenNotFound)?;

    let owner = ctx.accounts.owner.key();
    let payer_id = ctx
        .accounts
        .owner_index_bucket
        .participant_id_for_verified_owner(
            &ctx.accounts.owner_index_bucket.key(),
            &owner,
            ctx.program_id,
        )?;
    ParticipantBucket::verify_account_info(
        &ctx.accounts.payer_bucket.to_account_info(),
        ParticipantBucket::bucket_id_for_participant_id(payer_id),
        ctx.program_id,
    )?;
    let (lower_id, higher_id, _) = ChannelBucket::canonicalize(payer_id, payee_participant_id)?;
    ChannelBucket::verify_account_info(
        &ctx.accounts.channel_bucket.to_account_info(),
        token_id,
        ChannelBucket::bucket_id_for_pair(lower_id, higher_id)?,
        ctx.program_id,
    )?;

    {
        let payer_bucket_info = ctx.accounts.payer_bucket.to_account_info();
        let mut payer_bucket_data = payer_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::debit_token_available_in_data(
            payer_bucket_data.as_mut(),
            payer_id,
            token_id,
            amount,
        )?;
    }
    let total_locked = {
        let channel_bucket_info = ctx.accounts.channel_bucket.to_account_info();
        let mut channel_bucket_data = channel_bucket_info.try_borrow_mut_data()?;
        ChannelBucket::add_lane_locked_balance_in_data(
            channel_bucket_data.as_mut(),
            payer_id,
            payee_participant_id,
            amount,
        )?
    };

    emit!(ChannelFundsLocked {
        payer_id,
        payee_id: payee_participant_id,
        token_id,
        amount,
        total_locked,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct LockChannelFunds<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw balance mutation.
    #[account(mut)]
    pub payer_bucket: UncheckedAccount<'info>,

    /// CHECK: Verified with ChannelBucket::verify_account_info before raw lane mutation.
    #[account(mut)]
    pub channel_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Account<'info, OwnerIndexBucket>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}
