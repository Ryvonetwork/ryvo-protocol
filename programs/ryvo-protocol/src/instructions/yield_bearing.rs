//! Yield-bearing instruction handlers (ryUSDC over mock-yield).
//!
//! Six instructions live in this module:
//!   * `register_yield_bearing_token`     — admin: create TokenEntry (kind=YieldBearing) + YieldStrategy + share_vault.
//!   * `accrue_yield`                     — permissionless: pull cUSDC rate, attribute new yield, update index + protocol_owed.
//!   * `deposit_yield_bearing`            — user: pull USDC, CPI deposit_reserve_liquidity (mock-yield), credit ryUSDC shares.
//!   * `request_withdrawal_yield_bearing` — user: move shares from available -> withdrawing.
//!   * `execute_withdrawal_yield_bearing` — user: CPI redeem_reserve_collateral (twice — net + fee), pay user + fee_recipient.
//!   * `claim_protocol_yield_fee`         — fee_recipient: CPI redeem_reserve_collateral up to protocol_owed_underlying.
//!
//! Solvency invariant is asserted at the end of every handler. See
//! `state::yield_strategy::require_solvent` for the property.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::get_return_data;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::VaultError;
use crate::events::{
    OptedInYield, OptedOutYield, ProtocolYieldClaimed, YieldAccrued, YieldBearingTokenRegistered,
    YieldDeposited, YieldWithdrawn,
};
use crate::state::{
    apply_yield_delta, require_solvent, GlobalConfig, OwnerIndexBucket, ParticipantBucket,
    TokenEntry, TokenRegistry, YieldStrategy, DEFAULT_PROTOCOL_YIELD_SHARE_BPS,
    MAX_PROTOCOL_YIELD_SHARE_BPS, Q64_ONE, TOKEN_KIND_YIELD_BEARING, YIELD_SHARE_VAULT_SEED,
    YIELD_STRATEGY_SEED,
};

// ---------------------------------------------------------------------------
// Helpers shared across handlers
// ---------------------------------------------------------------------------

/// Snapshot of mock-yield Reserve fields needed for accrual / share-conversion math.
#[derive(Clone, Copy, Debug)]
struct ReserveSnapshot {
    pub total_underlying: u64,
    pub share_supply: u64,
}

/// Read the post-accrue rate written by `mock_yield::accrue` via `set_return_data`. Falls back to
/// reading raw account data if return data is missing (e.g. non-Anchor caller mocks).
fn snapshot_reserve_after_accrue(
    expected_program: Pubkey,
    share_mint: &Account<Mint>,
) -> Result<ReserveSnapshot> {
    let (total_underlying, share_supply) = match get_return_data() {
        Some((program, data)) if program == expected_program && data.len() >= 16 => {
            let mut total = [0u8; 8];
            let mut supply = [0u8; 8];
            total.copy_from_slice(&data[0..8]);
            supply.copy_from_slice(&data[8..16]);
            (u64::from_le_bytes(total), u64::from_le_bytes(supply))
        }
        _ => (0u64, share_mint.supply),
    };
    Ok(ReserveSnapshot {
        total_underlying,
        share_supply,
    })
}

/// USDC value of `share_vault.amount` cUSDC at `(total_underlying, share_supply)`.
fn cusdc_to_usdc(cusdc_amount: u64, snap: ReserveSnapshot) -> Result<u64> {
    if snap.share_supply == 0 || cusdc_amount == 0 {
        return Ok(0);
    }
    let n = (cusdc_amount as u128)
        .checked_mul(snap.total_underlying as u128)
        .ok_or(error!(VaultError::MathOverflow))?
        / (snap.share_supply as u128);
    u64::try_from(n).map_err(|_| error!(VaultError::MathOverflow))
}

/// Inverse of `cusdc_to_usdc`: how many cUSDC do we redeem so the recipient gets *at most*
/// `usdc_amount` USDC? Round-down guarantees the redeem produces ≤ `usdc_amount` USDC, which
/// preserves the solvency invariant on the strategy's tracked counters (we pessimistically
/// decrement `last_settled_underlying` by the requested `usdc_amount`, never the actual paid).
/// Cost: recipient may be under-paid by at most one lamport per redeem; the dust stays inside the
/// share_vault and is attributed to user/protocol on the next accrual.
fn usdc_to_cusdc_round_down(usdc_amount: u64, snap: ReserveSnapshot) -> Result<u64> {
    if usdc_amount == 0 {
        return Ok(0);
    }
    require!(snap.total_underlying > 0, VaultError::InvalidYieldStrategy);
    let n = (usdc_amount as u128)
        .checked_mul(snap.share_supply as u128)
        .ok_or(error!(VaultError::MathOverflow))?;
    let div = snap.total_underlying as u128;
    let cusdc = n / div;
    u64::try_from(cusdc).map_err(|_| error!(VaultError::MathOverflow))
}

/// CPI mock_yield::accrue. Returns the post-accrue Reserve snapshot read via `set_return_data`.
fn cpi_mock_yield_accrue<'info>(
    yield_program: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    share_mint: &Account<'info, Mint>,
) -> Result<ReserveSnapshot> {
    let cpi_accounts = mock_yield::cpi::accounts::Accrue {
        reserve: reserve.clone(),
        share_mint: share_mint.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(yield_program.clone(), cpi_accounts);
    mock_yield::cpi::accrue(cpi_ctx)?;
    snapshot_reserve_after_accrue(yield_program.key(), share_mint)
}

/// Internal accrual entrypoint shared by every yield-aware handler. Calls mock-yield's `accrue`
/// (so `Reserve.total_underlying` is current), then walks the strategy index forward and routes
/// new yield to users / protocol per `protocol_yield_share_bps`. Updates `last_settled_underlying`.
fn accrue_strategy<'info>(
    strategy: &mut YieldStrategy,
    yield_program: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    share_mint: &Account<'info, Mint>,
    share_vault: &Account<'info, TokenAccount>,
) -> Result<ReserveSnapshot> {
    require_keys_eq!(
        yield_program.key(),
        strategy.yield_program,
        VaultError::InvalidYieldProgram
    );
    require_keys_eq!(
        reserve.key(),
        strategy.reserve,
        VaultError::InvalidYieldStrategy
    );
    require_keys_eq!(
        share_mint.key(),
        strategy.share_mint,
        VaultError::InvalidYieldStrategy
    );
    require_keys_eq!(
        share_vault.key(),
        strategy.share_vault,
        VaultError::InvalidYieldStrategy
    );

    let snap = cpi_mock_yield_accrue(yield_program, reserve, share_mint)?;
    let current_underlying = cusdc_to_usdc(share_vault.amount, snap)?;
    if current_underlying > strategy.last_settled_underlying {
        let delta = current_underlying - strategy.last_settled_underlying;
        apply_yield_delta(strategy, delta)?;
    }
    strategy.last_settled_underlying = current_underlying;

    emit!(YieldAccrued {
        token_id: strategy.token_id,
        current_underlying,
        last_settled_underlying: strategy.last_settled_underlying,
        user_index_q64: strategy.user_index_q64,
        protocol_owed_underlying: strategy.protocol_owed_underlying,
        total_user_shares: strategy.total_user_shares,
    });

    Ok(snap)
}

