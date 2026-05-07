use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::VaultError;
use crate::events::{RegistryAuthorityTransferStarted, RegistryAuthorityTransferred};
use crate::state::{GlobalConfig, TokenEntry, TokenRegistry};

/// Initialize the token registry (called once after program deployment)
pub fn initialize_token_registry(ctx: Context<InitializeTokenRegistry>) -> Result<()> {
    let registry = &mut ctx.accounts.token_registry;

    // Set authority to the initializer.
    registry.authority = ctx.accounts.authority.key();
    registry.tokens = Vec::new();
    registry.bump = ctx.bumps.token_registry;
    registry.pending_authority = Pubkey::default();

    Ok(())
}

/// Register a new token in the registry (authority only)
pub fn register_token(
    ctx: Context<RegisterToken>,
    token_id: u16,
    symbol_bytes: [u8; 8],
) -> Result<()> {
    let registry_data_len = ctx.accounts.token_registry.to_account_info().data_len();
    let registry = &mut ctx.accounts.token_registry;
    let mint = &ctx.accounts.mint;
    let authority = &ctx.accounts.authority;

    // Verify authority
    require!(
        authority.key() == registry.authority,
        VaultError::UnauthorizedTokenRegistration
    );

    // Validate token_id is not zero and not already used
    require!(token_id > 0, VaultError::InvalidTokenId);
    require!(
        !registry.is_token_registered(token_id),
        VaultError::TokenIdAlreadyInUse
    );

    // Validate mint is not already registered
    require!(
        !registry.is_mint_registered(&mint.key()),
        VaultError::TokenAlreadyRegistered
    );
    require!(
        mint.decimals <= TokenRegistry::MAX_TOKEN_DECIMALS,
        VaultError::InvalidTokenDecimals
    );

    // Validate symbol is ASCII and not all NUL padding.
    require!(
        symbol_bytes.iter().all(|byte| byte.is_ascii()),
        VaultError::InvalidTokenSymbol
    );
    require!(
        symbol_bytes.iter().any(|byte| *byte != 0),
        VaultError::InvalidTokenSymbol
    );

    // Add token to registry. Plain (kind = 0) — yield-bearing wrappers go through
    // `register_yield_bearing_token` instead.
    let entry = TokenEntry {
        id: token_id,
        mint: mint.key(),
        decimals: mint.decimals,
        symbol: symbol_bytes,
        registered_at: Clock::get()?.unix_timestamp,
        kind: crate::state::TOKEN_KIND_PLAIN,
        _reserved: [0u8; 4],
    };

    let required_space = TokenRegistry::required_space(registry.tokens.len() + 1)?;
    require!(
        registry_data_len >= required_space,
        VaultError::TokenRegistryFull
    );

    registry.tokens.push(entry);

    Ok(())
}

/// Update token registry authority
pub fn update_registry_authority(
    ctx: Context<UpdateRegistryAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let registry = &mut ctx.accounts.token_registry;
    let current_authority = &ctx.accounts.current_authority;

    // Verify current authority
    require!(
        current_authority.key() == registry.authority,
        VaultError::UnauthorizedTokenRegistration
    );

    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAuthority
    );
    registry.pending_authority = new_authority;

    emit!(RegistryAuthorityTransferStarted {
        current_authority: current_authority.key(),
        pending_authority: new_authority,
    });

    Ok(())
}

/// Pending token registry authority accepts the handoff.
pub fn accept_registry_authority(ctx: Context<AcceptRegistryAuthority>) -> Result<()> {
    let registry = &mut ctx.accounts.token_registry;
    require!(
        registry.has_pending_authority(),
        VaultError::NoPendingAuthorityTransfer
    );
    require!(
        registry.pending_authority == ctx.accounts.pending_authority.key(),
        VaultError::UnauthorizedPendingAuthority
    );

    let previous_authority = registry.authority;
    registry.authority = ctx.accounts.pending_authority.key();
    registry.pending_authority = Pubkey::default();

    emit!(RegistryAuthorityTransferred {
        previous_authority,
        new_authority: registry.authority,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeTokenRegistry<'info> {
    #[account(
        init,
        payer = authority,
        space = TokenRegistry::SPACE,
        seeds = [TokenRegistry::SEED_PREFIX],
        bump
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
        constraint = global_config.authority == authority.key() @ VaultError::UnauthorizedTokenRegistration,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct RegisterToken<'info> {
    #[account(
        mut,
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// Vault token account for this token (created when token is registered)
    #[account(
        init,
        payer = authority,
        seeds = [b"vault-token-account", token_id.to_le_bytes().as_ref()],
        bump,
        token::mint = mint,
        token::authority = global_config, // Program owns the vault
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Mint to register
    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// Registry authority
    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdateRegistryAuthority<'info> {
    #[account(
        mut,
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// Current authority
    pub current_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptRegistryAuthority<'info> {
    #[account(
        mut,
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    pub pending_authority: Signer<'info>,
}
