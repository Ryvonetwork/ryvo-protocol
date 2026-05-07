use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::VaultError;
use crate::events::{ConfigAuthorityTransferStarted, ConfigAuthorityTransferred, ConfigUpdated};
use crate::state::GlobalConfig;

pub fn handler(
    ctx: Context<UpdateConfig>,
    new_authority: Option<Pubkey>,
    new_fee_recipient: Option<Pubkey>,
    new_fee_bps: Option<u16>,
    new_registration_fee_lamports: Option<u64>,
) -> Result<()> {
    let config = &mut ctx.accounts.global_config;

    if let Some(a) = new_authority {
        require!(a != Pubkey::default(), VaultError::InvalidAuthority);
        config.pending_authority = a;
        emit!(ConfigAuthorityTransferStarted {
            current_authority: config.authority,
            pending_authority: a,
        });
    }
    if let Some(f) = new_fee_recipient {
        require!(f != Pubkey::default(), VaultError::InvalidFeeRecipient);
        let fee_recipient_account = ctx
            .remaining_accounts
            .first()
            .ok_or(error!(VaultError::InvalidFeeRecipient))?;
        require!(
            fee_recipient_account.key() == f,
            VaultError::InvalidFeeRecipient
        );
        require!(
            *fee_recipient_account.owner == system_program::ID && !fee_recipient_account.executable,
            VaultError::InvalidFeeRecipient
        );
        config.fee_recipient = f;
    }
    if let Some(bps) = new_fee_bps {
        require!(
            (GlobalConfig::MIN_FEE_BPS..=GlobalConfig::MAX_FEE_BPS).contains(&bps),
            VaultError::InvalidFeeBps
        );
        config.fee_bps = bps;
    }
    if let Some(r) = new_registration_fee_lamports {
        require!(
            r == 0
                || (GlobalConfig::MIN_REGISTRATION_FEE_LAMPORTS
                    ..=GlobalConfig::MAX_REGISTRATION_FEE_LAMPORTS)
                    .contains(&r),
            VaultError::InvalidRegistrationFee
        );
        config.registration_fee_lamports = r;
    }

    emit!(ConfigUpdated {
        authority: config.authority,
        fee_recipient: config.fee_recipient,
        fee_bps: config.fee_bps,
        chain_id: config.chain_id,
    });

    Ok(())
}

pub fn accept_config_authority(ctx: Context<AcceptConfigAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.global_config;
    require!(
        config.has_pending_authority(),
        VaultError::NoPendingAuthorityTransfer
    );
    require!(
        config.pending_authority == ctx.accounts.pending_authority.key(),
        VaultError::UnauthorizedPendingAuthority
    );

    let previous_authority = config.authority;
    config.authority = ctx.accounts.pending_authority.key();
    config.pending_authority = Pubkey::default();

    emit!(ConfigAuthorityTransferred {
        previous_authority,
        new_authority: config.authority,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
        has_one = authority,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// Config authority — only this key can update config.
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptConfigAuthority<'info> {
    #[account(
        mut,
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    pub pending_authority: Signer<'info>,
}