// ---------------------------------------------------------------------------
// register_yield_bearing_token
// ---------------------------------------------------------------------------

pub fn register_yield_bearing_token(
    ctx: Context<RegisterYieldBearingToken>,
    token_id: u16,
    symbol_bytes: [u8; 8],
    protocol_yield_share_bps: u16,
) -> Result<()> {
    let registry_data_len = ctx.accounts.token_registry.to_account_info().data_len();
    let registry = &mut ctx.accounts.token_registry;

    require!(
        ctx.accounts.authority.key() == registry.authority,
        VaultError::UnauthorizedTokenRegistration
    );
    require!(token_id > 0, VaultError::InvalidTokenId);
    require!(
        !registry.is_token_registered(token_id),
        VaultError::TokenIdAlreadyInUse
    );
    require!(
        symbol_bytes.iter().all(|byte| byte.is_ascii()),
        VaultError::InvalidTokenSymbol
    );
    require!(
        symbol_bytes.iter().any(|byte| *byte != 0),
        VaultError::InvalidTokenSymbol
    );

    let underlying = &ctx.accounts.underlying_mint;
    require!(
        underlying.decimals <= TokenRegistry::MAX_TOKEN_DECIMALS,
        VaultError::InvalidTokenDecimals
    );
    let bps = if protocol_yield_share_bps == 0 {
        DEFAULT_PROTOCOL_YIELD_SHARE_BPS
    } else {
        protocol_yield_share_bps
    };
    require!(
        bps <= MAX_PROTOCOL_YIELD_SHARE_BPS,
        VaultError::InvalidProtocolYieldShareBps
    );

    let reserve = &ctx.accounts.reserve;
    require_keys_eq!(
        reserve.underlying_mint,
        underlying.key(),
        VaultError::YieldUnderlyingMismatch
    );
    require_keys_eq!(
        reserve.share_mint,
        ctx.accounts.share_mint.key(),
        VaultError::InvalidYieldStrategy
    );
    require_keys_eq!(
        reserve.liquidity_vault,
        ctx.accounts.liquidity_vault.key(),
        VaultError::InvalidYieldStrategy
    );

    let now = Clock::get()?.unix_timestamp;
    let entry = TokenEntry {
        id: token_id,
        // No on-chain SPL mint for the wrapper — we reuse the underlying so client tooling can
        // still resolve a "real" mint for display / approvals. This is the registered-mint that
        // identifies the bucket logically; actual tokens (USDC) flow through `deposit_yield_bearing`.
        mint: underlying.key(),
        decimals: underlying.decimals,
        symbol: symbol_bytes,
        registered_at: now,
        kind: TOKEN_KIND_YIELD_BEARING,
        _reserved: [0u8; 4],
    };

    let required_space = TokenRegistry::required_space(registry.tokens.len() + 1)?;
    require!(
        registry_data_len >= required_space,
        VaultError::TokenRegistryFull
    );
    registry.tokens.push(entry);

    let strategy = &mut ctx.accounts.yield_strategy;
    strategy.token_id = token_id;
    strategy.bump = ctx.bumps.yield_strategy;
    strategy.share_vault_bump = ctx.bumps.share_vault;
    strategy.protocol_yield_share_bps = bps;
    strategy.underlying_mint = underlying.key();
    strategy.yield_program = ctx.accounts.yield_program.key();
    strategy.reserve = reserve.key();
    strategy.share_mint = ctx.accounts.share_mint.key();
    strategy.share_vault = ctx.accounts.share_vault.key();
    strategy.liquidity_vault = reserve.liquidity_vault;
    strategy.user_index_q64 = Q64_ONE;
    strategy.last_settled_underlying = 0;
    strategy.total_user_shares = 0;
    strategy.protocol_owed_underlying = 0;
    strategy._reserved = [0u8; 64];

    emit!(YieldBearingTokenRegistered {
        token_id,
        underlying_mint: strategy.underlying_mint,
        share_mint: strategy.share_mint,
        share_vault: strategy.share_vault,
        reserve: strategy.reserve,
        yield_program: strategy.yield_program,
        protocol_yield_share_bps: strategy.protocol_yield_share_bps,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// accrue_yield (permissionless)
// ---------------------------------------------------------------------------

pub fn accrue_yield(ctx: Context<AccrueYield>) -> Result<()> {
    let strategy = &mut ctx.accounts.yield_strategy;
    let _snap = accrue_strategy(
        strategy,
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve,
        &ctx.accounts.share_mint,
        &ctx.accounts.share_vault,
    )?;
    require_solvent(strategy, strategy.last_settled_underlying)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// deposit_yield_bearing
// ---------------------------------------------------------------------------

pub fn deposit_yield_bearing(
    ctx: Context<DepositYieldBearing>,
    token_id: u16,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, VaultError::AmountMustBePositive);

    let strategy_token_id = ctx.accounts.yield_strategy.token_id;
    require!(
        strategy_token_id == token_id,
        VaultError::InvalidYieldStrategy
    );

    // Validate registry agrees this token is yield-bearing.
    {
        let registry = &ctx.accounts.token_registry;
        let entry = registry
            .find_token(token_id)
            .ok_or(error!(VaultError::TokenNotFound))?;
        require!(entry.is_yield_bearing(), VaultError::TokenIsNotYieldBearing);
    }

    let strategy = &mut ctx.accounts.yield_strategy;
    let _snap = accrue_strategy(
        strategy,
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve,
        &ctx.accounts.share_mint,
        &ctx.accounts.share_vault,
    )?;

    // Pull USDC from depositor -> CPI deposit_reserve_liquidity (mints cUSDC into share_vault).
    cpi_deposit_reserve_liquidity(
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve.to_account_info(),
        &ctx.accounts.underlying_mint,
        &ctx.accounts.share_mint,
        &ctx.accounts.liquidity_vault,
        &ctx.accounts.depositor_underlying,
        &ctx.accounts.share_vault,
        &ctx.accounts.depositor.to_account_info(),
        &ctx.accounts.token_program,
        amount,
    )?;

    let shares_minted = strategy.usdc_to_shares(amount)?;
    require!(shares_minted > 0, VaultError::AmountMustBePositive);

    strategy.total_user_shares = strategy
        .total_user_shares
        .checked_add(shares_minted)
        .ok_or(error!(VaultError::MathOverflow))?;
    // The freshly deposited USDC isn't yield — bump last_settled_underlying so the next accrual
    // doesn't re-attribute it.
    strategy.last_settled_underlying = strategy
        .last_settled_underlying
        .checked_add(amount)
        .ok_or(error!(VaultError::MathOverflow))?;

    let depositor_key = ctx.accounts.depositor.key();
    let participant_id = ctx
        .accounts
        .owner_index_bucket
        .participant_id_for_verified_owner(
            &ctx.accounts.owner_index_bucket.key(),
            &depositor_key,
            ctx.program_id,
        )?;
    ParticipantBucket::verify_account_info(
        &ctx.accounts.participant_bucket.to_account_info(),
        ParticipantBucket::bucket_id_for_participant_id(participant_id),
        ctx.program_id,
    )?;
    {
        let info = ctx.accounts.participant_bucket.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ParticipantBucket::apply_token_delta_in_data(
            data.as_mut(),
            participant_id,
            token_id,
            i128::from(shares_minted),
        )?;
    }

    // Solvency check: after deposit, both sides of the invariant grew by exactly `amount`
    // (last_settled_underlying += amount; user_owed += shares_minted * index ≈ amount).
    // No re-CPI needed; tracked counters already reflect post-state.
    require_solvent(strategy, strategy.last_settled_underlying)?;

    emit!(YieldDeposited {
        participant_id,
        token_id,
        usdc_amount: amount,
        shares_minted,
        user_index_q64: strategy.user_index_q64,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// request_withdrawal_yield_bearing
// ---------------------------------------------------------------------------

pub fn request_withdrawal_yield_bearing(
    ctx: Context<RequestWithdrawalYieldBearing>,
    token_id: u16,
    shares: u64,
    destination: Pubkey,
) -> Result<()> {
    require!(shares > 0, VaultError::AmountMustBePositive);
    require!(
        destination != Pubkey::default(),
        VaultError::InvalidWithdrawalDestination
    );

    {
        let registry = &ctx.accounts.token_registry;
        let entry = registry
            .find_token(token_id)
            .ok_or(error!(VaultError::TokenNotFound))?;
        require!(entry.is_yield_bearing(), VaultError::TokenIsNotYieldBearing);
    }

    let strategy = &ctx.accounts.yield_strategy;
    require!(
        strategy.token_id == token_id,
        VaultError::InvalidYieldStrategy
    );
    require!(
        ctx.accounts.withdrawal_destination.key() == destination,
        VaultError::InvalidWithdrawalDestination
    );
    require!(
        ctx.accounts.withdrawal_destination.mint == strategy.underlying_mint,
        VaultError::InvalidTokenMint
    );

    let owner_key = ctx.accounts.owner.key();
    let participant_id = ctx
        .accounts
        .owner_index_bucket
        .participant_id_for_verified_owner(
            &ctx.accounts.owner_index_bucket.key(),
            &owner_key,
            ctx.program_id,
        )?;
    ParticipantBucket::verify_account_info(
        &ctx.accounts.participant_bucket.to_account_info(),
        ParticipantBucket::bucket_id_for_participant_id(participant_id),
        ctx.program_id,
    )?;

    let clock = Clock::get()?;
    let unlock_at = clock
        .unix_timestamp
        .checked_add(ctx.accounts.global_config.withdrawal_timelock_seconds)
        .ok_or(error!(VaultError::MathOverflow))?;
    {
        let info = ctx.accounts.participant_bucket.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ParticipantBucket::initiate_token_withdrawal_in_data(
            data.as_mut(),
            participant_id,
            token_id,
            shares,
            destination,
            unlock_at,
        )?;
    }

    emit!(crate::events::WithdrawalRequested {
        participant_id,
        token_id,
        amount: shares,
        destination,
        unlock_at,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// execute_withdrawal_yield_bearing
// ---------------------------------------------------------------------------

pub fn execute_withdrawal_yield_bearing(
    ctx: Context<ExecuteWithdrawalYieldBearing>,
    token_id: u16,
    participant_id: u32,
) -> Result<()> {
    {
        let registry = &ctx.accounts.token_registry;
        let entry = registry
            .find_token(token_id)
            .ok_or(error!(VaultError::TokenNotFound))?;
        require!(entry.is_yield_bearing(), VaultError::TokenIsNotYieldBearing);
        require!(
            entry.decimals <= TokenRegistry::MAX_TOKEN_DECIMALS,
            VaultError::InvalidTokenDecimals
        );
    }

    require!(
        ctx.accounts.yield_strategy.token_id == token_id,
        VaultError::InvalidYieldStrategy
    );

    ParticipantBucket::verify_account_info(
        &ctx.accounts.participant_bucket.to_account_info(),
        ParticipantBucket::bucket_id_for_participant_id(participant_id),
        ctx.program_id,
    )?;

    let strategy = &mut ctx.accounts.yield_strategy;
    let snap = accrue_strategy(
        strategy,
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve,
        &ctx.accounts.share_mint,
        &ctx.accounts.share_vault,
    )?;

    let snapshot = {
        let info = ctx.accounts.participant_bucket.to_account_info();
        let data = info.try_borrow_data()?;
        ParticipantBucket::read_token_withdrawal_from_data(data.as_ref(), participant_id, token_id)?
    };
    require!(
        snapshot.withdrawal_unlock_at != 0,
        VaultError::NoWithdrawalPending
    );
    require!(
        ctx.accounts.withdrawal_destination.key() == snapshot.withdrawal_destination,
        VaultError::InvalidWithdrawalDestination
    );
    require!(
        ctx.accounts.withdrawal_destination.mint == strategy.underlying_mint,
        VaultError::InvalidTokenMint
    );
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= snapshot.withdrawal_unlock_at,
        VaultError::WithdrawalLocked
    );

    let withdrawing_shares = snapshot.withdrawing_balance;
    let destination_pk = snapshot.withdrawal_destination;

    if withdrawing_shares == 0 {
        let info = ctx.accounts.participant_bucket.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ParticipantBucket::clear_token_withdrawal_in_data(data.as_mut(), participant_id, token_id)?;
        emit!(YieldWithdrawn {
            participant_id,
            token_id,
            shares_burned: 0,
            usdc_gross: 0,
            usdc_net: 0,
            usdc_fee: 0,
            destination: destination_pk,
        });
        let share_vault_underlying = cusdc_to_usdc(ctx.accounts.share_vault.amount, snap)?;
        require_solvent(strategy, share_vault_underlying)?;
        return Ok(());
    }

    // Gross USDC the user is entitled to before fee.
    let usdc_gross = strategy.shares_to_usdc(withdrawing_shares)?;

    let token_decimals = ctx
        .accounts
        .token_registry
        .find_token(token_id)
        .ok_or(error!(VaultError::TokenNotFound))?
        .decimals;
    let scaled_min_fee: u64 = if token_decimals >= 6 {
        let scale = 10u64
            .checked_pow((token_decimals - 6) as u32)
            .ok_or(error!(VaultError::MathOverflow))?;
        GlobalConfig::MIN_WITHDRAWAL_FEE_6DP
            .checked_mul(scale)
            .ok_or(error!(VaultError::MathOverflow))?
    } else {
        let divisor = 10u64
            .checked_pow((6 - token_decimals) as u32)
            .ok_or(error!(VaultError::MathOverflow))?;
        GlobalConfig::MIN_WITHDRAWAL_FEE_6DP
            .checked_div(divisor)
            .unwrap_or(1)
            .max(1)
    };
    let fee_pct_u128 = (usdc_gross as u128)
        .checked_mul(ctx.accounts.global_config.fee_bps as u128)
        .ok_or(error!(VaultError::MathOverflow))?
        / 10_000u128;
    let fee_pct = u64::try_from(fee_pct_u128).map_err(|_| error!(VaultError::MathOverflow))?;
    let usdc_fee = fee_pct.max(scaled_min_fee).min(usdc_gross);
    let usdc_net = usdc_gross - usdc_fee;

    let cusdc_for_net = usdc_to_cusdc_round_down(usdc_net, snap)?;
    let cusdc_for_fee = usdc_to_cusdc_round_down(usdc_fee, snap)?;

    let global_config_bump = ctx.bumps.global_config;
    let signer_seeds: &[&[&[u8]]] = &[&[GlobalConfig::SEED_PREFIX, &[global_config_bump]]];

    if usdc_net > 0 && cusdc_for_net > 0 {
        cpi_redeem_reserve_collateral(
            &ctx.accounts.yield_program,
            &ctx.accounts.reserve.to_account_info(),
            &ctx.accounts.underlying_mint,
            &ctx.accounts.share_mint,
            &ctx.accounts.liquidity_vault,
            &ctx.accounts.share_vault,
            &ctx.accounts.withdrawal_destination,
            &ctx.accounts.global_config.to_account_info(),
            &ctx.accounts.token_program,
            cusdc_for_net,
            signer_seeds,
        )?;
    }
    if usdc_fee > 0 && cusdc_for_fee > 0 {
        cpi_redeem_reserve_collateral(
            &ctx.accounts.yield_program,
            &ctx.accounts.reserve.to_account_info(),
            &ctx.accounts.underlying_mint,
            &ctx.accounts.share_mint,
            &ctx.accounts.liquidity_vault,
            &ctx.accounts.share_vault,
            &ctx.accounts.fee_recipient_token_account,
            &ctx.accounts.global_config.to_account_info(),
            &ctx.accounts.token_program,
            cusdc_for_fee,
            signer_seeds,
        )?;
    }

    strategy.total_user_shares = strategy
        .total_user_shares
        .checked_sub(withdrawing_shares)
        .ok_or(error!(VaultError::MathOverflow))?;
    strategy.last_settled_underlying = strategy.last_settled_underlying.saturating_sub(usdc_gross);

    {
        let info = ctx.accounts.participant_bucket.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ParticipantBucket::clear_token_withdrawal_in_data(data.as_mut(), participant_id, token_id)?;
    }

    // Solvency: with round-down on `cusdc_for_*`, the actual underlying paid out is ≤ usdc_gross.
    // We pessimistically decremented `last_settled_underlying` by usdc_gross, so tracked LHS is ≤
    // real share_vault USDC value. Tracked invariant => real invariant.
    require_solvent(strategy, strategy.last_settled_underlying)?;

    emit!(YieldWithdrawn {
        participant_id,
        token_id,
        shares_burned: withdrawing_shares,
        usdc_gross,
        usdc_net,
        usdc_fee,
        destination: destination_pk,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// claim_protocol_yield_fee
// ---------------------------------------------------------------------------

pub fn claim_protocol_yield_fee(
    ctx: Context<ClaimProtocolYieldFee>,
    token_id: u16,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, VaultError::AmountMustBePositive);
    require!(
        ctx.accounts.yield_strategy.token_id == token_id,
        VaultError::InvalidYieldStrategy
    );
    require!(
        ctx.accounts.fee_recipient.key() == ctx.accounts.global_config.fee_recipient,
        VaultError::InvalidFeeRecipient
    );

    let strategy = &mut ctx.accounts.yield_strategy;
    let snap = accrue_strategy(
        strategy,
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve,
        &ctx.accounts.share_mint,
        &ctx.accounts.share_vault,
    )?;
    require!(
        amount <= strategy.protocol_owed_underlying,
        VaultError::InsufficientProtocolYield
    );

    let cusdc_to_burn = usdc_to_cusdc_round_down(amount, snap)?;

    let global_config_bump = ctx.bumps.global_config;
    let signer_seeds: &[&[&[u8]]] = &[&[GlobalConfig::SEED_PREFIX, &[global_config_bump]]];

    cpi_redeem_reserve_collateral(
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve.to_account_info(),
        &ctx.accounts.underlying_mint,
        &ctx.accounts.share_mint,
        &ctx.accounts.liquidity_vault,
        &ctx.accounts.share_vault,
        &ctx.accounts.fee_recipient_token_account,
        &ctx.accounts.global_config.to_account_info(),
        &ctx.accounts.token_program,
        cusdc_to_burn,
        signer_seeds,
    )?;

    strategy.protocol_owed_underlying = strategy
        .protocol_owed_underlying
        .checked_sub(amount)
        .ok_or(error!(VaultError::MathOverflow))?;
    strategy.last_settled_underlying = strategy.last_settled_underlying.saturating_sub(amount);

    require_solvent(strategy, strategy.last_settled_underlying)?;

    emit!(ProtocolYieldClaimed {
        token_id,
        fee_recipient: ctx.accounts.fee_recipient.key(),
        usdc_amount: amount,
        protocol_owed_underlying_after: strategy.protocol_owed_underlying,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// opt_in_yield
// ---------------------------------------------------------------------------
//
// Move `amount_usdc` of an owner's plain-USDC bucket into yield. Protocol-internal: the user's
// wallet ATA is never touched; the underlying USDC moves between protocol-owned vault PDAs only.
//
// Sequence:
//   1. Validate plain entry (`!is_yield_bearing`), yield entry (`is_yield_bearing`), and that
//      `plain_token_entry.mint == strategy.underlying_mint` (else `MismatchedYieldUnderlying`).
//   2. `accrue_strategy(...)` — refresh index against latest mock-yield rate.
//   3. Debit `amount_usdc` from owner's plain bucket *available* slot (errors if too low — locked
//      balance is not eligible).
//   4. CPI `mock_yield::deposit_reserve_liquidity`, signed by `global_config` PDA. Plain USDC vault
//      PDA -> mock-yield's liquidity_vault; cUSDC mints into ryvo's `share_vault`.
//   5. `shares_minted = strategy.usdc_to_shares(amount_usdc)`. `total_user_shares` and
//      `last_settled_underlying` both grow by exactly the user's contribution.
//   6. Credit `shares_minted` into the owner's yield bucket *available* slot.
//   7. Solvency check.

pub fn opt_in_yield(
    ctx: Context<OptInYield>,
    plain_token_id: u16,
    yield_token_id: u16,
    amount_usdc: u64,
) -> Result<()> {
    require!(amount_usdc > 0, VaultError::AmountMustBePositive);
    require!(
        plain_token_id != yield_token_id,
        VaultError::InvalidYieldStrategy
    );

    let strategy_token_id = ctx.accounts.yield_strategy.token_id;
    require!(
        strategy_token_id == yield_token_id,
        VaultError::InvalidYieldStrategy
    );

    // 1. TokenRegistry validation.
    let underlying_mint_key = ctx.accounts.underlying_mint.key();
    {
        let registry = &ctx.accounts.token_registry;
        let plain_entry = registry
            .find_token(plain_token_id)
            .ok_or(error!(VaultError::TokenNotFound))?;
        require!(
            !plain_entry.is_yield_bearing(),
            VaultError::TokenIsYieldBearing
        );
        require_keys_eq!(
            plain_entry.mint,
            underlying_mint_key,
            VaultError::MismatchedYieldUnderlying
        );

        let yield_entry = registry
            .find_token(yield_token_id)
            .ok_or(error!(VaultError::TokenNotFound))?;
        require!(
            yield_entry.is_yield_bearing(),
            VaultError::TokenIsNotYieldBearing
        );
    }

    // 2. Resolve owner's participant id.
    let owner_key = ctx.accounts.owner.key();
    let participant_id = ctx
        .accounts
        .owner_index_bucket
        .participant_id_for_verified_owner(
            &ctx.accounts.owner_index_bucket.key(),
            &owner_key,
            ctx.program_id,
        )?;
    ParticipantBucket::verify_account_info(
        &ctx.accounts.participant_bucket.to_account_info(),
        ParticipantBucket::bucket_id_for_participant_id(participant_id),
        ctx.program_id,
    )?;

    // 3. Refresh strategy + debit plain bucket *available* (insufficient -> InsufficientBalance).
    let strategy = &mut ctx.accounts.yield_strategy;
    let _snap = accrue_strategy(
        strategy,
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve,
        &ctx.accounts.share_mint,
        &ctx.accounts.share_vault,
    )?;

    {
        let info = ctx.accounts.participant_bucket.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ParticipantBucket::debit_token_available_in_data(
            data.as_mut(),
            participant_id,
            plain_token_id,
            amount_usdc,
        )?;
    }

    // 4. CPI deposit_reserve_liquidity, signed by global_config PDA over the plain USDC vault.
    let global_config_bump = ctx.bumps.global_config;
    let signer_seeds: &[&[&[u8]]] = &[&[GlobalConfig::SEED_PREFIX, &[global_config_bump]]];

    cpi_deposit_reserve_liquidity_signed(
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve.to_account_info(),
        &ctx.accounts.underlying_mint,
        &ctx.accounts.share_mint,
        &ctx.accounts.liquidity_vault,
        &ctx.accounts.plain_vault_token_account,
        &ctx.accounts.share_vault,
        &ctx.accounts.global_config.to_account_info(),
        &ctx.accounts.token_program,
        amount_usdc,
        signer_seeds,
    )?;

    // 5. Credit shares + update strategy counters.
    let shares_minted = strategy.usdc_to_shares(amount_usdc)?;
    require!(shares_minted > 0, VaultError::AmountMustBePositive);

    strategy.total_user_shares = strategy
        .total_user_shares
        .checked_add(shares_minted)
        .ok_or(error!(VaultError::MathOverflow))?;
    strategy.last_settled_underlying = strategy
        .last_settled_underlying
        .checked_add(amount_usdc)
        .ok_or(error!(VaultError::MathOverflow))?;

    {
        let info = ctx.accounts.participant_bucket.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ParticipantBucket::apply_token_delta_in_data(
            data.as_mut(),
            participant_id,
            yield_token_id,
            i128::from(shares_minted),
        )?;
    }

    // 6. Solvency: fresh `last_settled_underlying` is the tracked LHS (over-counts the new
    // contribution by exactly `amount_usdc`, exactly matching the new RHS).
    require_solvent(strategy, strategy.last_settled_underlying)?;

    emit!(OptedInYield {
        participant_id,
        plain_token_id,
        yield_token_id,
        usdc_amount: amount_usdc,
        shares_minted,
        user_index_q64: strategy.user_index_q64,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// opt_out_yield
// ---------------------------------------------------------------------------
//
// Burn `shares` ryUSDC from the owner's yield bucket; redeem cUSDC to USDC into the protocol's
// plain USDC vault PDA; credit the owner's plain bucket with the redeemed USDC.
//
// Mirror of `opt_in_yield`. Round-down on cUSDC redemption can leave 1 lamport of dust per call
// in `share_vault`; the dust is attributed to all users on the next accrual.

pub fn opt_out_yield(
    ctx: Context<OptOutYield>,
    yield_token_id: u16,
    plain_token_id: u16,
    shares: u64,
) -> Result<()> {
    require!(shares > 0, VaultError::AmountMustBePositive);
    require!(
        plain_token_id != yield_token_id,
        VaultError::InvalidYieldStrategy
    );

    let strategy_token_id = ctx.accounts.yield_strategy.token_id;
    require!(
        strategy_token_id == yield_token_id,
        VaultError::InvalidYieldStrategy
    );

    // 1. TokenRegistry validation.
    let underlying_mint_key = ctx.accounts.underlying_mint.key();
    {
        let registry = &ctx.accounts.token_registry;
        let yield_entry = registry
            .find_token(yield_token_id)
            .ok_or(error!(VaultError::TokenNotFound))?;
        require!(
            yield_entry.is_yield_bearing(),
            VaultError::TokenIsNotYieldBearing
        );

        let plain_entry = registry
            .find_token(plain_token_id)
            .ok_or(error!(VaultError::TokenNotFound))?;
        require!(
            !plain_entry.is_yield_bearing(),
            VaultError::TokenIsYieldBearing
        );
        require_keys_eq!(
            plain_entry.mint,
            underlying_mint_key,
            VaultError::MismatchedYieldUnderlying
        );
    }

    // 2. Resolve owner's participant id.
    let owner_key = ctx.accounts.owner.key();
    let participant_id = ctx
        .accounts
        .owner_index_bucket
        .participant_id_for_verified_owner(
            &ctx.accounts.owner_index_bucket.key(),
            &owner_key,
            ctx.program_id,
        )?;
    ParticipantBucket::verify_account_info(
        &ctx.accounts.participant_bucket.to_account_info(),
        ParticipantBucket::bucket_id_for_participant_id(participant_id),
        ctx.program_id,
    )?;

    // 3. Refresh strategy.
    let strategy = &mut ctx.accounts.yield_strategy;
    let snap = accrue_strategy(
        strategy,
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve,
        &ctx.accounts.share_mint,
        &ctx.accounts.share_vault,
    )?;

    // 4. Debit shares from yield bucket *available* (locked is excluded).
    {
        let info = ctx.accounts.participant_bucket.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ParticipantBucket::debit_token_available_in_data(
            data.as_mut(),
            participant_id,
            yield_token_id,
            shares,
        )?;
    }

    // 5. Compute redemption amounts.
    //    `usdc_owed`              = user's USDC claim per current index (rounds down).
    //    `cusdc_to_burn`          = shares of mock-yield to redeem (rounds down -> ≤ usdc_owed).
    //    `usdc_actually_received` = USDC the redeem will deposit into the plain vault.
    //
    // We credit the owner's plain bucket with `usdc_actually_received` so the bucket and the plain
    // vault stay in lock-step; up to 1 lamport of dust remains in `share_vault` and accrues back to
    // all users on the next yield update.
    let usdc_owed = strategy.shares_to_usdc(shares)?;
    require!(usdc_owed > 0, VaultError::AmountMustBePositive);
    let cusdc_to_burn = usdc_to_cusdc_round_down(usdc_owed, snap)?;
    require!(cusdc_to_burn > 0, VaultError::AmountMustBePositive);
    let usdc_actually_received = cusdc_to_usdc(cusdc_to_burn, snap)?;
    require!(usdc_actually_received > 0, VaultError::AmountMustBePositive);

    // 6. CPI redeem: share_vault burns cusdc_to_burn, plain USDC vault receives
    // usdc_actually_received USDC. Authority over share_vault is global_config PDA.
    let global_config_bump = ctx.bumps.global_config;
    let signer_seeds: &[&[&[u8]]] = &[&[GlobalConfig::SEED_PREFIX, &[global_config_bump]]];

    cpi_redeem_reserve_collateral(
        &ctx.accounts.yield_program,
        &ctx.accounts.reserve.to_account_info(),
        &ctx.accounts.underlying_mint,
        &ctx.accounts.share_mint,
        &ctx.accounts.liquidity_vault,
        &ctx.accounts.share_vault,
        &ctx.accounts.plain_vault_token_account,
        &ctx.accounts.global_config.to_account_info(),
        &ctx.accounts.token_program,
        cusdc_to_burn,
        signer_seeds,
    )?;

    // 7. Update strategy + credit plain bucket.
    strategy.total_user_shares = strategy
        .total_user_shares
        .checked_sub(shares)
        .ok_or(error!(VaultError::MathOverflow))?;
    strategy.last_settled_underlying = strategy
        .last_settled_underlying
        .saturating_sub(usdc_actually_received);

    {
        let info = ctx.accounts.participant_bucket.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        ParticipantBucket::apply_token_delta_in_data(
            data.as_mut(),
            participant_id,
            plain_token_id,
            i128::from(usdc_actually_received),
        )?;
    }

    // 8. Solvency check using the freshly-decremented LHS.
    require_solvent(strategy, strategy.last_settled_underlying)?;

    emit!(OptedOutYield {
        participant_id,
        yield_token_id,
        plain_token_id,
        shares_burned: shares,
        usdc_credited: usdc_actually_received,
        user_index_q64: strategy.user_index_q64,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// CPI helpers
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn cpi_deposit_reserve_liquidity<'info>(
    yield_program: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    underlying_mint: &Account<'info, Mint>,
    share_mint: &Account<'info, Mint>,
    liquidity_vault: &Account<'info, TokenAccount>,
    depositor_underlying: &Account<'info, TokenAccount>,
    depositor_shares: &Account<'info, TokenAccount>,
    depositor: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let cpi_accounts = mock_yield::cpi::accounts::DepositReserveLiquidity {
        reserve: reserve.clone(),
        underlying_mint: underlying_mint.to_account_info(),
        share_mint: share_mint.to_account_info(),
        liquidity_vault: liquidity_vault.to_account_info(),
        depositor_underlying: depositor_underlying.to_account_info(),
        depositor_shares: depositor_shares.to_account_info(),
        depositor: depositor.clone(),
        token_program: token_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(yield_program.clone(), cpi_accounts);
    mock_yield::cpi::deposit_reserve_liquidity(cpi_ctx, amount)
}

/// PDA-signed variant of `cpi_deposit_reserve_liquidity` for when the source `depositor_underlying`
/// is a protocol-owned PDA (e.g. the plain USDC vault during `opt_in_yield`).
#[allow(clippy::too_many_arguments)]
fn cpi_deposit_reserve_liquidity_signed<'info>(
    yield_program: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    underlying_mint: &Account<'info, Mint>,
    share_mint: &Account<'info, Mint>,
    liquidity_vault: &Account<'info, TokenAccount>,
    depositor_underlying: &Account<'info, TokenAccount>,
    depositor_shares: &Account<'info, TokenAccount>,
    depositor: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let cpi_accounts = mock_yield::cpi::accounts::DepositReserveLiquidity {
        reserve: reserve.clone(),
        underlying_mint: underlying_mint.to_account_info(),
        share_mint: share_mint.to_account_info(),
        liquidity_vault: liquidity_vault.to_account_info(),
        depositor_underlying: depositor_underlying.to_account_info(),
        depositor_shares: depositor_shares.to_account_info(),
        depositor: depositor.clone(),
        token_program: token_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(yield_program.clone(), cpi_accounts, signer_seeds);
    mock_yield::cpi::deposit_reserve_liquidity(cpi_ctx, amount)
}

#[allow(clippy::too_many_arguments)]
fn cpi_redeem_reserve_collateral<'info>(
    yield_program: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    underlying_mint: &Account<'info, Mint>,
    share_mint: &Account<'info, Mint>,
    liquidity_vault: &Account<'info, TokenAccount>,
    redeemer_shares: &Account<'info, TokenAccount>,
    redeemer_underlying: &Account<'info, TokenAccount>,
    share_authority: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    shares: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let cpi_accounts = mock_yield::cpi::accounts::RedeemReserveCollateral {
        reserve: reserve.clone(),
        underlying_mint: underlying_mint.to_account_info(),
        share_mint: share_mint.to_account_info(),
        liquidity_vault: liquidity_vault.to_account_info(),
        redeemer_shares: redeemer_shares.to_account_info(),
        redeemer_underlying: redeemer_underlying.to_account_info(),
        share_authority: share_authority.clone(),
        token_program: token_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(yield_program.clone(), cpi_accounts, signer_seeds);
    mock_yield::cpi::redeem_reserve_collateral(cpi_ctx, shares)
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct RegisterYieldBearingToken<'info> {
    #[account(
        mut,
        seeds = [TokenRegistry::SEED_PREFIX],
        bump = token_registry.bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump = global_config.bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + YieldStrategy::SPACE,
        seeds = [YIELD_STRATEGY_SEED, token_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub yield_strategy: Account<'info, YieldStrategy>,

    /// Underlying SPL mint (USDC).
    pub underlying_mint: Account<'info, Mint>,

    /// Lending program (mock-yield in dev / Save-Kamino in prod). Validated against `Reserve`.
    /// CHECK: program id is checked via the on-chain instruction it dispatches.
    pub yield_program: UncheckedAccount<'info>,

    /// Existing `Reserve` PDA in the yield program. Must be initialised already.
    pub reserve: Account<'info, mock_yield::Reserve>,

    /// Lending share mint (cUSDC). Mint authority = `reserve`.
    pub share_mint: Account<'info, Mint>,

    /// Reserve's USDC vault — kept for symmetry/CPI ergonomics.
    pub liquidity_vault: Account<'info, TokenAccount>,

    /// Protocol-owned cUSDC ATA under GlobalConfig PDA. PDA-seeded so it is deterministic.
    #[account(
        init,
        payer = authority,
        seeds = [YIELD_SHARE_VAULT_SEED, token_id.to_le_bytes().as_ref()],
        bump,
        token::mint = share_mint,
        token::authority = global_config,
    )]
    pub share_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AccrueYield<'info> {
    #[account(
        mut,
        seeds = [YIELD_STRATEGY_SEED, yield_strategy.token_id.to_le_bytes().as_ref()],
        bump = yield_strategy.bump,
    )]
    pub yield_strategy: Account<'info, YieldStrategy>,

    /// CHECK: validated inside accrue_strategy via strategy.yield_program.
    pub yield_program: UncheckedAccount<'info>,

    /// CHECK: validated inside accrue_strategy via strategy.reserve.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    #[account(address = yield_strategy.share_mint @ VaultError::InvalidYieldStrategy)]
    pub share_mint: Account<'info, Mint>,

    #[account(address = yield_strategy.share_vault @ VaultError::InvalidYieldStrategy)]
    pub share_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct DepositYieldBearing<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump = token_registry.bump,
    )]
    pub token_registry: Box<Account<'info, TokenRegistry>>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [YIELD_STRATEGY_SEED, token_id.to_le_bytes().as_ref()],
        bump = yield_strategy.bump,
    )]
    pub yield_strategy: Box<Account<'info, YieldStrategy>>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Box<Account<'info, OwnerIndexBucket>>,

    /// CHECK: validated inside accrue_strategy via strategy.yield_program.
    pub yield_program: UncheckedAccount<'info>,

    /// CHECK: validated inside accrue_strategy via strategy.reserve.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    #[account(
        address = yield_strategy.underlying_mint @ VaultError::YieldUnderlyingMismatch,
    )]
    pub underlying_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.share_mint @ VaultError::InvalidYieldStrategy,
    )]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.liquidity_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub liquidity_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = yield_strategy.share_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub share_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = depositor_underlying.mint == yield_strategy.underlying_mint @ VaultError::InvalidTokenMint,
        constraint = depositor_underlying.owner == depositor.key() @ VaultError::UnauthorizedTokenRegistration,
    )]
    pub depositor_underlying: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct RequestWithdrawalYieldBearing<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump = token_registry.bump,
    )]
    pub token_registry: Box<Account<'info, TokenRegistry>>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [YIELD_STRATEGY_SEED, token_id.to_le_bytes().as_ref()],
        bump = yield_strategy.bump,
    )]
    pub yield_strategy: Box<Account<'info, YieldStrategy>>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw withdrawal mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Box<Account<'info, OwnerIndexBucket>>,

    #[account(
        constraint = withdrawal_destination.mint == yield_strategy.underlying_mint @ VaultError::InvalidTokenMint,
    )]
    pub withdrawal_destination: Box<Account<'info, TokenAccount>>,

    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(token_id: u16, participant_id: u32)]
