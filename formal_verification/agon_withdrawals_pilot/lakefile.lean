import Lake
open Lake DSL

package AgonWithdrawalsPilotProofs

require qedgenSupport from
  "./lean_solana"

@[default_target]
lean_lib AgonWithdrawalsPilotSpec where
  roots := #[`Spec]
