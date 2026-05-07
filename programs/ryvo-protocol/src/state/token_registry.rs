use anchor_lang::prelude::*;

use crate::errors::VaultError;

#[account]
pub struct TokenRegistry {
    /// Registry authority - can register new tokens
    pub authority: Pubkey, // 32
    /// Array of registered token entries stored inside a fixed-size account.
    pub tokens: Vec<TokenEntry>,
    /// PDA bump
    pub bump: u8, // 1
    /// Pending authority that must explicitly accept before a handoff completes.
    pub pending_authority: Pubkey, // 32
}

/// `kind = 0`: plain SPL deposit/withdrawal flow (legacy, currently unused in v6).
/// `kind = 1`: yield-bearing wrapper. Balances are interpreted as protocol-internal shares
///            (e.g. ryUSDC). A separate `YieldStrategy` PDA tracks the share -> underlying
///            exchange rate and protocol fee accrual. `mint` is a marker label only — there is
///            no on-chain SPL mint for the wrapper, so `mint == Pubkey::default()` is allowed
///            and `decimals` mirrors the underlying.
pub const TOKEN_KIND_PLAIN: u8 = 0;
pub const TOKEN_KIND_YIELD_BEARING: u8 = 1;

/// Token registry entry
/// Total: 56 bytes per entry (was 51 in v5; +1 for `kind`, +4 reserved for future fields).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TokenEntry {
    /// Unique 2-byte token identifier (0-65,535)
    pub id: u16, // 2
    /// SPL token mint address (or `Pubkey::default()` for yield-bearing wrapper tokens
    /// that have no separate mint).
    pub mint: Pubkey, // 32
    /// Token decimals for amount validation. For yield-bearing wrappers this matches the
    /// underlying so balance display / commitment math stays uniform.
    pub decimals: u8, // 1
    /// ASCII symbol (e.g., "TOK1", "TOK2") - null-terminated
    pub symbol: [u8; 8], // 8
    /// Unix timestamp when token was registered (immutable)
    pub registered_at: i64, // 8
    /// `0 = Plain`, `1 = YieldBearing` (see TOKEN_KIND_* consts).
    pub kind: u8, // 1
    /// Reserved padding for future fields (do not change the size — accounts are pre-allocated).
    pub _reserved: [u8; 4], // 4
}

impl TokenEntry {
    pub const SPACE: usize = 56;

    pub fn is_yield_bearing(&self) -> bool {
        self.kind == TOKEN_KIND_YIELD_BEARING
    }

    pub fn is_plain(&self) -> bool {
        self.kind == TOKEN_KIND_PLAIN
    }
}

impl TokenRegistry {
    pub const SEED_PREFIX: &'static [u8] = b"token-registry";
    /// Maximum decimals Ryvo will allowlist for a token.
    /// This keeps fee scaling in `execute_withdrawal_timelocked` inside `u64`.
    pub const MAX_TOKEN_DECIMALS: u8 = 20;

    /// Fixed account overhead: discriminator + authority + vec length + bump + pending_authority.
    pub const BASE_SPACE: usize = 8 + 32 + 4 + 1 + 32;

    /// Maximum tokens supported in a single registry account while staying within Solana's
    /// CPI account-init allocation limit (~10 KiB). With 56-byte entries:
    ///   77 + 181 * 56 = 10213 < 10240
    pub const MAX_TOKENS: usize = 181;
    pub const SPACE: usize = Self::BASE_SPACE + (Self::MAX_TOKENS * TokenEntry::SPACE);

    pub fn required_space(token_count: usize) -> Result<usize> {
        let entries_space = token_count
            .checked_mul(TokenEntry::SPACE)
            .ok_or(error!(VaultError::MathOverflow))?;
        Self::BASE_SPACE
            .checked_add(entries_space)
            .ok_or(error!(VaultError::MathOverflow))
    }

    /// Find token entry by ID
    pub fn find_token(&self, token_id: u16) -> Option<&TokenEntry> {
        self.tokens.iter().find(|token| token.id == token_id)
    }

    /// Check if token ID is already registered
    pub fn is_token_registered(&self, token_id: u16) -> bool {
        self.find_token(token_id).is_some()
    }

    /// Check if mint address is already registered (prevent duplicates)
    pub fn is_mint_registered(&self, mint: &Pubkey) -> bool {
        self.tokens.iter().any(|token| token.mint == *mint)
    }

    /// Get token entry by mint address
    pub fn find_token_by_mint(&self, mint: &Pubkey) -> Option<&TokenEntry> {
        self.tokens.iter().find(|token| token.mint == *mint)
    }

    pub fn has_pending_authority(&self) -> bool {
        self.pending_authority != Pubkey::default()
    }
}
