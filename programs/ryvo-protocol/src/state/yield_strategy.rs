//! Yield-bearing strategy account.
//!
//! Each yield-bearing TokenEntry has exactly one `YieldStrategy` PDA, seeded by
//! `[b"yield-strategy", token_id_le]`. The strategy tracks the index that maps protocol-internal
//! shares (`ryUSDC`) to underlying USDC, and accumulates the protocol's continuous yield skim in
//! `protocol_owed_underlying`. The strategy never touches user balances directly; balances live on
//! ParticipantBucket slots, this account only stores the rate and aggregate counters.
//!
//! ## Invariant (checked after every yield-aware handler)
//!
//! ```text
//!   share_vault.balance * (mock_yield.total_underlying / mock_yield.share_supply)
//!     >= total_user_shares * user_index_q64 / 2^64 + protocol_owed_underlying
//! ```
//!
//! This is the solvency property: the USDC value of the protocol-owned cUSDC vault is always at
//! least the USDC owed to users (ag-shares converted at the current index) plus the USDC owed to
//! the protocol fee recipient.
//!
//! Q64.64 fixed point. `1.0` is `1u128 << 64`.

use anchor_lang::prelude::*;

pub const YIELD_STRATEGY_SEED: &[u8] = b"yield-strategy";
pub const YIELD_SHARE_VAULT_SEED: &[u8] = b"yield-share-vault";

/// Default protocol cut: 33.33% of yield, equivalent to "2% absolute on a 6% gross" yield.
pub const DEFAULT_PROTOCOL_YIELD_SHARE_BPS: u16 = 3_333;
/// Maximum protocol skim: 50% of yield. Hard cap for safety so an authority cannot retroactively
/// set the skim to >50%.
pub const MAX_PROTOCOL_YIELD_SHARE_BPS: u16 = 5_000;

/// Q64.64 unit (`1.0`).
pub const Q64_ONE: u128 = 1u128 << 64;

#[account]
pub struct YieldStrategy {
    /// ryUSDC token id (the yield-bearing wrapper this strategy represents).
    pub token_id: u16, // 2
    /// PDA bump for `[YIELD_STRATEGY_SEED, token_id_le]`.
    pub bump: u8, // 1
    /// PDA bump for `[YIELD_SHARE_VAULT_SEED, token_id_le]`.
    pub share_vault_bump: u8, // 1
    /// Protocol's slice of new yield, in basis points. `3_333` = 33.33%.
    pub protocol_yield_share_bps: u16, // 2
    /// Underlying SPL mint (e.g. USDC). Same as `mock_yield::Reserve.underlying_mint`.
    pub underlying_mint: Pubkey, // 32
    /// Mock-yield (or production lending) program id.
    pub yield_program: Pubkey, // 32
    /// `Reserve` account in the yield program.
    pub reserve: Pubkey, // 32
    /// Lending share mint (e.g. cUSDC).
    pub share_mint: Pubkey, // 32
    /// Protocol-owned ATA holding cUSDC, authority = GlobalConfig PDA. Single ATA backs both
    /// users and the protocol fee.
    pub share_vault: Pubkey, // 32
    /// `Reserve.liquidity_vault` cached for CPI ergonomics.
    pub liquidity_vault: Pubkey, // 32
    /// Q64.64 index: 1 ryUSDC share -> (user_index_q64 / 2^64) USDC. Starts at `Q64_ONE`,
    /// monotonically non-decreasing under accrual, never decreases under deposits/withdrawals.
    pub user_index_q64: u128, // 16
    /// USDC value of `share_vault` as of last accrual. Used to detect new yield in `accrue_yield`.
    pub last_settled_underlying: u64, // 8
    /// Sum of ryUSDC `available + withdrawing` across all participant buckets for this token.
    /// Sanity counter; truth still lives in buckets. Used by `accrue_yield` to compute per-share
    /// yield attribution and to enforce the invariant.
    pub total_user_shares: u64, // 8
    /// Protocol's USDC claim. Increases only inside `accrue_yield`. Decreases only inside
    /// `claim_protocol_yield_fee`. Never touched by deposit/withdraw/channel paths.
    pub protocol_owed_underlying: u64, // 8
    /// Padding for future fields (e.g. additional fee tiers, snapshot history).
    pub _reserved: [u8; 64], // 64
}

