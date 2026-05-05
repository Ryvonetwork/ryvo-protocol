//! Mock Save/Kamino-style lending program.
//!
//! Devnet-only. Models a single-asset lending reserve where:
//!   * Depositors transfer underlying (USDC) into a PDA-owned `liquidity_vault`.
//!   * In return they receive an SPL share token (`cUSDC`) whose mint authority is the `Reserve`
//!     PDA. The share supply tracks `total_underlying` so `cUSDC -> USDC` rises monotonically.
//!   * `accrue` is permissionless and bumps `total_underlying` based on `apy_bps` and elapsed time.
//!   * `update_apy_bps` lets an authority change the rate; it always accrues at the *old* rate
//!     first so the new rate is not applied retroactively to the past period.
//!
//! Anti-rug-pull guarantee: the only way to remove underlying from `liquidity_vault` is by burning
//! `cUSDC`. The mint authority for `cUSDC` is `Reserve` (a PDA), and `Reserve.share_mint` is fixed
//! at init. A consumer that holds cUSDC always controls the corresponding underlying — there is no
//! admin path to drain the vault.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

// Only install the custom heap when this crate is the *entrypoint* program. When agon-protocol
// pulls mock-yield in as a CPI dep (`features = ["cpi"]`), `no-entrypoint` is enabled and we must
// skip the global allocator macro to avoid two `#[global_allocator]`s in the linked binary.
#[cfg(all(feature = "custom-heap", not(feature = "no-entrypoint")))]
solana_allocator::custom_heap!();

declare_id!("FX5RrnwvK9iRjZaczFbE6vokLfzVN9UwHw37smqBJjmB");

pub const SECONDS_PER_YEAR: u64 = 31_536_000;
pub const BPS_DENOM: u128 = 10_000;
pub const MAX_APY_BPS: u16 = 5_000;
pub const RESERVE_SEED: &[u8] = b"reserve";
pub const SHARE_MINT_SEED: &[u8] = b"share-mint";
pub const LIQUIDITY_VAULT_SEED: &[u8] = b"liquidity-vault";

#[program]
pub mod mock_yield {
    use super::*;

    pub fn initialize_reserve(ctx: Context<InitializeReserve>, apy_bps: u16) -> Result<()> {
        require!(apy_bps <= MAX_APY_BPS, MockYieldError::ApyTooHigh);

        let clock = Clock::get()?;
        let reserve = &mut ctx.accounts.reserve;
        reserve.underlying_mint = ctx.accounts.underlying_mint.key();
        reserve.share_mint = ctx.accounts.share_mint.key();
        reserve.liquidity_vault = ctx.accounts.liquidity_vault.key();
        reserve.authority = ctx.accounts.authority.key();
        reserve.apy_bps = apy_bps;
        reserve.last_accrual_ts = clock.unix_timestamp;
        reserve.total_underlying = 0;
        reserve.bump = ctx.bumps.reserve;
        reserve._reserved = [0u8; 32];

        emit!(ReserveInitialized {
            reserve: reserve.key(),
            underlying_mint: reserve.underlying_mint,
            share_mint: reserve.share_mint,
            apy_bps,
        });

        Ok(())
    }

    /// Permissionless. Bumps `total_underlying` at the current `apy_bps` for the elapsed window
    /// and stamps the new `last_accrual_ts`. Returns the post-accrual exchange rate via
    /// `set_return_data` as 16 little-endian bytes:
    ///   * bytes 0..8  : `total_underlying`
    ///   * bytes 8..16 : `share_mint.supply`
    /// Callers can compute the cUSDC -> USDC rate as `total_underlying / share_supply` (clamping
    /// supply == 0 to "no shares outstanding -> rate is undefined").
    pub fn accrue(ctx: Context<Accrue>) -> Result<()> {
        let reserve = &mut ctx.accounts.reserve;
        let clock = Clock::get()?;
        accrue_inner(reserve, clock.unix_timestamp)?;

        let supply = ctx.accounts.share_mint.supply;
        let mut return_data = [0u8; 16];
        return_data[0..8].copy_from_slice(&reserve.total_underlying.to_le_bytes());
        return_data[8..16].copy_from_slice(&supply.to_le_bytes());
        set_return_data(&return_data);

        emit!(Accrued {
            reserve: reserve.key(),
            total_underlying: reserve.total_underlying,
            share_supply: supply,
            apy_bps: reserve.apy_bps,
            last_accrual_ts: reserve.last_accrual_ts,
        });

        Ok(())
    }

