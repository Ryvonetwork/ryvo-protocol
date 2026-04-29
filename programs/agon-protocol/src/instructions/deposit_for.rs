use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::events::Deposited;
use crate::state::{GlobalConfig, ParticipantBucket, TokenRegistry};

/// Max participants per batch (tx size / account limits)
pub const MAX_DEPOSIT_FOR_RECIPIENTS: usize = 16;

pub fn handler(
    ctx: Context<DepositFor>,
    token_id: u16,
    participant_ids: Vec<u32>,
    amounts: Vec<u64>,
) -> Result<()> {
    let remaining = &ctx.remaining_accounts;
    require!(
        !amounts.is_empty() && amounts.len() == participant_ids.len(),
        crate::errors::VaultError::InvalidDepositFor
    );
    require!(
        amounts.len() <= MAX_DEPOSIT_FOR_RECIPIENTS,
        crate::errors::VaultError::InvalidDepositFor
    );

    // Validate token is registered
    let token_entry = ctx
        .accounts
        .token_registry
        .find_token(token_id)
        .ok_or(crate::errors::VaultError::TokenNotFound)?;

    // Validate funder token account matches registered token
    require!(
        ctx.accounts.funder_token_account.mint == token_entry.mint,
        crate::errors::VaultError::InvalidTokenMint
    );

    // Validate vault token account matches registered token
    require!(
        ctx.accounts.vault_token_account.mint == token_entry.mint,
        crate::errors::VaultError::InvalidTokenMint
    );

    let total: u64 = amounts
        .iter()
        .try_fold(0u64, |acc, &a| acc.checked_add(a))
        .ok_or(error!(crate::errors::VaultError::MathOverflow))?;

    require!(total > 0, crate::errors::VaultError::AmountMustBePositive);

    // Transfer total from funder's ATA to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        total,
    )?;

    let mut bucket_bindings: Vec<(u32, usize)> = Vec::with_capacity(remaining.len());
    let mut next_bucket_account_index = 0usize;

    // Credit each participant slot. Participant bucket accounts are supplied once each
    // in deterministic first-appearance order across participant_ids.
    for (i, amount) in amounts.iter().enumerate() {
        require!(*amount > 0, crate::errors::VaultError::AmountMustBePositive);
        let participant_id = participant_ids[i];
        let bucket_id = ParticipantBucket::bucket_id_for_participant_id(participant_id);
        let bucket_account_index = if let Some((_, index)) = bucket_bindings
            .iter()
            .find(|(bound_bucket_id, _)| *bound_bucket_id == bucket_id)
        {
            *index
        } else {
            require!(
                next_bucket_account_index < remaining.len(),
                crate::errors::VaultError::InvalidDepositFor
            );
            let participant_info = &remaining[next_bucket_account_index];
            ParticipantBucket::verify_account_info(participant_info, bucket_id, ctx.program_id)?;
            bucket_bindings.push((bucket_id, next_bucket_account_index));
            next_bucket_account_index += 1;
            next_bucket_account_index - 1
        };

        let participant_info = &remaining[bucket_account_index];
        let mut participant_data = participant_info.try_borrow_mut_data()?;
        ParticipantBucket::apply_token_delta_in_data(
            participant_data.as_mut(),
            participant_id,
            token_id,
            i128::from(*amount),
        )?;

        emit!(Deposited {
            participant_id,
            token_id,
            amount: *amount,
        });
    }

    require!(
        next_bucket_account_index == remaining.len(),
        crate::errors::VaultError::InvalidDepositFor
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct DepositFor<'info> {
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

    #[account(
        mut,
        constraint = funder_token_account.owner == funder.key(),
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault-token-account", token_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub funder: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
