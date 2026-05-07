import Lake
open Lake DSL

package RyvoWithdrawalsPilotProofs

require qedgenSupport from
  "./lean_solana"

@[default_target]
lean_lib RyvoWithdrawalsPilotSpec where
  roots := #[`Spec]