    /// Authority-only. Settles accrual at the *old* rate before adopting `new_apy_bps`, so the new
    /// rate only applies to time *after* this instruction lands. Without this ordering the new
    /// rate would be retroactively applied to pre-change time.
    pub fn update_apy_bps(ctx: Context<UpdateApyBps>, new_apy_bps: u16) -> Result<()> {
        require!(new_apy_bps <= MAX_APY_BPS, MockYieldError::ApyTooHigh);

        let reserve = &mut ctx.accounts.reserve;
        require!(
            reserve.authority == ctx.accounts.authority.key(),
            MockYieldError::Unauthorized
        );

        let clock = Clock::get()?;
        accrue_inner(reserve, clock.unix_timestamp)?;

        let previous = reserve.apy_bps;
        reserve.apy_bps = new_apy_bps;

        emit!(ApyUpdated {
            reserve: reserve.key(),
            previous_apy_bps: previous,
            new_apy_bps,
        });

        Ok(())
    }

    /// Transfer `amount` underlying from `depositor_underlying` -> `liquidity_vault`, mint the
    /// proportional cUSDC into `depositor_shares`. Accrues first.
    pub fn deposit_reserve_liquidity(
        ctx: Context<DepositReserveLiquidity>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, MockYieldError::AmountMustBePositive);

        let underlying_mint_key = ctx.accounts.underlying_mint.key();
        let reserve_key = ctx.accounts.reserve.key();
        let bump = ctx.accounts.reserve.bump;
        let reserve_info = ctx.accounts.reserve.to_account_info();

        require_keys_eq!(
            ctx.accounts.reserve.underlying_mint,
            underlying_mint_key,
            MockYieldError::UnderlyingMintMismatch
        );

        let clock = Clock::get()?;
        let (total_underlying_after, supply_at_mint_time, shares_to_mint) = {
            let reserve = &mut ctx.accounts.reserve;
            accrue_inner(reserve, clock.unix_timestamp)?;
            let supply = ctx.accounts.share_mint.supply;
            let shares_to_mint: u64 = if supply == 0 || reserve.total_underlying == 0 {
                amount
            } else {
                let n = (amount as u128)
                    .checked_mul(supply as u128)
                    .ok_or(error!(MockYieldError::MathOverflow))?
                    / (reserve.total_underlying as u128);
                u64::try_from(n).map_err(|_| error!(MockYieldError::MathOverflow))?
            };
            require!(shares_to_mint > 0, MockYieldError::ZeroShareConversion);
            reserve.total_underlying = reserve
                .total_underlying
                .checked_add(amount)
                .ok_or(error!(MockYieldError::MathOverflow))?;
            (reserve.total_underlying, supply, shares_to_mint)
        };

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_underlying.to_account_info(),
                    to: ctx.accounts.liquidity_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;

        let signer_seeds: &[&[&[u8]]] = &[&[RESERVE_SEED, underlying_mint_key.as_ref(), &[bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.depositor_shares.to_account_info(),
                    authority: reserve_info,
                },
                signer_seeds,
            ),
            shares_to_mint,
        )?;

        emit!(LiquidityDeposited {
            reserve: reserve_key,
            depositor: ctx.accounts.depositor.key(),
            underlying_amount: amount,
            shares_minted: shares_to_mint,
            total_underlying_after,
            share_supply_after: supply_at_mint_time
                .checked_add(shares_to_mint)
                .ok_or(error!(MockYieldError::MathOverflow))?,
        });

