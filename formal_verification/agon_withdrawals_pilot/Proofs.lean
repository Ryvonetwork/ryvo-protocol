/-
Proofs.lean — user-owned preservation proofs.

`qedgen codegen` bootstraps this file once and never touches it again.
Spec.lean is regenerated; this file is durable. `qedgen check`
(and `qedgen reconcile`) flag orphan theorems (handler removed from
spec) and missing obligations (new `preserved_by` declared).
-/
import Spec

namespace AgonWithdrawalsPilot

open QEDGen.Solana

-- Preservation obligations the spec expects.
-- Write each theorem against the signature generated in Spec.lean
-- (the handler's transition + the property predicate). Close with
-- tactics like `unfold`, `omega`, or `simp_all` as appropriate, or
-- `QEDGen.Solana.IndexedState.forall_update_pres` for per-account
-- invariants in Map-backed specs.
--
--   theorem no_stale_timelock_preserved_by_cancel_withdrawal
--   theorem no_stale_timelock_preserved_by_deposit
--   theorem no_stale_timelock_preserved_by_execute_withdrawal_timelocked_case_0
--   theorem no_stale_timelock_preserved_by_execute_withdrawal_timelocked_case_1
--   theorem no_stale_timelock_preserved_by_execute_withdrawal_timelocked_otherwise
--   theorem no_stale_timelock_preserved_by_request_withdrawal
--   theorem onchain_token_conservation_preserved_by_cancel_withdrawal
--   theorem onchain_token_conservation_preserved_by_deposit
--   theorem onchain_token_conservation_preserved_by_execute_withdrawal_timelocked_case_0
--   theorem onchain_token_conservation_preserved_by_execute_withdrawal_timelocked_case_1
--   theorem onchain_token_conservation_preserved_by_execute_withdrawal_timelocked_otherwise
--   theorem onchain_token_conservation_preserved_by_request_withdrawal
--   theorem vault_backs_internal_claims_preserved_by_cancel_withdrawal
--   theorem vault_backs_internal_claims_preserved_by_deposit
--   theorem vault_backs_internal_claims_preserved_by_execute_withdrawal_timelocked_case_0
--   theorem vault_backs_internal_claims_preserved_by_execute_withdrawal_timelocked_case_1
--   theorem vault_backs_internal_claims_preserved_by_execute_withdrawal_timelocked_otherwise
--   theorem vault_backs_internal_claims_preserved_by_request_withdrawal

end AgonWithdrawalsPilot