pub struct ExecuteWithdrawalYieldBearing<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump = token_registry.bump,
    )]
    pub token_registry: Box<Account<'info, TokenRegistry>>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [YIELD_STRATEGY_SEED, token_id.to_le_bytes().as_ref()],
        bump = yield_strategy.bump,
    )]
    pub yield_strategy: Box<Account<'info, YieldStrategy>>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw withdrawal mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    /// CHECK: validated inside accrue_strategy via strategy.yield_program.
    pub yield_program: UncheckedAccount<'info>,

    /// CHECK: validated inside accrue_strategy via strategy.reserve.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    #[account(
        address = yield_strategy.underlying_mint @ VaultError::YieldUnderlyingMismatch,
    )]
    pub underlying_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.share_mint @ VaultError::InvalidYieldStrategy,
    )]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.liquidity_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub liquidity_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = yield_strategy.share_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub share_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = withdrawal_destination.mint == yield_strategy.underlying_mint @ VaultError::InvalidTokenMint,
    )]
    pub withdrawal_destination: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = fee_recipient_token_account.owner == global_config.fee_recipient @ VaultError::InvalidFeeRecipient,
        constraint = fee_recipient_token_account.mint == yield_strategy.underlying_mint @ VaultError::InvalidTokenMint,
    )]
    pub fee_recipient_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct ClaimProtocolYieldFee<'info> {
    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [YIELD_STRATEGY_SEED, token_id.to_le_bytes().as_ref()],
        bump = yield_strategy.bump,
    )]
    pub yield_strategy: Box<Account<'info, YieldStrategy>>,

    /// CHECK: validated inside accrue_strategy via strategy.yield_program.
    pub yield_program: UncheckedAccount<'info>,

    /// CHECK: validated inside accrue_strategy via strategy.reserve.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    #[account(
        address = yield_strategy.underlying_mint @ VaultError::YieldUnderlyingMismatch,
    )]
    pub underlying_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.share_mint @ VaultError::InvalidYieldStrategy,
    )]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.liquidity_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub liquidity_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = yield_strategy.share_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub share_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = fee_recipient_token_account.owner == global_config.fee_recipient @ VaultError::InvalidFeeRecipient,
        constraint = fee_recipient_token_account.mint == yield_strategy.underlying_mint @ VaultError::InvalidTokenMint,
    )]
    pub fee_recipient_token_account: Box<Account<'info, TokenAccount>>,

    /// Must be the fee_recipient (verified inside the handler against `global_config.fee_recipient`).
    pub fee_recipient: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(plain_token_id: u16, yield_token_id: u16)]
