import QEDGen.Solana.Account
import QEDGen.Solana.Cpi
import QEDGen.Solana.State
import QEDGen.Solana.Valid

namespace AgonWithdrawalsPilot

open QEDGen.Solana

inductive Status where
  | Active
  deriving Repr, DecidableEq, BEq

structure State where
  owner : Pubkey
  wallet_balance : Nat
  destination_balance : Nat
  vault_balance : Nat
  fee_recipient_balance : Nat
  available_balance : Nat
  withdrawing_balance : Nat
  withdrawal_unlock_at : Nat
  configured_timelock : Nat
  configured_fee_bps : Nat
  min_fee_native_units : Nat
  token_id : Nat
  token_decimals : Nat
  token_registered : Bool
  now : Nat
  physical_tokens_total : Nat
  status : Status
  deriving Repr, DecidableEq, BEq

def depositTransition (s : State) (signer : Pubkey) (token : Nat) (amount : Nat) : Option State :=
  if signer = s.owner ∧ s.status = .Active ∧ token = s.token_id ∧ s.token_registered ∧ amount > 0 ∧ s.wallet_balance ≥ amount ∧ s.vault_balance + amount ≤ 18446744073709551615 ∧ s.available_balance + amount ≤ 18446744073709551615 then
    some { s with wallet_balance := s.wallet_balance - amount, vault_balance := s.vault_balance + amount, available_balance := s.available_balance + amount, status := .Active }
  else none

def request_withdrawalTransition (s : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey) : Option State :=
  if signer = s.owner ∧ s.status = .Active ∧ token = s.token_id ∧ s.token_registered ∧ amount > 0 ∧ s.available_balance ≥ amount ∧ s.withdrawing_balance = 0 ∧ s.now + s.configured_timelock ≤ 18446744073709551615 ∧ s.withdrawing_balance + amount ≤ 18446744073709551615 then
    some { s with available_balance := s.available_balance - amount, withdrawing_balance := s.withdrawing_balance + amount, withdrawal_unlock_at := s.now + s.configured_timelock, status := .Active }
  else none

def cancel_withdrawalTransition (s : State) (signer : Pubkey) (token : Nat) : Option State :=
  if signer = s.owner ∧ s.status = .Active ∧ token = s.token_id ∧ s.withdrawing_balance > 0 ∧ s.available_balance + s.withdrawing_balance ≤ 18446744073709551615 then
    some { s with available_balance := s.available_balance + s.withdrawing_balance, withdrawing_balance := 0, withdrawal_unlock_at := 0, status := .Active }
  else none

def execute_withdrawal_timelocked_case_0Transition (s : State) (signer : Pubkey) (token : Nat) : Option State :=
  if s.status = .Active ∧ token = s.token_id ∧ s.token_registered ∧ s.token_decimals ≤ 20 ∧ s.withdrawing_balance > 0 ∧ s.now ≥ s.withdrawal_unlock_at ∧ s.vault_balance ≥ s.withdrawing_balance ∧ s.configured_fee_bps = 0 ∧ s.min_fee_native_units > 0 ∧ s.fee_recipient_balance + s.withdrawing_balance ≤ 18446744073709551615 ∧ s.fee_recipient_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); fee)) ≤ 18446744073709551615 ∧ s.destination_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); s.withdrawing_balance - fee)) ≤ 18446744073709551615 ∧ s.fee_recipient_balance + s.min_fee_native_units ≤ 18446744073709551615 ∧ s.destination_balance + s.withdrawing_balance - s.min_fee_native_units ≤ 18446744073709551615 ∧ s.withdrawing_balance ≤ s.min_fee_native_units then
    some { s with vault_balance := s.vault_balance - s.withdrawing_balance, fee_recipient_balance := s.fee_recipient_balance + s.withdrawing_balance, withdrawing_balance := 0, withdrawal_unlock_at := 0, status := .Active }
  else none

