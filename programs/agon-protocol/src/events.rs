use anchor_lang::prelude::*;

#[event]
pub struct ParticipantInitialized {
    pub owner: Pubkey,
    pub participant_id: u32,
    pub registration_fee_lamports: u64,
    pub inbound_channel_policy: u8,
}

#[event]
pub struct ParticipantBlsKeyRegistered {
    pub owner: Pubkey,
    pub participant_id: u32,
    pub participant_bucket: Pubkey,
    pub scheme_version: u8,
}

#[event]
pub struct InboundChannelPolicyUpdated {
    pub participant_id: u32,
    pub inbound_channel_policy: u8,
}

#[event]
pub struct ChannelUnlockRequested {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub requested_amount: u64,
    pub unlock_at: i64,
}

#[event]
pub struct ChannelFundsUnlocked {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub released_amount: u64,
    pub remaining_locked: u64,
}

#[event]
pub struct ChannelAuthorizedSignerUpdateRequested {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub current_authorized_signer: Pubkey,
    pub pending_authorized_signer: Pubkey,
    pub activate_at: i64,
}

#[event]
pub struct ChannelAuthorizedSignerUpdated {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub previous_authorized_signer: Pubkey,
    pub new_authorized_signer: Pubkey,
}

#[event]
pub struct ChannelCreated {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
}

#[event]
pub struct ChannelFundsLocked {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub amount: u64,
    pub total_locked: u64,
}

#[event]
pub struct Deposited {
    pub participant_id: u32,
    pub token_id: u16,
    pub amount: u64,
}

#[event]
pub struct WithdrawalRequested {
    pub participant_id: u32,
    pub token_id: u16,
    pub amount: u64,
    pub destination: Pubkey,
    pub unlock_at: i64,
}

#[event]
pub struct WithdrawalCancelled {
    pub participant_id: u32,
    pub token_id: u16,
    pub amount_returned: u64,
}

#[event]
pub struct Withdrawn {
    pub participant_id: u32,
    pub token_id: u16,
    pub net_amount: u64,
    pub fee_amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct ConfigUpdated {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub chain_id: u16,
}

#[event]
pub struct ConfigAuthorityTransferStarted {
    pub current_authority: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct ConfigAuthorityTransferred {
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct RegistryAuthorityTransferStarted {
    pub current_authority: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct RegistryAuthorityTransferred {
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct IndividualSettled {
    pub payer_id: u32,
    pub payee_id: u32,
    pub token_id: u16,
    pub amount: u64,
    pub committed_amount: u64,
    pub from_locked: bool,
}

#[event]
pub struct CommitmentBundleSettled {
    pub payee_id: u32,
    pub token_id: u16,
    pub channel_count: u16,
    pub total: u64,
}

#[event]
pub struct ClearingRoundSettled {
    pub token_id: u16,
    pub participant_count: u16,
    pub channel_count: u16,
    pub total_gross: u64,
    pub total_net_adjusted: u64,
}
