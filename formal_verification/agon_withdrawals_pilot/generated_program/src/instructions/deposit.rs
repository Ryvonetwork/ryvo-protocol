// User-owned. Regenerating the spec does NOT overwrite this file.
// Guard checks live in the sibling `crate::guards` module and ARE
// regenerated on every `qedgen codegen`. Drift between the spec
// handler block and the `spec_hash` below fires a compile_error!
// via the `#[qed(verified, ...)]` macro.

use anchor_lang::prelude::*;
use crate::state::*;
use crate::guards;
use qedgen_macros::qed;
use crate::errors::*;

#[derive(Accounts)]
pub struct Deposit {
    pub owner: Signer,
    #[account(mut)]
    pub participant_account: Account<()>,
    #[account(mut)]
    pub owner_token_account: Account<Token>,
    #[account(mut)]
    pub vault_token_account: Account<Token>,
    pub token_registry: Account<()>,
}

impl Deposit {
    #[qed(verified, spec = "../../../agon_withdrawals.qedspec", handler = "deposit", spec_hash = "25eb6c9892577afc")]
    #[inline(always)]
    pub fn handler(&mut self, token: u16, amount: u64) -> Result<(), ProgramError> {
        guards::deposit(self, token, amount)?;
        self.participant_account.wallet_balance = self.participant_account.wallet_balance.checked_sub(amount).ok_or(ErrorCode::MathOverflow)?;
        self.participant_account.vault_balance = self.participant_account.vault_balance.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        self.participant_account.available_balance = self.participant_account.available_balance.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        Ok(())
    }
}