def execute_withdrawal_timelocked_case_1Transition (s : State) (signer : Pubkey) (token : Nat) : Option State :=
  if s.status = .Active ∧ token = s.token_id ∧ s.token_registered ∧ s.token_decimals ≤ 20 ∧ s.withdrawing_balance > 0 ∧ s.now ≥ s.withdrawal_unlock_at ∧ s.vault_balance ≥ s.withdrawing_balance ∧ s.configured_fee_bps = 0 ∧ s.min_fee_native_units > 0 ∧ s.fee_recipient_balance + s.withdrawing_balance ≤ 18446744073709551615 ∧ s.fee_recipient_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); fee)) ≤ 18446744073709551615 ∧ s.destination_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); s.withdrawing_balance - fee)) ≤ 18446744073709551615 ∧ s.fee_recipient_balance + s.min_fee_native_units ≤ 18446744073709551615 ∧ s.destination_balance + s.withdrawing_balance - s.min_fee_native_units ≤ 18446744073709551615 ∧ ¬(s.withdrawing_balance ≤ s.min_fee_native_units) ∧ (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)) ≥ s.min_fee_native_units then
    some { s with vault_balance := s.vault_balance - s.withdrawing_balance, fee_recipient_balance := (let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); s.fee_recipient_balance + fee), destination_balance := (let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); s.destination_balance + s.withdrawing_balance - fee), withdrawing_balance := 0, withdrawal_unlock_at := 0, status := .Active }
  else none