pub struct OptInYield<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump = token_registry.bump,
    )]
    pub token_registry: Box<Account<'info, TokenRegistry>>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [YIELD_STRATEGY_SEED, yield_token_id.to_le_bytes().as_ref()],
        bump = yield_strategy.bump,
    )]
    pub yield_strategy: Box<Account<'info, YieldStrategy>>,

    /// Plain USDC vault PDA (token-id-scoped). Source of underlying for the lending CPI.
    #[account(
        mut,
        seeds = [b"vault-token-account", plain_token_id.to_le_bytes().as_ref()],
        bump,
        constraint = plain_vault_token_account.mint == yield_strategy.underlying_mint @ VaultError::MismatchedYieldUnderlying,
    )]
    pub plain_vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Box<Account<'info, OwnerIndexBucket>>,

    /// CHECK: validated inside accrue_strategy via strategy.yield_program.
    pub yield_program: UncheckedAccount<'info>,

    /// CHECK: validated inside accrue_strategy via strategy.reserve.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    #[account(
        address = yield_strategy.underlying_mint @ VaultError::YieldUnderlyingMismatch,
    )]
    pub underlying_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.share_mint @ VaultError::InvalidYieldStrategy,
    )]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.liquidity_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub liquidity_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = yield_strategy.share_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub share_vault: Box<Account<'info, TokenAccount>>,

    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(yield_token_id: u16, plain_token_id: u16)]
