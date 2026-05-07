use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

#[account]
pub struct GlobalConfig {
    /// Active config authority - can update fee_recipient, fee_bps, etc.
    /// Bootstrap starts with the program upgrade authority until any nominated authority accepts.
    pub authority: Pubkey, // 32
    /// Wallet that receives registration-fee lamports and owns per-token fee accounts.
    pub fee_recipient: Pubkey, // 32
    /// Withdrawal fee in basis points (default 30 = 0.3%)
    pub fee_bps: u16, //  2
    /// Seconds before a pending available-balance withdrawal becomes executable.
    pub withdrawal_timelock_seconds: i64, //  8
    /// Flat SOL fee at initialize_participant (default 0)
    pub registration_fee_lamports: u64, //  8
    /// Auto-incrementing participant ID counter
    pub next_participant_id: u32, //  4
    /// PDA bump
    pub bump: u8, //  1
    /// Protocol chain identifier used in signed message validation.
    pub chain_id: u16, // 2
    /// Immutable deployment-scoped domain used by signed settlement messages.
    pub message_domain: [u8; 16], // 16
    /// Pending authority that must explicitly accept before a handoff completes.
    pub pending_authority: Pubkey, // 32
    /// Seconds before a unilateral channel-collateral unlock becomes executable.
    pub channel_unlock_timelock_seconds: i64, // 8
    /// Reserved for future config expansion.
    pub _reserved: [u8; 6], // 6
}

impl GlobalConfig {
    /// Total account size including 8-byte Anchor discriminator.
    /// Layout: disc(8) + authority(32) + fee_recipient(32) + fee_bps(2) +
    /// withdrawal_timelock_seconds(8) + registration_fee_lamports(8) +
    /// next_participant_id(4) + bump(1) + chain_id(2) + message_domain(16) +
    /// pending_authority(32) + channel_unlock_timelock_seconds(8) + _reserved(6) = 159
    pub const SPACE: usize = 8 + 32 + 32 + 2 + 8 + 8 + 8 + 4 + 1 + 2 + 16 + 32 + 6; // = 159
    pub const SEED_PREFIX: &'static [u8] = b"global-config";
    pub const MESSAGE_DOMAIN_TAG: &'static [u8] = b"agon-message-domain-v1";

    /// Withdrawal fee: min 0.03%, max 0.3%
    pub const MIN_FEE_BPS: u16 = 3; // 0.03%
    pub const MAX_FEE_BPS: u16 = 30; // 0.3%

    /// Minimum withdrawal fee expressed in 6-decimal native units.
    pub const MIN_WITHDRAWAL_FEE_6DP: u64 = 50_000;

    /// Registration fee tiers: 0 (disabled) or 0.001-0.01 SOL
    pub const MIN_REGISTRATION_FEE_LAMPORTS: u64 = 1_000_000; // 0.001 SOL
    pub const MAX_REGISTRATION_FEE_LAMPORTS: u64 = 10_000_000; // 0.01 SOL

    /// Mainnet chain id.
    pub const MAINNET_CHAIN_ID: u16 = 0;
    /// Devnet chain id.
    pub const DEVNET_CHAIN_ID: u16 = 1;
    /// Testnet chain id.
    pub const TESTNET_CHAIN_ID: u16 = 2;
    /// Localnet chain id.
    pub const LOCALNET_CHAIN_ID: u16 = 3;

    /// Available-balance withdrawals are delay-free; credit risk lives with underwriters and reputation.
    pub const INSTANT_WITHDRAWAL_TIMELOCK_SECONDS: i64 = 0;
    /// Production unilateral channel unlock grace period.
    pub const CHANNEL_UNLOCK_TIMELOCK_SECONDS: i64 = 259_200; // 72 hours
    /// Localnet-only short channel unlock for tests and fast development cycles.
    pub const LOCALNET_CHANNEL_UNLOCK_TIMELOCK_SECONDS: i64 = 2;

    pub fn withdrawal_timelock_for_chain_id(chain_id: u16) -> Result<i64> {
        match chain_id {
            Self::MAINNET_CHAIN_ID
            | Self::DEVNET_CHAIN_ID
            | Self::TESTNET_CHAIN_ID
            | Self::LOCALNET_CHAIN_ID => Ok(Self::INSTANT_WITHDRAWAL_TIMELOCK_SECONDS),
            _ => Err(error!(crate::errors::VaultError::InvalidChainId)),
        }
    }

    pub fn channel_unlock_timelock_for_chain_id(chain_id: u16) -> Result<i64> {
        match chain_id {
            Self::LOCALNET_CHAIN_ID => Ok(Self::LOCALNET_CHANNEL_UNLOCK_TIMELOCK_SECONDS),
            Self::MAINNET_CHAIN_ID | Self::DEVNET_CHAIN_ID | Self::TESTNET_CHAIN_ID => {
                Ok(Self::CHANNEL_UNLOCK_TIMELOCK_SECONDS)
            }
            _ => Err(error!(crate::errors::VaultError::InvalidChainId)),
        }
    }

    pub fn effective_channel_unlock_timelock_seconds(&self) -> Result<i64> {
        if self.channel_unlock_timelock_seconds > 0 {
            return Ok(self.channel_unlock_timelock_seconds);
        }
        Self::channel_unlock_timelock_for_chain_id(self.chain_id)
    }

