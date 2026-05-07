use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::WithdrawalRequested;
use crate::state::{GlobalConfig, OwnerIndexBucket, ParticipantBucket, TokenRegistry};

pub fn handler(
    ctx: Context<RequestWithdrawal>,
    token_id: u16,
    amount: u64,
    destination: Pubkey,
) -> Result<()> {
    let config = &ctx.accounts.global_config;
    let owner = ctx.accounts.owner.key();
    let participant_id = ctx
        .accounts
        .owner_index_bucket
        .participant_id_for_verified_owner(
            &ctx.accounts.owner_index_bucket.key(),
            &owner,
            ctx.program_id,
        )?;
    ParticipantBucket::verify_account_info(
        &ctx.accounts.participant_bucket.to_account_info(),
        ParticipantBucket::bucket_id_for_participant_id(participant_id),
        ctx.program_id,
    )?;

    // Validate token is registered
    let token_entry = ctx
        .accounts
        .token_registry
        .find_token(token_id)
        .ok_or(VaultError::TokenNotFound)?;

    // Plain withdrawal request cannot target a yield-bearing token id.
    require!(
        !token_entry.is_yield_bearing(),
        VaultError::TokenIsYieldBearing
    );

    require!(amount > 0, VaultError::AmountMustBePositive);

    // Destination must not be zero. Can be participant's own or any 3rd party token account.
    require!(
        destination != Pubkey::default(),
        VaultError::InvalidWithdrawalDestination
    );
    require!(
        destination == ctx.accounts.withdrawal_destination.key(),
        VaultError::InvalidWithdrawalDestination
    );

    // Check that destination account has the correct mint
    require!(
        ctx.accounts.withdrawal_destination.mint == token_entry.mint,
        VaultError::InvalidTokenMint
    );

    let clock = Clock::get()?;
    let unlock_at = clock
        .unix_timestamp
        .checked_add(config.withdrawal_timelock_seconds)
        .ok_or(error!(VaultError::MathOverflow))?;
    {
        let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
        let mut participant_bucket_data = participant_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::initiate_token_withdrawal_in_data(
            participant_bucket_data.as_mut(),
            participant_id,
            token_id,
            amount,
            destination,
            unlock_at,
        )?;
    }

    emit!(WithdrawalRequested {
        participant_id,
        token_id,
        amount,
        destination,
        unlock_at,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
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

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw withdrawal mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Account<'info, OwnerIndexBucket>,

    /// The withdrawal destination token account
    #[account(
        constraint = withdrawal_destination.owner != Pubkey::default(),
    )]
    pub withdrawal_destination: Account<'info, anchor_spl::token::TokenAccount>,

    pub owner: Signer<'info>,
}
