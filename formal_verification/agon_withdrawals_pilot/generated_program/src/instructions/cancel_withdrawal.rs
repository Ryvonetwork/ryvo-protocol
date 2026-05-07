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
pub struct CancelWithdrawal {
    pub owner: Signer,
    #[account(mut)]
    pub participant_account: Account<()>,
}

impl CancelWithdrawal {
    #[qed(verified, spec = "../../../agon_withdrawals.qedspec", handler = "cancel_withdrawal", spec_hash = "55c2421171c39345")]
    #[inline(always)]
    pub fn handler(&mut self, token: u16) -> Result<(), ProgramError> {
        guards::cancel_withdrawal(self, token)?;
        self.participant_account.available_balance = self.participant_account.available_balance.checked_add(withdrawing_balance).ok_or(ErrorCode::MathOverflow)?;
        self.participant_account.withdrawing_balance = 0;
        self.participant_account.withdrawal_unlock_at = 0;
        Ok(())
    }
}