def execute_withdrawal_timelocked_otherwiseTransition (s : State) (signer : Pubkey) (token : Nat) : Option State :=
  if s.status = .Active ∧ token = s.token_id ∧ s.token_registered ∧ s.token_decimals ≤ 20 ∧ s.withdrawing_balance > 0 ∧ s.now ≥ s.withdrawal_unlock_at ∧ s.vault_balance ≥ s.withdrawing_balance ∧ s.configured_fee_bps = 0 ∧ s.min_fee_native_units > 0 ∧ s.fee_recipient_balance + s.withdrawing_balance ≤ 18446744073709551615 ∧ s.fee_recipient_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); fee)) ≤ 18446744073709551615 ∧ s.destination_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); s.withdrawing_balance - fee)) ≤ 18446744073709551615 ∧ s.fee_recipient_balance + s.min_fee_native_units ≤ 18446744073709551615 ∧ s.destination_balance + s.withdrawing_balance - s.min_fee_native_units ≤ 18446744073709551615 ∧ ¬(s.withdrawing_balance ≤ s.min_fee_native_units) ∧ ¬((((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)) ≥ s.min_fee_native_units) then
    some { s with vault_balance := s.vault_balance - s.withdrawing_balance, fee_recipient_balance := s.fee_recipient_balance + s.min_fee_native_units, destination_balance := s.destination_balance + s.withdrawing_balance - s.min_fee_native_units, withdrawing_balance := 0, withdrawal_unlock_at := 0, status := .Active }
  else none

inductive Operation where
  | deposit (token : Nat) (amount : Nat)
  | request_withdrawal (token : Nat) (amount : Nat) (destination : Pubkey)
  | cancel_withdrawal (token : Nat)
  | execute_withdrawal_timelocked_case_0 (token : Nat)
  | execute_withdrawal_timelocked_case_1 (token : Nat)
  | execute_withdrawal_timelocked_otherwise (token : Nat)
  deriving Repr, DecidableEq, BEq

def applyOp (s : State) (signer : Pubkey) : Operation → Option State
  | .deposit token amount => depositTransition s signer token amount
  | .request_withdrawal token amount destination => request_withdrawalTransition s signer token amount destination
  | .cancel_withdrawal token => cancel_withdrawalTransition s signer token
  | .execute_withdrawal_timelocked_case_0 token => execute_withdrawal_timelocked_case_0Transition s signer token
  | .execute_withdrawal_timelocked_case_1 token => execute_withdrawal_timelocked_case_1Transition s signer token
  | .execute_withdrawal_timelocked_otherwise token => execute_withdrawal_timelocked_otherwiseTransition s signer token

def vault_backs_internal_claims (s : State) : Prop := s.available_balance + s.withdrawing_balance ≤ s.vault_balance

theorem vault_backs_internal_claims_preserved_by_deposit (s s' : State) (signer : Pubkey) (token : Nat) (amount : Nat)
    (h_inv : vault_backs_internal_claims s) (h : depositTransition s signer token amount = some s') :
    vault_backs_internal_claims s' := by
  unfold depositTransition at h; split at h
  · next hg => cases h; unfold vault_backs_internal_claims at h_inv ⊢; dsimp; omega
  · contradiction

theorem vault_backs_internal_claims_preserved_by_request_withdrawal (s s' : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h_inv : vault_backs_internal_claims s) (h : request_withdrawalTransition s signer token amount destination = some s') :
    vault_backs_internal_claims s' := by
  unfold request_withdrawalTransition at h; split at h
  · next hg => cases h; unfold vault_backs_internal_claims at h_inv ⊢; dsimp; omega
  · contradiction

theorem vault_backs_internal_claims_preserved_by_cancel_withdrawal (s s' : State) (signer : Pubkey) (token : Nat)
    (h_inv : vault_backs_internal_claims s) (h : cancel_withdrawalTransition s signer token = some s') :
    vault_backs_internal_claims s' := by
  unfold cancel_withdrawalTransition at h; split at h
  · next hg => cases h; unfold vault_backs_internal_claims at h_inv ⊢; dsimp; omega
  · contradiction

theorem vault_backs_internal_claims_preserved_by_execute_withdrawal_timelocked_case_0 (s s' : State) (signer : Pubkey) (token : Nat)
    (h_inv : vault_backs_internal_claims s) (h : execute_withdrawal_timelocked_case_0Transition s signer token = some s') :
    vault_backs_internal_claims s' := by
  unfold execute_withdrawal_timelocked_case_0Transition at h; split at h
  · next hg => cases h; unfold vault_backs_internal_claims at h_inv ⊢; dsimp; omega
  · contradiction

theorem vault_backs_internal_claims_preserved_by_execute_withdrawal_timelocked_case_1 (s s' : State) (signer : Pubkey) (token : Nat)
    (h_inv : vault_backs_internal_claims s) (h : execute_withdrawal_timelocked_case_1Transition s signer token = some s') :
    vault_backs_internal_claims s' := by
  unfold execute_withdrawal_timelocked_case_1Transition at h; split at h
  · next hg => cases h; unfold vault_backs_internal_claims at h_inv ⊢; dsimp; omega
  · contradiction

theorem vault_backs_internal_claims_preserved_by_execute_withdrawal_timelocked_otherwise (s s' : State) (signer : Pubkey) (token : Nat)
    (h_inv : vault_backs_internal_claims s) (h : execute_withdrawal_timelocked_otherwiseTransition s signer token = some s') :
    vault_backs_internal_claims s' := by
  unfold execute_withdrawal_timelocked_otherwiseTransition at h; split at h
  · next hg => cases h; unfold vault_backs_internal_claims at h_inv ⊢; dsimp; omega
  · contradiction

/-- vault_backs_internal_claims is preserved by every operation. Auto-proven by case split. -/
theorem vault_backs_internal_claims_inductive (s s' : State) (signer : Pubkey) (op : Operation)
    (h_inv : vault_backs_internal_claims s) (h : applyOp s signer op = some s') : vault_backs_internal_claims s' := by
  cases op with
  | deposit token amount => exact vault_backs_internal_claims_preserved_by_deposit s s' signer token amount h_inv h
  | request_withdrawal token amount destination => exact vault_backs_internal_claims_preserved_by_request_withdrawal s s' signer token amount destination h_inv h
  | cancel_withdrawal token => exact vault_backs_internal_claims_preserved_by_cancel_withdrawal s s' signer token h_inv h
  | execute_withdrawal_timelocked_case_0 token => exact vault_backs_internal_claims_preserved_by_execute_withdrawal_timelocked_case_0 s s' signer token h_inv h
  | execute_withdrawal_timelocked_case_1 token => exact vault_backs_internal_claims_preserved_by_execute_withdrawal_timelocked_case_1 s s' signer token h_inv h
  | execute_withdrawal_timelocked_otherwise token => exact vault_backs_internal_claims_preserved_by_execute_withdrawal_timelocked_otherwise s s' signer token h_inv h

def no_stale_timelock (s : State) : Prop := s.withdrawing_balance = 0 → s.withdrawal_unlock_at = 0

theorem no_stale_timelock_preserved_by_deposit (s s' : State) (signer : Pubkey) (token : Nat) (amount : Nat)
    (h_inv : no_stale_timelock s) (h : depositTransition s signer token amount = some s') :
    no_stale_timelock s' := by
  unfold depositTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem no_stale_timelock_preserved_by_request_withdrawal (s s' : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h_inv : no_stale_timelock s) (h : request_withdrawalTransition s signer token amount destination = some s') :
    no_stale_timelock s' := by
  unfold request_withdrawalTransition at h; split at h
  · next hg => cases h; unfold no_stale_timelock at h_inv ⊢; dsimp; omega
  · contradiction

theorem no_stale_timelock_preserved_by_cancel_withdrawal (s s' : State) (signer : Pubkey) (token : Nat)
    (h_inv : no_stale_timelock s) (h : cancel_withdrawalTransition s signer token = some s') :
    no_stale_timelock s' := by
  unfold cancel_withdrawalTransition at h; split at h
  · next hg => cases h; unfold no_stale_timelock at h_inv ⊢; dsimp; omega
  · contradiction

theorem no_stale_timelock_preserved_by_execute_withdrawal_timelocked_case_0 (s s' : State) (signer : Pubkey) (token : Nat)
    (h_inv : no_stale_timelock s) (h : execute_withdrawal_timelocked_case_0Transition s signer token = some s') :
    no_stale_timelock s' := by
  unfold execute_withdrawal_timelocked_case_0Transition at h; split at h
  · next hg => cases h; unfold no_stale_timelock at h_inv ⊢; dsimp; omega
  · contradiction

theorem no_stale_timelock_preserved_by_execute_withdrawal_timelocked_case_1 (s s' : State) (signer : Pubkey) (token : Nat)
    (h_inv : no_stale_timelock s) (h : execute_withdrawal_timelocked_case_1Transition s signer token = some s') :
    no_stale_timelock s' := by
  unfold execute_withdrawal_timelocked_case_1Transition at h; split at h
  · next hg => cases h; unfold no_stale_timelock at h_inv ⊢; dsimp; omega
  · contradiction

theorem no_stale_timelock_preserved_by_execute_withdrawal_timelocked_otherwise (s s' : State) (signer : Pubkey) (token : Nat)
    (h_inv : no_stale_timelock s) (h : execute_withdrawal_timelocked_otherwiseTransition s signer token = some s') :
    no_stale_timelock s' := by
  unfold execute_withdrawal_timelocked_otherwiseTransition at h; split at h
  · next hg => cases h; unfold no_stale_timelock at h_inv ⊢; dsimp; omega
  · contradiction

/-- no_stale_timelock is preserved by every operation. Auto-proven by case split. -/
theorem no_stale_timelock_inductive (s s' : State) (signer : Pubkey) (op : Operation)
    (h_inv : no_stale_timelock s) (h : applyOp s signer op = some s') : no_stale_timelock s' := by
  cases op with
  | deposit token amount => exact no_stale_timelock_preserved_by_deposit s s' signer token amount h_inv h
  | request_withdrawal token amount destination => exact no_stale_timelock_preserved_by_request_withdrawal s s' signer token amount destination h_inv h
  | cancel_withdrawal token => exact no_stale_timelock_preserved_by_cancel_withdrawal s s' signer token h_inv h
  | execute_withdrawal_timelocked_case_0 token => exact no_stale_timelock_preserved_by_execute_withdrawal_timelocked_case_0 s s' signer token h_inv h
  | execute_withdrawal_timelocked_case_1 token => exact no_stale_timelock_preserved_by_execute_withdrawal_timelocked_case_1 s s' signer token h_inv h
  | execute_withdrawal_timelocked_otherwise token => exact no_stale_timelock_preserved_by_execute_withdrawal_timelocked_otherwise s s' signer token h_inv h

-- ============================================================================
-- Abort conditions — operations must reject under specified conditions
-- ============================================================================

theorem deposit_aborts_if_TokenNotFound_0 (s : State) (signer : Pubkey) (token : Nat) (amount : Nat)
    (h : ¬(token = s.token_id)) : depositTransition s signer token amount = none := by
  unfold depositTransition
  rw [if_neg (fun hg => h hg.2.2.1)]

theorem deposit_aborts_if_TokenNotFound_1 (s : State) (signer : Pubkey) (token : Nat) (amount : Nat)
    (h : ¬(s.token_registered)) : depositTransition s signer token amount = none := by
  unfold depositTransition
  rw [if_neg (fun hg => h hg.2.2.2.1)]

theorem deposit_aborts_if_AmountMustBePositive (s : State) (signer : Pubkey) (token : Nat) (amount : Nat)
    (h : ¬(amount > 0)) : depositTransition s signer token amount = none := by
  unfold depositTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.1)]

theorem deposit_aborts_if_InsufficientBalance (s : State) (signer : Pubkey) (token : Nat) (amount : Nat)
    (h : ¬(s.wallet_balance ≥ amount)) : depositTransition s signer token amount = none := by
  unfold depositTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.1)]

theorem deposit_aborts_if_MathOverflow_0 (s : State) (signer : Pubkey) (token : Nat) (amount : Nat)
    (h : ¬(s.vault_balance + amount ≤ 18446744073709551615)) : depositTransition s signer token amount = none := by
  unfold depositTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.1)]

theorem deposit_aborts_if_MathOverflow_1 (s : State) (signer : Pubkey) (token : Nat) (amount : Nat)
    (h : ¬(s.available_balance + amount ≤ 18446744073709551615)) : depositTransition s signer token amount = none := by
  unfold depositTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2)]

theorem request_withdrawal_aborts_if_TokenNotFound_0 (s : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h : ¬(token = s.token_id)) : request_withdrawalTransition s signer token amount destination = none := by
  unfold request_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.1)]

theorem request_withdrawal_aborts_if_TokenNotFound_1 (s : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h : ¬(s.token_registered)) : request_withdrawalTransition s signer token amount destination = none := by
  unfold request_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.2.1)]

theorem request_withdrawal_aborts_if_AmountMustBePositive (s : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h : ¬(amount > 0)) : request_withdrawalTransition s signer token amount destination = none := by
  unfold request_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.1)]

theorem request_withdrawal_aborts_if_InsufficientBalance (s : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h : ¬(s.available_balance ≥ amount)) : request_withdrawalTransition s signer token amount destination = none := by
  unfold request_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.1)]

theorem request_withdrawal_aborts_if_WithdrawalAlreadyPending (s : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h : ¬(s.withdrawing_balance = 0)) : request_withdrawalTransition s signer token amount destination = none := by
  unfold request_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.1)]

theorem request_withdrawal_aborts_if_MathOverflow_0 (s : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h : ¬(s.now + s.configured_timelock ≤ 18446744073709551615)) : request_withdrawalTransition s signer token amount destination = none := by
  unfold request_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.1)]

theorem request_withdrawal_aborts_if_MathOverflow_1 (s : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h : ¬(s.withdrawing_balance + amount ≤ 18446744073709551615)) : request_withdrawalTransition s signer token amount destination = none := by
  unfold request_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2)]

theorem cancel_withdrawal_aborts_if_TokenNotFound (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(token = s.token_id)) : cancel_withdrawalTransition s signer token = none := by
  unfold cancel_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.1)]

theorem cancel_withdrawal_aborts_if_NoWithdrawalPending (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.withdrawing_balance > 0)) : cancel_withdrawalTransition s signer token = none := by
  unfold cancel_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.2.1)]

