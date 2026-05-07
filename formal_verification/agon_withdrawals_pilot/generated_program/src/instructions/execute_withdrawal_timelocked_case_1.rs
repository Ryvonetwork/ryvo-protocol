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
pub struct ExecuteWithdrawalTimelockedCase1 {
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

impl ExecuteWithdrawalTimelockedCase1 {
    #[qed(verified, spec = "../../../agon_withdrawals.qedspec", handler = "execute_withdrawal_timelocked_case_1", spec_hash = "")]
    #[inline(always)]
    pub fn handler(&mut self, token: u16) -> Result<(), ProgramError> {
        guards::execute_withdrawal_timelocked_case_1(self, token)?;
        self.participant_account.vault_balance = self.participant_account.vault_balance.checked_sub(withdrawing_balance).ok_or(ErrorCode::MathOverflow)?;
        // Spec effect (needs fill): fee_recipient_balance add (let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); fee)
        // Spec effect (needs fill): destination_balance add (let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); s.withdrawing_balance - fee)
        self.participant_account.withdrawing_balance = 0;
        self.participant_account.withdrawal_unlock_at = 0;
        todo!("fill non-mechanical effects, events, transfers, calls")
    }
}