        Ok(())
    }

    /// Burn `shares` cUSDC from `redeemer_shares`, transfer the proportional underlying to
    /// `redeemer_underlying`. Accrues first.
    pub fn redeem_reserve_collateral(
        ctx: Context<RedeemReserveCollateral>,
        shares: u64,
    ) -> Result<()> {
        require!(shares > 0, MockYieldError::AmountMustBePositive);

        let underlying_mint_key = ctx.accounts.underlying_mint.key();
        let reserve_key = ctx.accounts.reserve.key();
        let bump = ctx.accounts.reserve.bump;
        let reserve_info = ctx.accounts.reserve.to_account_info();

        require_keys_eq!(
            ctx.accounts.reserve.underlying_mint,
            underlying_mint_key,
            MockYieldError::UnderlyingMintMismatch
        );

        let clock = Clock::get()?;
        let (underlying_to_pay, total_underlying_after, supply_at_burn_time) = {
            let reserve = &mut ctx.accounts.reserve;
            accrue_inner(reserve, clock.unix_timestamp)?;

            let supply = ctx.accounts.share_mint.supply;
            require!(supply > 0, MockYieldError::ZeroShareConversion);
            require!(shares <= supply, MockYieldError::InsufficientShareSupply);

            let underlying_to_pay: u64 = {
                let n = (shares as u128)
                    .checked_mul(reserve.total_underlying as u128)
                    .ok_or(error!(MockYieldError::MathOverflow))?
                    / (supply as u128);
                u64::try_from(n).map_err(|_| error!(MockYieldError::MathOverflow))?
            };
            reserve.total_underlying = reserve
                .total_underlying
                .checked_sub(underlying_to_pay)
                .ok_or(error!(MockYieldError::MathOverflow))?;
            (underlying_to_pay, reserve.total_underlying, supply)
        };

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.redeemer_shares.to_account_info(),
                    authority: ctx.accounts.share_authority.to_account_info(),
                },
            ),
            shares,
        )?;

        if underlying_to_pay > 0 {
            let signer_seeds: &[&[&[u8]]] =
                &[&[RESERVE_SEED, underlying_mint_key.as_ref(), &[bump]]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.liquidity_vault.to_account_info(),
                        to: ctx.accounts.redeemer_underlying.to_account_info(),
                        authority: reserve_info,
                    },
                    signer_seeds,
                ),
                underlying_to_pay,
            )?;
        }

        emit!(LiquidityRedeemed {
            reserve: reserve_key,
            redeemer: ctx.accounts.share_authority.key(),
            shares_burned: shares,
            underlying_paid: underlying_to_pay,
            total_underlying_after,
            share_supply_after: supply_at_burn_time
                .checked_sub(shares)
                .ok_or(error!(MockYieldError::MathOverflow))?,
        });

        Ok(())
    }
}

/// Continuous-style linear accrual using `(apy_bps * dt / SECONDS_PER_YEAR / 10_000) * total`.
/// Returns the new `total_underlying`. Idempotent if `dt == 0` or `total_underlying == 0`.
fn accrue_inner(reserve: &mut Reserve, now_ts: i64) -> Result<()> {
    let last = reserve.last_accrual_ts;
    if now_ts <= last {
        return Ok(());
    }
    let dt = (now_ts - last) as u128;
    if reserve.total_underlying == 0 || reserve.apy_bps == 0 {
        reserve.last_accrual_ts = now_ts;
        return Ok(());
    }

    let total_underlying = reserve.total_underlying as u128;
    let apy = reserve.apy_bps as u128;
    let interest = total_underlying
        .checked_mul(apy)
        .ok_or(error!(MockYieldError::MathOverflow))?
        .checked_mul(dt)
        .ok_or(error!(MockYieldError::MathOverflow))?
        / (BPS_DENOM
            .checked_mul(SECONDS_PER_YEAR as u128)
            .ok_or(error!(MockYieldError::MathOverflow))?);
    let new_total = total_underlying
        .checked_add(interest)
        .ok_or(error!(MockYieldError::MathOverflow))?;
    reserve.total_underlying =
        u64::try_from(new_total).map_err(|_| error!(MockYieldError::MathOverflow))?;
    reserve.last_accrual_ts = now_ts;
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeReserve<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Reserve::SPACE,
        seeds = [RESERVE_SEED, underlying_mint.key().as_ref()],
        bump,
    )]
    pub reserve: Account<'info, Reserve>,

    pub underlying_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [SHARE_MINT_SEED, underlying_mint.key().as_ref()],
        bump,
        mint::decimals = underlying_mint.decimals,
        mint::authority = reserve,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [LIQUIDITY_VAULT_SEED, underlying_mint.key().as_ref()],
        bump,
        token::mint = underlying_mint,
        token::authority = reserve,
    )]
    pub liquidity_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Accrue<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.underlying_mint.as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(address = reserve.share_mint @ MockYieldError::ShareMintMismatch)]
    pub share_mint: Account<'info, Mint>,
}