theorem cancel_withdrawal_aborts_if_MathOverflow (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.available_balance + s.withdrawing_balance ≤ 18446744073709551615)) : cancel_withdrawalTransition s signer token = none := by
  unfold cancel_withdrawalTransition
  rw [if_neg (fun hg => h hg.2.2.2.2)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_TokenNotFound_0 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(token = s.token_id)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_TokenNotFound_1 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.token_registered)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_InvalidTokenDecimals (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.token_decimals ≤ 20)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_NoWithdrawalPending (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.withdrawing_balance > 0)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_WithdrawalLocked (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.now ≥ s.withdrawal_unlock_at)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_InsufficientBalance (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.vault_balance ≥ s.withdrawing_balance)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_MathOverflow_0 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.configured_fee_bps = 0)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_MathOverflow_1 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.min_fee_native_units > 0)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_MathOverflow_2 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.fee_recipient_balance + s.withdrawing_balance ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_MathOverflow_3 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.fee_recipient_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); fee)) ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_MathOverflow_4 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.destination_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); s.withdrawing_balance - fee)) ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_MathOverflow_5 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.fee_recipient_balance + s.min_fee_native_units ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_0_aborts_if_MathOverflow_6 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.destination_balance + s.withdrawing_balance - s.min_fee_native_units ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_0Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_0Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_TokenNotFound_0 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(token = s.token_id)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_TokenNotFound_1 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.token_registered)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_InvalidTokenDecimals (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.token_decimals ≤ 20)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_NoWithdrawalPending (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.withdrawing_balance > 0)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_WithdrawalLocked (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.now ≥ s.withdrawal_unlock_at)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_InsufficientBalance (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.vault_balance ≥ s.withdrawing_balance)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_MathOverflow_0 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.configured_fee_bps = 0)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_MathOverflow_1 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.min_fee_native_units > 0)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_MathOverflow_2 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.fee_recipient_balance + s.withdrawing_balance ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_MathOverflow_3 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.fee_recipient_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); fee)) ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_MathOverflow_4 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.destination_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); s.withdrawing_balance - fee)) ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_MathOverflow_5 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.fee_recipient_balance + s.min_fee_native_units ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_case_1_aborts_if_MathOverflow_6 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.destination_balance + s.withdrawing_balance - s.min_fee_native_units ≤ 18446744073709551615)) : execute_withdrawal_timelocked_case_1Transition s signer token = none := by
  unfold execute_withdrawal_timelocked_case_1Transition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_TokenNotFound_0 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(token = s.token_id)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_TokenNotFound_1 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.token_registered)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_InvalidTokenDecimals (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.token_decimals ≤ 20)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_NoWithdrawalPending (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.withdrawing_balance > 0)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_WithdrawalLocked (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.now ≥ s.withdrawal_unlock_at)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_InsufficientBalance (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.vault_balance ≥ s.withdrawing_balance)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_MathOverflow_0 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.configured_fee_bps = 0)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_MathOverflow_1 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.min_fee_native_units > 0)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_MathOverflow_2 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.fee_recipient_balance + s.withdrawing_balance ≤ 18446744073709551615)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_MathOverflow_3 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.fee_recipient_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); fee)) ≤ 18446744073709551615)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_MathOverflow_4 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.destination_balance + ((let fee := (((s.withdrawing_balance) * (s.configured_fee_bps)) / (10000)); s.withdrawing_balance - fee)) ≤ 18446744073709551615)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_MathOverflow_5 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.fee_recipient_balance + s.min_fee_native_units ≤ 18446744073709551615)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.2.2.1)]

