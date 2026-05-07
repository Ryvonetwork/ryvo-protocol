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
pub struct ExecuteWithdrawalTimelockedCase0 {
    #[account(mut)]
    pub participant_account: Account<()>,
    #[account(mut)]
    pub vault_token_account: Account<Token>,
    #[account(mut)]
    pub withdrawal_destination: Account<Token>,
    #[account(mut)]
    pub fee_recipient_token_account: Account<Token>,
    pub global_config: Account<()>,
    pub token_registry: Account<()>,
}

impl ExecuteWithdrawalTimelockedCase0 {
    #[qed(verified, spec = "../../../agon_withdrawals.qedspec", handler = "execute_withdrawal_timelocked_case_0", spec_hash = "")]
    #[inline(always)]
    pub fn handler(&mut self, token: u16) -> Result<(), ProgramError> {
        guards::execute_withdrawal_timelocked_case_0(self, token)?;
        self.participant_account.vault_balance = self.participant_account.vault_balance.checked_sub(withdrawing_balance).ok_or(ErrorCode::MathOverflow)?;
        self.participant_account.fee_recipient_balance = self.participant_account.fee_recipient_balance.checked_add(withdrawing_balance).ok_or(ErrorCode::MathOverflow)?;
        self.participant_account.withdrawing_balance = 0;
        self.participant_account.withdrawal_unlock_at = 0;
        Ok(())
    }
}
