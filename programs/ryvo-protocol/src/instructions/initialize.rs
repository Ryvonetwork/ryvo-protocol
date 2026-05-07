use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::{ConfigAuthorityTransferStarted, ConfigUpdated};
use crate::state::GlobalConfig;

fn resolve_bootstrap_authorities(
    upgrade_authority: Pubkey,
    initial_authority: Option<Pubkey>,
) -> Result<(Pubkey, Pubkey)> {
    require!(
        upgrade_authority != Pubkey::default(),
        VaultError::InvalidAuthority
    );
    let nominated_authority = initial_authority.unwrap_or(upgrade_authority);
    require!(
        nominated_authority != Pubkey::default(),
        VaultError::InvalidAuthority
    );

    let pending_authority = if nominated_authority == upgrade_authority {
        Pubkey::default()
    } else {
        nominated_authority
    };

    Ok((upgrade_authority, pending_authority))
}

pub fn handler(
    ctx: Context<Initialize>,
    chain_id: u16,
    fee_bps: u16,
    registration_fee_lamports: u64,
    initial_authority: Option<Pubkey>,
) -> Result<()> {
    require!(
        (GlobalConfig::MIN_FEE_BPS..=GlobalConfig::MAX_FEE_BPS).contains(&fee_bps),
        VaultError::InvalidFeeBps
    );
    require!(
        ctx.accounts.fee_recipient.key() != Pubkey::default(),
        VaultError::InvalidFeeRecipient
    );
    require!(
        registration_fee_lamports == 0
            || (GlobalConfig::MIN_REGISTRATION_FEE_LAMPORTS
                ..=GlobalConfig::MAX_REGISTRATION_FEE_LAMPORTS)
                .contains(&registration_fee_lamports),
        VaultError::InvalidRegistrationFee
    );
    let (authority, pending_authority) =
        resolve_bootstrap_authorities(ctx.accounts.upgrade_authority.key(), initial_authority)?;
    let withdrawal_timelock_seconds = GlobalConfig::withdrawal_timelock_for_chain_id(chain_id)?;
    let channel_unlock_timelock_seconds =
        GlobalConfig::channel_unlock_timelock_for_chain_id(chain_id)?;
    let message_domain = GlobalConfig::derive_message_domain(ctx.program_id, chain_id);

    let config = &mut ctx.accounts.global_config;
    config.authority = authority;
    config.fee_recipient = ctx.accounts.fee_recipient.key();
    config.fee_bps = fee_bps;
    config.withdrawal_timelock_seconds = withdrawal_timelock_seconds;
    config.channel_unlock_timelock_seconds = channel_unlock_timelock_seconds;
    config.registration_fee_lamports = registration_fee_lamports;
    config.next_participant_id = 0;
    config.bump = ctx.bumps.global_config;
    config.chain_id = chain_id;
    config.message_domain = message_domain;
    config.pending_authority = pending_authority;
    config._reserved = [0u8; 6];

    if pending_authority != Pubkey::default() {
        emit!(ConfigAuthorityTransferStarted {
            current_authority: authority,
            pending_authority,
        });
    }

    emit!(ConfigUpdated {
        authority: config.authority,
        fee_recipient: config.fee_recipient,
        fee_bps: config.fee_bps,
        chain_id: config.chain_id,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = upgrade_authority,
        space = GlobalConfig::SPACE,
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// Wallet that receives registration-fee lamports and owns fee token accounts.
    pub fee_recipient: SystemAccount<'info>,

    /// Program's upgrade authority performs the one-time bootstrap.
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,

    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::RyvoProtocol>,

    #[account(
        constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key())
            @ VaultError::UnauthorizedInitializer
    )]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

#[cfg(test)]
mod tests {
    use super::resolve_bootstrap_authorities;
    use anchor_lang::prelude::Pubkey;

    #[test]
    fn bootstrap_keeps_upgrade_authority_when_no_nominee_is_provided() {
        let upgrade_authority = Pubkey::new_unique();
        let (authority, pending_authority) =
            resolve_bootstrap_authorities(upgrade_authority, None).unwrap();

        assert_eq!(authority, upgrade_authority);
        assert_eq!(pending_authority, Pubkey::default());
    }

    #[test]
    fn bootstrap_nominates_distinct_authority_as_pending() {
        let upgrade_authority = Pubkey::new_unique();
        let nominated_authority = Pubkey::new_unique();
        let (authority, pending_authority) =
            resolve_bootstrap_authorities(upgrade_authority, Some(nominated_authority)).unwrap();

        assert_eq!(authority, upgrade_authority);
        assert_eq!(pending_authority, nominated_authority);
    }

    #[test]
    fn bootstrap_rejects_zero_nominated_authority() {
        let upgrade_authority = Pubkey::new_unique();
        assert!(resolve_bootstrap_authorities(upgrade_authority, Some(Pubkey::default())).is_err());
    }
}
