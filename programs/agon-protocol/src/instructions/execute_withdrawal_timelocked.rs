use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::VaultError;
use crate::events::Withdrawn;
use crate::state::{GlobalConfig, ParticipantBucket, TokenRegistry};

pub fn handler(
    ctx: Context<ExecuteWithdrawalTimelocked>,
    token_id: u16,
    participant_id: u32,
) -> Result<()> {
    let config = &ctx.accounts.global_config;
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
    require!(
        token_entry.decimals <= TokenRegistry::MAX_TOKEN_DECIMALS,
        VaultError::InvalidTokenDecimals
    );
    // Plain timelocked execution cannot target a yield-bearing token id; clients must use
    // `execute_withdrawal_yield_bearing` instead.
    require!(
        !token_entry.is_yield_bearing(),
        VaultError::TokenIsYieldBearing
    );

    let token_balance = {
        let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
        let participant_bucket_data = participant_bucket_info.try_borrow_data()?;
        ParticipantBucket::read_token_withdrawal_from_data(
            participant_bucket_data.as_ref(),
            participant_id,
            token_id,
        )?
    };

    require!(
        token_balance.withdrawal_unlock_at != 0,
        VaultError::NoWithdrawalPending
    );
    require!(
        ctx.accounts.withdrawal_destination.key() == token_balance.withdrawal_destination,
        VaultError::InvalidWithdrawalDestination
    );
    require!(
        ctx.accounts.withdrawal_destination.mint == token_entry.mint,
        VaultError::InvalidTokenMint
    );

    // Timelock must have expired
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= token_balance.withdrawal_unlock_at,
        VaultError::WithdrawalLocked
    );

    let withdrawing = token_balance.withdrawing_balance;

    // If commitments drained the full amount during timelock, just clear the pending state
    if withdrawing == 0 {
        let destination = token_balance.withdrawal_destination;
        {
            let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
            let mut participant_bucket_data = participant_bucket_info.try_borrow_mut_data()?;
            ParticipantBucket::clear_token_withdrawal_in_data(
                participant_bucket_data.as_mut(),
                participant_id,
                token_id,
            )?;
        }
        emit!(Withdrawn {
            participant_id,
            token_id,
            net_amount: 0,
            fee_amount: 0,
            destination,
        });
        return Ok(());
    }

    // Scale the protocol's 6-decimal fee floor into this token's native units.
    let scaled_min_fee: u64 = if token_entry.decimals >= 6 {
        let scale = 10u64
            .checked_pow((token_entry.decimals - 6) as u32)
            .ok_or(error!(VaultError::MathOverflow))?;
        GlobalConfig::MIN_WITHDRAWAL_FEE_6DP
            .checked_mul(scale)
            .ok_or(error!(VaultError::MathOverflow))?
    } else {
        // For tokens with fewer than 6 decimals, floor at 1 native unit
        let divisor = 10u64
            .checked_pow((6 - token_entry.decimals) as u32)
            .ok_or(error!(VaultError::MathOverflow))?;
        GlobalConfig::MIN_WITHDRAWAL_FEE_6DP
            .checked_div(divisor)
            .unwrap_or(1)
            .max(1)
    };

    // Fee: max(scaled_min, percentage) — capped at withdrawing to avoid underflow on small amounts
    let fee_percentage = (withdrawing as u128)
        .checked_mul(config.fee_bps as u128)
        .ok_or(error!(VaultError::MathOverflow))?
        / 10_000u128;
    let fee_percentage = fee_percentage as u64;
    let fee_amount = fee_percentage.max(scaled_min_fee).min(withdrawing);
    let net_amount = withdrawing - fee_amount;

    // PDA signer seeds for vault token account authority (GlobalConfig PDA)
    let (_, config_bump) =
        Pubkey::find_program_address(&[GlobalConfig::SEED_PREFIX], ctx.program_id);
    let signer_seeds: &[&[&[u8]]] = &[&[GlobalConfig::SEED_PREFIX, &[config_bump]]];

    // Transfer net_amount to withdrawal destination
    if net_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.withdrawal_destination.to_account_info(),
                    authority: ctx.accounts.global_config.to_account_info(),
                },
                signer_seeds,
            ),
            net_amount,
        )?;
    }

    // Transfer fee to fee_recipient
    if fee_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.fee_recipient_token_account.to_account_info(),
                    authority: ctx.accounts.global_config.to_account_info(),
                },
                signer_seeds,
            ),
            fee_amount,
        )?;
    }

    let destination = token_balance.withdrawal_destination;

    {
        let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
        let mut participant_bucket_data = participant_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::clear_token_withdrawal_in_data(
            participant_bucket_data.as_mut(),
            participant_id,
            token_id,
        )?;
    }

    emit!(Withdrawn {
        participant_id,
        token_id,
        net_amount,
        fee_amount,
        destination,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16, participant_id: u32)]
pub struct ExecuteWithdrawalTimelocked<'info> {
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

    #[account(
        mut,
        seeds = [b"vault-token-account", token_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Destination token account (any valid token ATA — participant or 3rd party).
    #[account(
        mut,
        constraint = withdrawal_destination.mint == vault_token_account.mint @ VaultError::InvalidTokenMint,
    )]
    pub withdrawal_destination: Account<'info, TokenAccount>,

    /// Fee recipient's token account for the token being withdrawn.
    #[account(
        mut,
        constraint = fee_recipient_token_account.owner == global_config.fee_recipient @ VaultError::InvalidFeeRecipient,
        constraint = fee_recipient_token_account.mint == vault_token_account.mint @ VaultError::InvalidTokenMint,
    )]
    pub fee_recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