impl YieldStrategy {
    /// Account data size *excluding* Anchor's 8-byte discriminator.
    pub const SPACE: usize = 2  // token_id
        + 1                     // bump
        + 1                     // share_vault_bump
        + 2                     // protocol_yield_share_bps
        + 32                    // underlying_mint
        + 32                    // yield_program
        + 32                    // reserve
        + 32                    // share_mint
        + 32                    // share_vault
        + 32                    // liquidity_vault
        + 16                    // user_index_q64
        + 8                     // last_settled_underlying
        + 8                     // total_user_shares
        + 8                     // protocol_owed_underlying
        + 64; // _reserved

    pub fn seeds<'a>(token_id_bytes: &'a [u8; 2], bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
        [YIELD_STRATEGY_SEED, token_id_bytes.as_ref(), bump.as_ref()]
    }

    pub fn share_vault_seeds<'a>(token_id_bytes: &'a [u8; 2], bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
        [
            YIELD_SHARE_VAULT_SEED,
            token_id_bytes.as_ref(),
            bump.as_ref(),
        ]
    }

    /// USDC value of `total_user_shares` at the current index. Returns the rounded-down USDC
    /// equivalent of all user-held ryUSDC.
    pub fn user_underlying_owed(&self) -> Result<u64> {
        let owed_q64 = (self.total_user_shares as u128)
            .checked_mul(self.user_index_q64)
            .ok_or(error!(crate::errors::VaultError::MathOverflow))?;
        u64::try_from(owed_q64 >> 64).map_err(|_| error!(crate::errors::VaultError::MathOverflow))
    }

    /// Translate `usdc` -> ryUSDC shares using the current index. Rounds down (favours protocol).
    pub fn usdc_to_shares(&self, usdc: u64) -> Result<u64> {
        let shares_q64 = (usdc as u128)
            .checked_shl(64)
            .ok_or(error!(crate::errors::VaultError::MathOverflow))?
            / self.user_index_q64;
        u64::try_from(shares_q64).map_err(|_| error!(crate::errors::VaultError::MathOverflow))
    }

    /// Translate ryUSDC shares -> USDC. Rounds down (favours protocol on withdrawal fee math).
    pub fn shares_to_usdc(&self, shares: u64) -> Result<u64> {
        let usdc_q64 = (shares as u128)
            .checked_mul(self.user_index_q64)
            .ok_or(error!(crate::errors::VaultError::MathOverflow))?;
        u64::try_from(usdc_q64 >> 64).map_err(|_| error!(crate::errors::VaultError::MathOverflow))
    }
}

/// Apply a yield delta to the strategy. `delta_underlying` is the new USDC value flowing into the
/// `share_vault` (i.e. `current_underlying - last_settled_underlying`). Allocates between users
/// and protocol per `protocol_yield_share_bps` and updates `user_index_q64`.
pub fn apply_yield_delta(strategy: &mut YieldStrategy, delta_underlying: u64) -> Result<()> {
    if delta_underlying == 0 {
        return Ok(());
    }
    if strategy.total_user_shares == 0 {
        // No outstanding user shares; route every lamport of yield to the protocol so it is
        // never silently absorbed into a future depositor's index.
        strategy.protocol_owed_underlying = strategy
            .protocol_owed_underlying
            .checked_add(delta_underlying)
            .ok_or(error!(crate::errors::VaultError::MathOverflow))?;
        return Ok(());
    }

    let protocol_cut = (delta_underlying as u128)
        .checked_mul(strategy.protocol_yield_share_bps as u128)
        .ok_or(error!(crate::errors::VaultError::MathOverflow))?
        / 10_000u128;
    let protocol_cut =
        u64::try_from(protocol_cut).map_err(|_| error!(crate::errors::VaultError::MathOverflow))?;
    let user_cut = delta_underlying
        .checked_sub(protocol_cut)
        .ok_or(error!(crate::errors::VaultError::MathOverflow))?;

    if user_cut > 0 {
        let index_delta_q64 = (user_cut as u128)
            .checked_shl(64)
            .ok_or(error!(crate::errors::VaultError::MathOverflow))?
            / (strategy.total_user_shares as u128);
        strategy.user_index_q64 = strategy
            .user_index_q64
            .checked_add(index_delta_q64)
            .ok_or(error!(crate::errors::VaultError::MathOverflow))?;
    }
    if protocol_cut > 0 {
        strategy.protocol_owed_underlying = strategy
            .protocol_owed_underlying
            .checked_add(protocol_cut)
            .ok_or(error!(crate::errors::VaultError::MathOverflow))?;
    }
    Ok(())
}

