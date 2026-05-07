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
pub struct RequestWithdrawal {
    pub owner: Signer,
    #[account(mut)]
    pub participant_account: Account<()>,
    #[account(mut)]
    pub withdrawal_destination: Account<Token>,
    pub global_config: Account<()>,
    pub token_registry: Account<()>,
}

impl RequestWithdrawal {
    #[qed(verified, spec = "../../../agon_withdrawals.qedspec", handler = "request_withdrawal", spec_hash = "addab8e16636aabe")]
    #[inline(always)]
    pub fn handler(&mut self, token: u16, amount: u64, destination: Address) -> Result<(), ProgramError> {
        guards::request_withdrawal(self, token, amount, destination)?;
        self.participant_account.available_balance = self.participant_account.available_balance.checked_sub(amount).ok_or(ErrorCode::MathOverflow)?;
        self.participant_account.withdrawing_balance = self.participant_account.withdrawing_balance.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        // Spec effect (needs fill): withdrawal_unlock_at set s.now + s.configured_timelock
        todo!("fill non-mechanical effects, events, transfers, calls")
    }
}