    pub fn derive_message_domain(program_id: &Pubkey, chain_id: u16) -> [u8; 16] {
        let digest = Sha256::digest(
            [
                Self::MESSAGE_DOMAIN_TAG,
                program_id.as_ref(),
                &chain_id.to_le_bytes(),
            ]
            .concat(),
        );
        let mut message_domain = [0u8; 16];
        message_domain.copy_from_slice(&digest[..16]);
        message_domain
    }

    pub fn has_pending_authority(&self) -> bool {
        self.pending_authority != Pubkey::default()
    }
}

#[cfg(test)]
mod tests {
    use super::GlobalConfig;
    use anchor_lang::prelude::Pubkey;

    #[test]
    fn mainnet_uses_instant_withdrawals_and_72h_channel_unlocks() {
        assert_eq!(
            GlobalConfig::channel_unlock_timelock_for_chain_id(GlobalConfig::MAINNET_CHAIN_ID)
                .unwrap(),
            GlobalConfig::CHANNEL_UNLOCK_TIMELOCK_SECONDS
        );
        assert_eq!(
            GlobalConfig::withdrawal_timelock_for_chain_id(GlobalConfig::MAINNET_CHAIN_ID).unwrap(),
            GlobalConfig::INSTANT_WITHDRAWAL_TIMELOCK_SECONDS
        );
    }

    #[test]
    fn devnet_uses_instant_withdrawals_and_72h_channel_unlocks() {
        assert_eq!(
            GlobalConfig::channel_unlock_timelock_for_chain_id(GlobalConfig::DEVNET_CHAIN_ID)
                .unwrap(),
            GlobalConfig::CHANNEL_UNLOCK_TIMELOCK_SECONDS
        );
        assert_eq!(
            GlobalConfig::withdrawal_timelock_for_chain_id(GlobalConfig::DEVNET_CHAIN_ID).unwrap(),
            GlobalConfig::INSTANT_WITHDRAWAL_TIMELOCK_SECONDS
        );
    }

    #[test]
    fn testnet_uses_72h_channel_unlocks() {
        assert_eq!(
            GlobalConfig::channel_unlock_timelock_for_chain_id(GlobalConfig::TESTNET_CHAIN_ID)
                .unwrap(),
            GlobalConfig::CHANNEL_UNLOCK_TIMELOCK_SECONDS
        );
    }

    #[test]
    fn timelock_for_localnet_chain_id_is_short() {
        assert_eq!(
            GlobalConfig::channel_unlock_timelock_for_chain_id(GlobalConfig::LOCALNET_CHAIN_ID)
                .unwrap(),
            GlobalConfig::LOCALNET_CHANNEL_UNLOCK_TIMELOCK_SECONDS
        );
    }

    #[test]
    fn timelock_rejects_unknown_chain_id() {
        assert!(GlobalConfig::withdrawal_timelock_for_chain_id(99).is_err());
        assert!(GlobalConfig::channel_unlock_timelock_for_chain_id(99).is_err());
    }

    #[test]
    fn effective_channel_unlock_timelock_falls_back_for_old_zero_configs() {
        let config = GlobalConfig {
            authority: Pubkey::default(),
            fee_recipient: Pubkey::default(),
            fee_bps: 0,
            withdrawal_timelock_seconds: 0,
            channel_unlock_timelock_seconds: 0,
            registration_fee_lamports: 0,
            next_participant_id: 0,
            bump: 0,
            chain_id: GlobalConfig::DEVNET_CHAIN_ID,
            message_domain: [0u8; 16],
            pending_authority: Pubkey::default(),
            _reserved: [0u8; 6],
        };

        assert_eq!(
            config.effective_channel_unlock_timelock_seconds().unwrap(),
            GlobalConfig::CHANNEL_UNLOCK_TIMELOCK_SECONDS
        );
    }

    #[test]
    fn derived_message_domain_is_stable_for_program_and_chain() {
        let program_id = Pubkey::new_unique();

        assert_eq!(
            GlobalConfig::derive_message_domain(&program_id, GlobalConfig::DEVNET_CHAIN_ID),
            GlobalConfig::derive_message_domain(&program_id, GlobalConfig::DEVNET_CHAIN_ID)
        );
    }

    #[test]
    fn derived_message_domain_changes_with_chain_id() {
        let program_id = Pubkey::new_unique();

        assert_ne!(
            GlobalConfig::derive_message_domain(&program_id, GlobalConfig::MAINNET_CHAIN_ID),
            GlobalConfig::derive_message_domain(&program_id, GlobalConfig::DEVNET_CHAIN_ID)
        );
        assert_ne!(
            GlobalConfig::derive_message_domain(&program_id, GlobalConfig::DEVNET_CHAIN_ID),
            GlobalConfig::derive_message_domain(&program_id, GlobalConfig::TESTNET_CHAIN_ID)
        );
        assert_ne!(
            GlobalConfig::derive_message_domain(&program_id, GlobalConfig::TESTNET_CHAIN_ID),
            GlobalConfig::derive_message_domain(&program_id, GlobalConfig::LOCALNET_CHAIN_ID)
        );
    }

    #[test]
    fn derived_message_domain_changes_with_program_id() {
        let chain_id = GlobalConfig::DEVNET_CHAIN_ID;

        assert_ne!(
            GlobalConfig::derive_message_domain(&Pubkey::new_unique(), chain_id),
            GlobalConfig::derive_message_domain(&Pubkey::new_unique(), chain_id)
        );
    }
}