/// Solvency invariant: `share_vault.balance * cUSDC_rate >= user_owed + protocol_owed`.
///
/// Caller passes `share_vault_underlying` = USDC equivalent of the protocol's cUSDC holdings as
/// of *now* (i.e. `share_vault.balance * total_underlying / share_supply` from mock-yield).
pub fn require_solvent(strategy: &YieldStrategy, share_vault_underlying: u64) -> Result<()> {
    let user_owed = strategy.user_underlying_owed()?;
    let total_owed = user_owed
        .checked_add(strategy.protocol_owed_underlying)
        .ok_or(error!(crate::errors::VaultError::MathOverflow))?;
    require!(
        share_vault_underlying >= total_owed,
        crate::errors::VaultError::SolvencyInvariantBroken
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_strategy() -> YieldStrategy {
        YieldStrategy {
            token_id: 1,
            bump: 255,
            share_vault_bump: 254,
            protocol_yield_share_bps: DEFAULT_PROTOCOL_YIELD_SHARE_BPS,
            underlying_mint: Pubkey::default(),
            yield_program: Pubkey::default(),
            reserve: Pubkey::default(),
            share_mint: Pubkey::default(),
            share_vault: Pubkey::default(),
            liquidity_vault: Pubkey::default(),
            user_index_q64: Q64_ONE,
            last_settled_underlying: 0,
            total_user_shares: 0,
            protocol_owed_underlying: 0,
            _reserved: [0u8; 64],
        }
    }

    #[test]
    fn shares_round_trip_at_unit_index() {
        let mut s = fresh_strategy();
        s.total_user_shares = 1_000_000;
        let shares = s.usdc_to_shares(1_000_000).unwrap();
        assert_eq!(shares, 1_000_000);
        let back = s.shares_to_usdc(shares).unwrap();
        assert_eq!(back, 1_000_000);
    }

    #[test]
    fn yield_attribution_splits_2pct_of_6pct_gross() {
        let mut s = fresh_strategy();
        s.total_user_shares = 1_000_000_000_000; // 1M USDC worth of shares at 1.0 index
        s.last_settled_underlying = 1_000_000_000_000;
        // 6% gross of 1M USDC = 60k USDC of yield over the year
        let gross_yield: u64 = 60_000_000_000;
        apply_yield_delta(&mut s, gross_yield).unwrap();
        // Protocol takes 33.33% of yield = 20k USDC
        assert!(s.protocol_owed_underlying >= 19_998_000_000);
        assert!(s.protocol_owed_underlying <= 20_002_000_000);
        // User cut = ~40k USDC raises index by ~4%
        let new_user_underlying = s.user_underlying_owed().unwrap();
        // User started at 1M, gained ~40k -> ~1.04M
        assert!(new_user_underlying >= 1_039_990_000_000);
        assert!(new_user_underlying <= 1_040_010_000_000);
    }

    #[test]
    fn yield_routed_to_protocol_when_no_users() {
        let mut s = fresh_strategy();
        s.last_settled_underlying = 1_000;
        apply_yield_delta(&mut s, 500).unwrap();
        assert_eq!(s.protocol_owed_underlying, 500);
        assert_eq!(s.user_index_q64, Q64_ONE);
    }
}