theorem execute_withdrawal_timelocked_otherwise_aborts_if_MathOverflow_6 (s : State) (signer : Pubkey) (token : Nat)
    (h : ¬(s.destination_balance + s.withdrawing_balance - s.min_fee_native_units ≤ 18446744073709551615)) : execute_withdrawal_timelocked_otherwiseTransition s signer token = none := by
  unfold execute_withdrawal_timelocked_otherwiseTransition
  rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2.2.2.2.2.2.1)]

-- ============================================================================
-- Post-conditions (ensures)
-- ============================================================================

theorem request_withdrawal_ensures_0 (s s' : State) (signer : Pubkey) (token : Nat) (amount : Nat) (destination : Pubkey)
    (h : request_withdrawalTransition s signer token amount destination = some s') :
    s'.available_balance + s'.withdrawing_balance = s.available_balance + s.withdrawing_balance := by
  unfold request_withdrawalTransition at h
  split at h
  · next hg =>
    cases h
    dsimp
    omega
  · contradiction

theorem cancel_withdrawal_ensures_0 (s s' : State) (signer : Pubkey) (token : Nat)
    (h : cancel_withdrawalTransition s signer token = some s') :
    s'.available_balance + s'.withdrawing_balance = s.available_balance + s.withdrawing_balance := by
  unfold cancel_withdrawalTransition at h
  split at h
  · next hg =>
    cases h
    dsimp
  · contradiction

end AgonWithdrawalsPilot