#[derive(Accounts)]
pub struct UpdateApyBps<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.underlying_mint.as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositReserveLiquidity<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, underlying_mint.key().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    pub underlying_mint: Account<'info, Mint>,

    #[account(
        mut,
        address = reserve.share_mint @ MockYieldError::ShareMintMismatch,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        address = reserve.liquidity_vault @ MockYieldError::LiquidityVaultMismatch,
    )]
    pub liquidity_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_underlying.mint == underlying_mint.key() @ MockYieldError::UnderlyingMintMismatch,
        constraint = depositor_underlying.owner == depositor.key() @ MockYieldError::Unauthorized,
    )]
    pub depositor_underlying: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_shares.mint == share_mint.key() @ MockYieldError::ShareMintMismatch,
    )]
    pub depositor_shares: Account<'info, TokenAccount>,

    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RedeemReserveCollateral<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, underlying_mint.key().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    pub underlying_mint: Account<'info, Mint>,

    #[account(
        mut,
        address = reserve.share_mint @ MockYieldError::ShareMintMismatch,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        address = reserve.liquidity_vault @ MockYieldError::LiquidityVaultMismatch,
    )]
    pub liquidity_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = redeemer_shares.mint == share_mint.key() @ MockYieldError::ShareMintMismatch,
    )]
    pub redeemer_shares: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = redeemer_underlying.mint == underlying_mint.key() @ MockYieldError::UnderlyingMintMismatch,
    )]
    pub redeemer_underlying: Account<'info, TokenAccount>,

    /// Authority that can burn `redeemer_shares`. For agon-protocol calls this is the
    /// `GlobalConfig` PDA (the `share_vault` owner). For end-user direct redemptions it would be
    /// the wallet holding the cUSDC.
    pub share_authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Reserve {
    pub underlying_mint: Pubkey, // 32
    pub share_mint: Pubkey,      // 32
    pub liquidity_vault: Pubkey, // 32
    pub authority: Pubkey,       // 32
    pub apy_bps: u16,            // 2
    pub last_accrual_ts: i64,    // 8
    pub total_underlying: u64,   // 8
    pub bump: u8,                // 1
    pub _reserved: [u8; 32],     // 32  (padding for future fields)
}

impl Reserve {
    pub const SPACE: usize = 32 + 32 + 32 + 32 + 2 + 8 + 8 + 1 + 32;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum MockYieldError {
    #[msg("APY (in bps) exceeds the protocol cap")]
    ApyTooHigh,
    #[msg("Amount must be greater than zero")]
    AmountMustBePositive,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Conversion produced zero shares; deposit underflowed")]
    ZeroShareConversion,
    #[msg("Insufficient share supply for redeem")]
    InsufficientShareSupply,
    #[msg("Provided share mint does not match Reserve.share_mint")]
    ShareMintMismatch,
    #[msg("Provided liquidity vault does not match Reserve.liquidity_vault")]
    LiquidityVaultMismatch,
    #[msg("Provided underlying mint does not match Reserve.underlying_mint")]
    UnderlyingMintMismatch,
    #[msg("Caller is not the reserve authority")]
    Unauthorized,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct ReserveInitialized {
    pub reserve: Pubkey,
    pub underlying_mint: Pubkey,
    pub share_mint: Pubkey,
    pub apy_bps: u16,
}

#[event]
pub struct Accrued {
    pub reserve: Pubkey,
    pub total_underlying: u64,
    pub share_supply: u64,
    pub apy_bps: u16,
    pub last_accrual_ts: i64,
}

#[event]
pub struct ApyUpdated {
    pub reserve: Pubkey,
    pub previous_apy_bps: u16,
    pub new_apy_bps: u16,
}

#[event]
pub struct LiquidityDeposited {
    pub reserve: Pubkey,
    pub depositor: Pubkey,
    pub underlying_amount: u64,
    pub shares_minted: u64,
    pub total_underlying_after: u64,
    pub share_supply_after: u64,
}

#[event]
pub struct LiquidityRedeemed {
    pub reserve: Pubkey,
    pub redeemer: Pubkey,
    pub shares_burned: u64,
    pub underlying_paid: u64,
    pub total_underlying_after: u64,
    pub share_supply_after: u64,
}
