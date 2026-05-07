use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::VaultError;
use crate::events::Deposited;
use crate::state::{GlobalConfig, OwnerIndexBucket, ParticipantBucket, TokenRegistry};

pub fn handler(ctx: Context<Deposit>, token_id: u16, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::AmountMustBePositive);

    // Validate token is registered and get mint address
    let registry = &ctx.accounts.token_registry;
    let token_entry = registry
        .find_token(token_id)
        .ok_or(crate::errors::VaultError::TokenNotFound)?;

    // Plain deposit cannot operate on a yield-bearing token id; clients must use
    // `deposit_yield_bearing` instead.
    require!(
        !token_entry.is_yield_bearing(),
        VaultError::TokenIsYieldBearing
    );

    // Verify the provided accounts match the registered token
    require!(
        ctx.accounts.owner_token_account.mint == token_entry.mint,
        VaultError::InvalidTokenMint
    );
    require!(
        ctx.accounts.vault_token_account.mint == token_entry.mint,
        VaultError::InvalidTokenMint
    );

    // CPI: transfer tokens from owner's ATA to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    // Credit participant with token-specific balance
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
    {
        let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
        let mut participant_bucket_data = participant_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::apply_token_delta_in_data(
            participant_bucket_data.as_mut(),
            participant_id,
            token_id,
            i128::from(amount),
        )?;
    }

    emit!(Deposited {
        participant_id,
        token_id,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct Deposit<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Box<Account<'info, TokenRegistry>>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw balance mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Box<Account<'info, OwnerIndexBucket>>,

    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
    )]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault-token-account", token_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