pub struct OptOutYield<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump = token_registry.bump,
    )]
    pub token_registry: Box<Account<'info, TokenRegistry>>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [YIELD_STRATEGY_SEED, yield_token_id.to_le_bytes().as_ref()],
        bump = yield_strategy.bump,
    )]
    pub yield_strategy: Box<Account<'info, YieldStrategy>>,

    /// Plain USDC vault PDA — destination for redeemed underlying.
    #[account(
        mut,
        seeds = [b"vault-token-account", plain_token_id.to_le_bytes().as_ref()],
        bump,
        constraint = plain_vault_token_account.mint == yield_strategy.underlying_mint @ VaultError::MismatchedYieldUnderlying,
    )]
    pub plain_vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Box<Account<'info, OwnerIndexBucket>>,

    /// CHECK: validated inside accrue_strategy via strategy.yield_program.
    pub yield_program: UncheckedAccount<'info>,

    /// CHECK: validated inside accrue_strategy via strategy.reserve.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    #[account(
        address = yield_strategy.underlying_mint @ VaultError::YieldUnderlyingMismatch,
    )]
    pub underlying_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.share_mint @ VaultError::InvalidYieldStrategy,
    )]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = yield_strategy.liquidity_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub liquidity_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = yield_strategy.share_vault @ VaultError::InvalidYieldStrategy,
    )]
    pub share_vault: Box<Account<'info, TokenAccount>>,

    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
