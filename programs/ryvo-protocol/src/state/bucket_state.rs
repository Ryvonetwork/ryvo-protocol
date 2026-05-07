use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::AccountInfo;
use sha2::{Digest, Sha256};

use crate::bls::BLS_PUBLIC_KEY_COMPRESSED_SIZE;
use crate::errors::VaultError;

pub const PARTICIPANT_BUCKET_SLOT_COUNT: usize = 9;
pub const CHANNEL_BUCKET_SLOT_COUNT: usize = 46;
pub const OWNER_INDEX_BUCKET_SLOT_COUNT: usize = 32;
pub const OWNER_INDEX_BUCKET_COUNT: u32 = 1024;
pub const MAX_BUCKET_TOKEN_BALANCES: usize = 16;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct DirectionalLaneState {
    pub initialized: bool,
    pub settled_cumulative: u64,
    pub locked_balance: u64,
    pub authorized_signer: Pubkey,
    pub pending_unlock_amount: u64,
    pub unlock_requested_at: i64,
    pub pending_authorized_signer: Pubkey,
    pub authorized_signer_update_requested_at: i64,
}

impl DirectionalLaneState {
    pub const SPACE: usize = 1 + 8 + 8 + 32 + 8 + 8 + 32 + 8;

    pub fn uninitialized() -> Self {
        Self {
            initialized: false,
            settled_cumulative: 0,
            locked_balance: 0,
            authorized_signer: Pubkey::default(),
            pending_unlock_amount: 0,
            unlock_requested_at: 0,
            pending_authorized_signer: Pubkey::default(),
            authorized_signer_update_requested_at: 0,
        }
    }

    pub fn has_pending_unlock(&self) -> bool {
        self.pending_unlock_amount > 0 && self.unlock_requested_at != 0
    }

    pub fn has_pending_authorized_signer_update(&self) -> bool {
        self.pending_authorized_signer != Pubkey::default()
            && self.authorized_signer_update_requested_at != 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaneSelector {
    LowerToHigher,
    HigherToLower,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaneCore {
    pub initialized: bool,
    pub settled_cumulative: u64,
    pub locked_balance: u64,
    pub authorized_signer: Pubkey,
    pub pending_unlock_amount: u64,
    pub unlock_requested_at: i64,
    pub pending_authorized_signer: Pubkey,
    pub authorized_signer_update_requested_at: i64,
}

impl LaneCore {
    pub fn has_pending_unlock(&self) -> bool {
        self.pending_unlock_amount > 0 && self.unlock_requested_at != 0
    }

    pub fn has_pending_authorized_signer_update(&self) -> bool {
        self.pending_authorized_signer != Pubkey::default()
            && self.authorized_signer_update_requested_at != 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelLaneSettlementSnapshot {
    pub lane_offset: usize,
    pub settled_cumulative: u64,
    pub locked_balance: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelLaneCommitmentSnapshot {
    pub lane_offset: usize,
    pub settled_cumulative: u64,
    pub locked_balance: u64,
    pub authorized_signer: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum InboundChannelPolicy {
    Permissionless,
    ConsentRequired,
    Disabled,
}

impl TryFrom<u8> for InboundChannelPolicy {
    type Error = anchor_lang::error::Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(Self::Permissionless),
            1 => Ok(Self::ConsentRequired),
            2 => Ok(Self::Disabled),
            _ => Err(error!(VaultError::InvalidInboundChannelPolicy)),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BucketTokenBalance {
    pub initialized: bool,
    pub token_id: u16,
    pub available_balance: u64,
    pub withdrawing_balance: u64,
    pub withdrawal_unlock_at: i64,
    pub withdrawal_destination: Pubkey,
}

impl BucketTokenBalance {
    pub const SPACE: usize = 1 + 2 + 8 + 8 + 8 + 32;

    pub fn empty() -> Self {
        Self::default()
    }
}

fn checked_positive_delta_to_u64(delta: i128) -> Result<u64> {
    u64::try_from(delta).map_err(|_| error!(VaultError::MathOverflow))
}

fn checked_negative_delta_to_u64(delta: i128) -> Result<u64> {
    let amount = delta
        .checked_neg()
        .ok_or(error!(VaultError::MathOverflow))?;
    u64::try_from(amount).map_err(|_| error!(VaultError::MathOverflow))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenWithdrawalSnapshot {
    pub withdrawing_balance: u64,
    pub withdrawal_unlock_at: i64,
    pub withdrawal_destination: Pubkey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParticipantClearingSnapshot {
    pub owner: Pubkey,
    pub bls_scheme_version: u8,
    pub bls_pubkey_compressed: [u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
    pub token_total_balance: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParticipantBucketSlot {
    pub initialized: bool,
    pub owner: Pubkey,
    pub participant_id: u32,
    pub inbound_channel_policy: u8,
    pub bls_scheme_version: u8,
    pub bls_pubkey_compressed: [u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
    pub token_balances: [BucketTokenBalance; MAX_BUCKET_TOKEN_BALANCES],
}

impl Default for ParticipantBucketSlot {
    fn default() -> Self {
        Self::empty()
    }
}

impl ParticipantBucketSlot {
    pub const SPACE: usize = 1
        + 32
        + 4
        + 1
        + 1
        + BLS_PUBLIC_KEY_COMPRESSED_SIZE
        + (MAX_BUCKET_TOKEN_BALANCES * BucketTokenBalance::SPACE);

    pub const BLS_SCHEME_VERSION_UNREGISTERED: u8 = 0;
    pub const BLS_SCHEME_VERSION_V1: u8 = 1;

    pub fn empty() -> Self {
        Self {
            initialized: false,
            owner: Pubkey::default(),
            participant_id: 0,
            inbound_channel_policy: InboundChannelPolicy::ConsentRequired as u8,
            bls_scheme_version: Self::BLS_SCHEME_VERSION_UNREGISTERED,
            bls_pubkey_compressed: [0u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
            token_balances: [BucketTokenBalance::empty(); MAX_BUCKET_TOKEN_BALANCES],
        }
    }

    pub fn initialize(&mut self, owner: Pubkey, participant_id: u32) -> Result<()> {
        require!(!self.initialized, VaultError::BucketSlotAlreadyInitialized);
        *self = Self {
            initialized: true,
            owner,
            participant_id,
            inbound_channel_policy: InboundChannelPolicy::ConsentRequired as u8,
            bls_scheme_version: Self::BLS_SCHEME_VERSION_UNREGISTERED,
            bls_pubkey_compressed: [0u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
            token_balances: [BucketTokenBalance::empty(); MAX_BUCKET_TOKEN_BALANCES],
        };
        Ok(())
    }

    pub fn inbound_channel_policy(&self) -> Result<InboundChannelPolicy> {
        InboundChannelPolicy::try_from(self.inbound_channel_policy)
    }

    pub fn set_inbound_channel_policy(&mut self, policy: InboundChannelPolicy) {
        self.inbound_channel_policy = policy as u8;
    }

    fn find_token_balance_index(&self, token_id: u16) -> Option<usize> {
        self.token_balances
            .iter()
            .position(|balance| balance.initialized && balance.token_id == token_id)
    }

    fn find_or_create_token_balance_index(&mut self, token_id: u16) -> Result<usize> {
        if let Some(index) = self.find_token_balance_index(token_id) {
            return Ok(index);
        }
        let index = self
            .token_balances
            .iter()
            .position(|balance| !balance.initialized)
            .ok_or(error!(VaultError::TooManyTokenBalances))?;
        self.token_balances[index] = BucketTokenBalance {
            initialized: true,
            token_id,
            ..BucketTokenBalance::empty()
        };
        Ok(index)
    }

    pub fn get_token_balance(&self, token_id: u16) -> Option<&BucketTokenBalance> {
        self.find_token_balance_index(token_id)
            .map(|index| &self.token_balances[index])
    }

    pub fn get_token_balance_mut(&mut self, token_id: u16) -> Result<&mut BucketTokenBalance> {
        let index = self.find_or_create_token_balance_index(token_id)?;
        Ok(&mut self.token_balances[index])
    }

    pub fn credit_token(&mut self, token_id: u16, amount: u64) -> Result<()> {
        let balance = self.get_token_balance_mut(token_id)?;
        balance.available_balance = balance
            .available_balance
            .checked_add(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        Ok(())
    }

    pub fn debit_token(&mut self, token_id: u16, amount: u64) -> Result<()> {
        let balance = self.get_token_balance_mut(token_id)?;
        let total_balance = balance
            .available_balance
            .checked_add(balance.withdrawing_balance)
            .ok_or(error!(VaultError::MathOverflow))?;
        require!(total_balance >= amount, VaultError::InsufficientBalance);

        if balance.available_balance >= amount {
            balance.available_balance -= amount;
        } else {
            let remainder = amount - balance.available_balance;
            balance.available_balance = 0;
            balance.withdrawing_balance = balance
                .withdrawing_balance
                .checked_sub(remainder)
                .ok_or(error!(VaultError::MathOverflow))?;
        }
        Ok(())
    }

    pub fn get_token_total_balance(&self, token_id: u16) -> Result<u64> {
        let balance = self
            .get_token_balance(token_id)
            .ok_or(error!(VaultError::TokenNotFound))?;
        balance
            .available_balance
            .checked_add(balance.withdrawing_balance)
            .ok_or(error!(VaultError::MathOverflow))
    }

    pub fn get_token_total_balance_or_zero(&self, token_id: u16) -> Result<u64> {
        match self.get_token_balance(token_id) {
            Some(balance) => balance
                .available_balance
                .checked_add(balance.withdrawing_balance)
                .ok_or(error!(VaultError::MathOverflow)),
            None => Ok(0),
        }
    }

    pub fn apply_token_delta(&mut self, token_id: u16, delta: i128) -> Result<()> {
        if delta >= 0 {
            return self.credit_token(token_id, checked_positive_delta_to_u64(delta)?);
        }
        self.debit_token(token_id, checked_negative_delta_to_u64(delta)?)
    }

    pub fn initiate_token_withdrawal(
        &mut self,
        token_id: u16,
        amount: u64,
        destination: Pubkey,
        unlock_at: i64,
    ) -> Result<()> {
        let balance = self.get_token_balance_mut(token_id)?;
        require!(
            balance.available_balance >= amount,
            VaultError::InsufficientBalance
        );
        balance.available_balance -= amount;
        balance.withdrawing_balance = balance
            .withdrawing_balance
            .checked_add(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        balance.withdrawal_destination = destination;
        balance.withdrawal_unlock_at = unlock_at;
        Ok(())
    }
}

#[cfg_attr(not(target_os = "solana"), account)]
pub struct ParticipantBucket {
    pub bucket_id: u32,
    pub bump: u8,
    pub slots: [ParticipantBucketSlot; PARTICIPANT_BUCKET_SLOT_COUNT],
}

impl ParticipantBucket {
    pub const DISCRIMINATOR: &'static [u8] = &[107, 145, 82, 194, 47, 231, 201, 105];
    pub const SEED_PREFIX: &'static [u8] = b"participant-bucket-v2";
    pub const SPACE: usize =
        8 + 4 + 1 + (PARTICIPANT_BUCKET_SLOT_COUNT * ParticipantBucketSlot::SPACE);

    pub const BUCKET_ID_OFFSET: usize = 8;
    pub const BUMP_OFFSET: usize = 12;
    pub const SLOTS_OFFSET: usize = 13;
    pub const SLOT_INITIALIZED_OFFSET: usize = 0;
    pub const SLOT_OWNER_OFFSET: usize = 1;
    pub const SLOT_PARTICIPANT_ID_OFFSET: usize = 33;
    pub const SLOT_INBOUND_POLICY_OFFSET: usize = 37;
    pub const SLOT_BLS_SCHEME_VERSION_OFFSET: usize = 38;
    pub const SLOT_BLS_PUBKEY_OFFSET: usize = 39;
    pub const SLOT_TOKEN_BALANCES_OFFSET: usize = 135;
    pub const TOKEN_ENTRY_INITIALIZED_OFFSET: usize = 0;
    pub const TOKEN_ENTRY_TOKEN_ID_OFFSET: usize = 1;
    pub const TOKEN_ENTRY_AVAILABLE_OFFSET: usize = 3;
    pub const TOKEN_ENTRY_WITHDRAWING_OFFSET: usize = 11;
    pub const TOKEN_ENTRY_UNLOCK_AT_OFFSET: usize = 19;
    pub const TOKEN_ENTRY_DESTINATION_OFFSET: usize = 27;

    fn require_valid_discriminator(data: &[u8], error_code: VaultError) -> Result<()> {
        let discriminator = Self::DISCRIMINATOR;
        if data.len() < discriminator.len() || !data.starts_with(discriminator) {
            return Err(error_code.into());
        }
        Ok(())
    }

    fn require_condition(condition: bool, error_code: VaultError) -> Result<()> {
        if !condition {
            return Err(error_code.into());
        }
        Ok(())
    }

    fn read_bool_at(data: &[u8], offset: usize, error_code: VaultError) -> Result<bool> {
        Self::require_condition(data.len() > offset, error_code)?;
        Ok(data[offset] != 0)
    }

    fn write_bool_at(
        data: &mut [u8],
        offset: usize,
        value: bool,
        error_code: VaultError,
    ) -> Result<()> {
        Self::require_condition(data.len() > offset, error_code)?;
        data[offset] = u8::from(value);
        Ok(())
    }

    fn read_u8_at(data: &[u8], offset: usize, error_code: VaultError) -> Result<u8> {
        Self::require_condition(data.len() > offset, error_code)?;
        Ok(data[offset])
    }

    fn write_u8_at(
        data: &mut [u8],
        offset: usize,
        value: u8,
        error_code: VaultError,
    ) -> Result<()> {
        Self::require_condition(data.len() > offset, error_code)?;
        data[offset] = value;
        Ok(())
    }

    fn read_u16_at(data: &[u8], offset: usize, error_code: VaultError) -> Result<u16> {
        Self::require_condition(data.len() >= offset + 2, error_code)?;
        Ok(u16::from_le_bytes(
            data[offset..offset + 2]
                .try_into()
                .map_err(|_| error!(error_code))?,
        ))
    }

    fn write_u16_at(
        data: &mut [u8],
        offset: usize,
        value: u16,
        error_code: VaultError,
    ) -> Result<()> {
        Self::require_condition(data.len() >= offset + 2, error_code)?;
        data[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
        Ok(())
    }

    fn read_u32_at(data: &[u8], offset: usize, error_code: VaultError) -> Result<u32> {
        Self::require_condition(data.len() >= offset + 4, error_code)?;
        Ok(u32::from_le_bytes(
            data[offset..offset + 4]
                .try_into()
                .map_err(|_| error!(error_code))?,
        ))
    }

    fn write_u32_at(
        data: &mut [u8],
        offset: usize,
        value: u32,
        error_code: VaultError,
    ) -> Result<()> {
        Self::require_condition(data.len() >= offset + 4, error_code)?;
        data[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        Ok(())
    }

    fn read_u64_at(data: &[u8], offset: usize, error_code: VaultError) -> Result<u64> {
        Self::require_condition(data.len() >= offset + 8, error_code)?;
        Ok(u64::from_le_bytes(
            data[offset..offset + 8]
                .try_into()
                .map_err(|_| error!(error_code))?,
        ))
    }

    fn write_u64_at(
        data: &mut [u8],
        offset: usize,
        value: u64,
        error_code: VaultError,
    ) -> Result<()> {
        Self::require_condition(data.len() >= offset + 8, error_code)?;
        data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        Ok(())
    }

    fn read_i64_at(data: &[u8], offset: usize, error_code: VaultError) -> Result<i64> {
        Self::require_condition(data.len() >= offset + 8, error_code)?;
        Ok(i64::from_le_bytes(
            data[offset..offset + 8]
                .try_into()
                .map_err(|_| error!(error_code))?,
        ))
    }

    fn write_i64_at(
        data: &mut [u8],
        offset: usize,
        value: i64,
        error_code: VaultError,
    ) -> Result<()> {
        Self::require_condition(data.len() >= offset + 8, error_code)?;
        data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        Ok(())
    }

    fn read_pubkey_at(data: &[u8], offset: usize, error_code: VaultError) -> Result<Pubkey> {
        Self::require_condition(data.len() >= offset + 32, error_code)?;
        Ok(Pubkey::new_from_array(
            data[offset..offset + 32]
                .try_into()
                .map_err(|_| error!(error_code))?,
        ))
    }

    fn write_pubkey_at(
        data: &mut [u8],
        offset: usize,
        value: Pubkey,
        error_code: VaultError,
    ) -> Result<()> {
        Self::write_bytes_at(data, offset, value.as_ref(), error_code)
    }

    fn write_bytes_at(
        data: &mut [u8],
        offset: usize,
        value: &[u8],
        error_code: VaultError,
    ) -> Result<()> {
        Self::require_condition(data.len() >= offset + value.len(), error_code)?;
        data[offset..offset + value.len()].copy_from_slice(value);
        Ok(())
    }

    pub fn read_bucket_id_and_bump(data: &[u8]) -> Result<(u32, u8)> {
        Self::require_valid_discriminator(data, VaultError::BucketAccountMismatch)?;
        require!(data.len() >= Self::SPACE, VaultError::BucketAccountMismatch);
        Ok((
            Self::read_u32_at(
                data,
                Self::BUCKET_ID_OFFSET,
                VaultError::BucketAccountMismatch,
            )?,
            Self::read_u8_at(data, Self::BUMP_OFFSET, VaultError::BucketAccountMismatch)?,
        ))
    }

    fn slot_offset_for_participant_index(data: &[u8], participant_id: u32) -> Result<usize> {
        let (bucket_id, _) = Self::read_bucket_id_and_bump(data)?;
        require!(
            bucket_id == Self::bucket_id_for_participant_id(participant_id),
            VaultError::BucketAccountMismatch
        );
        require!(data.len() >= Self::SPACE, VaultError::BucketAccountMismatch);
        let slot_index = Self::slot_index_for_participant_id(participant_id);
        let slot_offset = Self::SLOTS_OFFSET + slot_index * ParticipantBucketSlot::SPACE;
        require!(
            data.len() >= slot_offset + ParticipantBucketSlot::SPACE,
            VaultError::BucketAccountMismatch
        );
        Ok(slot_offset)
    }

    fn slot_offset_for_participant(data: &[u8], participant_id: u32) -> Result<usize> {
        let slot_offset = Self::slot_offset_for_participant_index(data, participant_id)?;
        require!(
            Self::read_bool_at(
                data,
                slot_offset + Self::SLOT_INITIALIZED_OFFSET,
                VaultError::ParticipantNotFound,
            )?,
            VaultError::ParticipantNotFound
        );
        require!(
            Self::read_u32_at(
                data,
                slot_offset + Self::SLOT_PARTICIPANT_ID_OFFSET,
                VaultError::BucketSlotMismatch,
            )? == participant_id,
            VaultError::BucketSlotMismatch
        );
        Ok(slot_offset)
    }

    fn token_entry_offset(data: &[u8], slot_offset: usize, token_id: u16) -> Result<Option<usize>> {
        for index in 0..MAX_BUCKET_TOKEN_BALANCES {
            let offset =
                slot_offset + Self::SLOT_TOKEN_BALANCES_OFFSET + index * BucketTokenBalance::SPACE;
            let initialized = Self::read_bool_at(
                data,
                offset + Self::TOKEN_ENTRY_INITIALIZED_OFFSET,
                VaultError::BucketAccountMismatch,
            )?;
            if !initialized {
                continue;
            }
            if Self::read_u16_at(
                data,
                offset + Self::TOKEN_ENTRY_TOKEN_ID_OFFSET,
                VaultError::BucketAccountMismatch,
            )? == token_id
            {
                return Ok(Some(offset));
            }
        }
        Ok(None)
    }

    fn find_or_create_token_entry_offset(
        data: &mut [u8],
        slot_offset: usize,
        token_id: u16,
    ) -> Result<usize> {
        if let Some(offset) = Self::token_entry_offset(data, slot_offset, token_id)? {
            return Ok(offset);
        }

        for index in 0..MAX_BUCKET_TOKEN_BALANCES {
            let offset =
                slot_offset + Self::SLOT_TOKEN_BALANCES_OFFSET + index * BucketTokenBalance::SPACE;
            let initialized = Self::read_bool_at(
                data,
                offset + Self::TOKEN_ENTRY_INITIALIZED_OFFSET,
                VaultError::TooManyTokenBalances,
            )?;
            if initialized {
                continue;
            }
            data[offset..offset + BucketTokenBalance::SPACE].fill(0);
            Self::write_bool_at(
                data,
                offset + Self::TOKEN_ENTRY_INITIALIZED_OFFSET,
                true,
                VaultError::TooManyTokenBalances,
            )?;
            Self::write_u16_at(
                data,
                offset + Self::TOKEN_ENTRY_TOKEN_ID_OFFSET,
                token_id,
                VaultError::TooManyTokenBalances,
            )?;
            return Ok(offset);
        }

        Err(error!(VaultError::TooManyTokenBalances))
    }

    pub fn read_slot_owner_and_bls_registration_from_data(
        data: &[u8],
        participant_id: u32,
    ) -> Result<(Pubkey, u8, [u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE])> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let owner = Self::read_pubkey_at(
            data,
            slot_offset + Self::SLOT_OWNER_OFFSET,
            VaultError::ParticipantNotFound,
        )?;
        let bls_scheme_version = Self::read_u8_at(
            data,
            slot_offset + Self::SLOT_BLS_SCHEME_VERSION_OFFSET,
            VaultError::ParticipantNotFound,
        )?;
        let mut bls_pubkey_compressed = [0u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE];
        bls_pubkey_compressed.copy_from_slice(
            &data[slot_offset + Self::SLOT_BLS_PUBKEY_OFFSET
                ..slot_offset + Self::SLOT_BLS_PUBKEY_OFFSET + BLS_PUBLIC_KEY_COMPRESSED_SIZE],
        );
        Ok((owner, bls_scheme_version, bls_pubkey_compressed))
    }

    pub fn read_slot_owner_from_data(data: &[u8], participant_id: u32) -> Result<Pubkey> {
        Ok(Self::read_slot_owner_and_bls_registration_from_data(data, participant_id)?.0)
    }

    pub fn read_clearing_snapshot_from_data(
        data: &[u8],
        participant_id: u32,
        token_id: u16,
    ) -> Result<ParticipantClearingSnapshot> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let owner = Self::read_pubkey_at(
            data,
            slot_offset + Self::SLOT_OWNER_OFFSET,
            VaultError::ParticipantNotFound,
        )?;
        let bls_scheme_version = Self::read_u8_at(
            data,
            slot_offset + Self::SLOT_BLS_SCHEME_VERSION_OFFSET,
            VaultError::ParticipantNotFound,
        )?;
        let mut bls_pubkey_compressed = [0u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE];
        bls_pubkey_compressed.copy_from_slice(
            &data[slot_offset + Self::SLOT_BLS_PUBKEY_OFFSET
                ..slot_offset + Self::SLOT_BLS_PUBKEY_OFFSET + BLS_PUBLIC_KEY_COMPRESSED_SIZE],
        );
        let token_total_balance =
            if let Some(entry_offset) = Self::token_entry_offset(data, slot_offset, token_id)? {
                let available = Self::read_u64_at(
                    data,
                    entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
                    VaultError::TokenNotFound,
                )?;
                let withdrawing = Self::read_u64_at(
                    data,
                    entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
                    VaultError::TokenNotFound,
                )?;
                available
                    .checked_add(withdrawing)
                    .ok_or(error!(VaultError::MathOverflow))?
            } else {
                0
            };

        Ok(ParticipantClearingSnapshot {
            owner,
            bls_scheme_version,
            bls_pubkey_compressed,
            token_total_balance,
        })
    }

    pub fn read_inbound_channel_policy_from_data(
        data: &[u8],
        participant_id: u32,
    ) -> Result<InboundChannelPolicy> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        InboundChannelPolicy::try_from(Self::read_u8_at(
            data,
            slot_offset + Self::SLOT_INBOUND_POLICY_OFFSET,
            VaultError::InvalidInboundChannelPolicy,
        )?)
    }

    pub fn write_inbound_channel_policy_in_data(
        data: &mut [u8],
        participant_id: u32,
        policy: InboundChannelPolicy,
    ) -> Result<()> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        Self::write_u8_at(
            data,
            slot_offset + Self::SLOT_INBOUND_POLICY_OFFSET,
            policy as u8,
            VaultError::InvalidInboundChannelPolicy,
        )
    }

    pub fn write_bls_registration_in_data(
        data: &mut [u8],
        participant_id: u32,
        bls_scheme_version: u8,
        bls_pubkey_compressed: &[u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
    ) -> Result<()> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        Self::write_u8_at(
            data,
            slot_offset + Self::SLOT_BLS_SCHEME_VERSION_OFFSET,
            bls_scheme_version,
            VaultError::AccountBlsKeyMismatch,
        )?;
        Self::write_bytes_at(
            data,
            slot_offset + Self::SLOT_BLS_PUBKEY_OFFSET,
            bls_pubkey_compressed,
            VaultError::AccountBlsKeyMismatch,
        )
    }

    pub fn read_token_total_balance_from_data(
        data: &[u8],
        participant_id: u32,
        token_id: u16,
    ) -> Result<u64> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let entry_offset = Self::token_entry_offset(data, slot_offset, token_id)?
            .ok_or(error!(VaultError::TokenNotFound))?;
        let available = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            VaultError::TokenNotFound,
        )?;
        let withdrawing = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
            VaultError::TokenNotFound,
        )?;
        available
            .checked_add(withdrawing)
            .ok_or(error!(VaultError::MathOverflow))
    }

    pub fn read_token_available_balance_from_data(
        data: &[u8],
        participant_id: u32,
        token_id: u16,
    ) -> Result<u64> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let entry_offset = Self::token_entry_offset(data, slot_offset, token_id)?
            .ok_or(error!(VaultError::TokenNotFound))?;
        Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            VaultError::TokenNotFound,
        )
    }

    pub fn read_token_withdrawal_from_data(
        data: &[u8],
        participant_id: u32,
        token_id: u16,
    ) -> Result<TokenWithdrawalSnapshot> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let entry_offset = Self::token_entry_offset(data, slot_offset, token_id)?
            .ok_or(error!(VaultError::TokenNotFound))?;
        Ok(TokenWithdrawalSnapshot {
            withdrawing_balance: Self::read_u64_at(
                data,
                entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
                VaultError::TokenNotFound,
            )?,
            withdrawal_unlock_at: Self::read_i64_at(
                data,
                entry_offset + Self::TOKEN_ENTRY_UNLOCK_AT_OFFSET,
                VaultError::TokenNotFound,
            )?,
            withdrawal_destination: Self::read_pubkey_at(
                data,
                entry_offset + Self::TOKEN_ENTRY_DESTINATION_OFFSET,
                VaultError::TokenNotFound,
            )?,
        })
    }

    pub fn read_token_total_balance_or_zero_from_data(
        data: &[u8],
        participant_id: u32,
        token_id: u16,
    ) -> Result<u64> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let Some(entry_offset) = Self::token_entry_offset(data, slot_offset, token_id)? else {
            return Ok(0);
        };
        let available = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            VaultError::TokenNotFound,
        )?;
        let withdrawing = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
            VaultError::TokenNotFound,
        )?;
        available
            .checked_add(withdrawing)
            .ok_or(error!(VaultError::MathOverflow))
    }

    pub fn debit_token_available_in_data(
        data: &mut [u8],
        participant_id: u32,
        token_id: u16,
        amount: u64,
    ) -> Result<u64> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let entry_offset = Self::token_entry_offset(data, slot_offset, token_id)?
            .ok_or(error!(VaultError::TokenNotFound))?;
        let available = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            VaultError::TokenNotFound,
        )?;
        require!(available >= amount, VaultError::InsufficientBalance);
        let next_available = available
            .checked_sub(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        Self::write_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            next_available,
            VaultError::MathOverflow,
        )?;
        Ok(next_available)
    }

    pub fn initiate_token_withdrawal_in_data(
        data: &mut [u8],
        participant_id: u32,
        token_id: u16,
        amount: u64,
        destination: Pubkey,
        unlock_at: i64,
    ) -> Result<()> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let entry_offset = Self::token_entry_offset(data, slot_offset, token_id)?
            .ok_or(error!(VaultError::TokenNotFound))?;
        let available = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            VaultError::TokenNotFound,
        )?;
        let withdrawing = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
            VaultError::TokenNotFound,
        )?;
        let withdrawal_unlock_at = Self::read_i64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_UNLOCK_AT_OFFSET,
            VaultError::TokenNotFound,
        )?;
        require!(
            withdrawal_unlock_at == 0,
            VaultError::WithdrawalAlreadyPending
        );
        require!(available >= amount, VaultError::InsufficientBalance);

        Self::write_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            available
                .checked_sub(amount)
                .ok_or(error!(VaultError::MathOverflow))?,
            VaultError::MathOverflow,
        )?;
        Self::write_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
            withdrawing
                .checked_add(amount)
                .ok_or(error!(VaultError::MathOverflow))?,
            VaultError::MathOverflow,
        )?;
        Self::write_i64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_UNLOCK_AT_OFFSET,
            unlock_at,
            VaultError::MathOverflow,
        )?;
        Self::write_pubkey_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_DESTINATION_OFFSET,
            destination,
            VaultError::InvalidWithdrawalDestination,
        )
    }

    pub fn cancel_token_withdrawal_in_data(
        data: &mut [u8],
        participant_id: u32,
        token_id: u16,
    ) -> Result<u64> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let Some(entry_offset) = Self::token_entry_offset(data, slot_offset, token_id)? else {
            return Err(error!(VaultError::NoWithdrawalPending));
        };
        let withdrawal_unlock_at = Self::read_i64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_UNLOCK_AT_OFFSET,
            VaultError::NoWithdrawalPending,
        )?;
        require!(withdrawal_unlock_at != 0, VaultError::NoWithdrawalPending);

        let available = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            VaultError::NoWithdrawalPending,
        )?;
        let withdrawing = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
            VaultError::NoWithdrawalPending,
        )?;
        Self::write_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            available
                .checked_add(withdrawing)
                .ok_or(error!(VaultError::MathOverflow))?,
            VaultError::MathOverflow,
        )?;
        Self::clear_token_withdrawal_in_data(data, participant_id, token_id)?;
        Ok(withdrawing)
    }

    pub fn clear_token_withdrawal_in_data(
        data: &mut [u8],
        participant_id: u32,
        token_id: u16,
    ) -> Result<()> {
        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        let entry_offset = Self::token_entry_offset(data, slot_offset, token_id)?
            .ok_or(error!(VaultError::TokenNotFound))?;
        Self::write_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
            0,
            VaultError::MathOverflow,
        )?;
        Self::write_i64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_UNLOCK_AT_OFFSET,
            0,
            VaultError::MathOverflow,
        )?;
        Self::write_pubkey_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_DESTINATION_OFFSET,
            Pubkey::default(),
            VaultError::MathOverflow,
        )
    }

    pub fn apply_token_delta_in_data(
        data: &mut [u8],
        participant_id: u32,
        token_id: u16,
        delta: i128,
    ) -> Result<()> {
        if delta == 0 {
            return Ok(());
        }

        let slot_offset = Self::slot_offset_for_participant(data, participant_id)?;
        if delta > 0 {
            let amount = checked_positive_delta_to_u64(delta)?;
            let entry_offset =
                Self::find_or_create_token_entry_offset(data, slot_offset, token_id)?;
            let available = Self::read_u64_at(
                data,
                entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
                VaultError::MathOverflow,
            )?;
            let next_available = available
                .checked_add(amount)
                .ok_or(error!(VaultError::MathOverflow))?;
            return Self::write_u64_at(
                data,
                entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
                next_available,
                VaultError::MathOverflow,
            );
        }

        let amount = checked_negative_delta_to_u64(delta)?;
        let entry_offset = Self::token_entry_offset(data, slot_offset, token_id)?
            .ok_or(error!(VaultError::InsufficientBalance))?;
        let available = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            VaultError::InsufficientBalance,
        )?;
        let withdrawing = Self::read_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
            VaultError::InsufficientBalance,
        )?;
        let total = available
            .checked_add(withdrawing)
            .ok_or(error!(VaultError::MathOverflow))?;
        require!(total >= amount, VaultError::InsufficientBalance);

        if available >= amount {
            return Self::write_u64_at(
                data,
                entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
                available - amount,
                VaultError::MathOverflow,
            );
        }

        let remainder = amount - available;
        Self::write_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_AVAILABLE_OFFSET,
            0,
            VaultError::MathOverflow,
        )?;
        Self::write_u64_at(
            data,
            entry_offset + Self::TOKEN_ENTRY_WITHDRAWING_OFFSET,
            withdrawing
                .checked_sub(remainder)
                .ok_or(error!(VaultError::MathOverflow))?,
            VaultError::MathOverflow,
        )
    }

    pub fn initialize_account_data(data: &mut [u8], bucket_id: u32, bump: u8) -> Result<()> {
        Self::require_condition(data.len() >= Self::SPACE, VaultError::BucketAccountMismatch)?;
        data[..Self::SPACE].fill(0);
        data[..Self::DISCRIMINATOR.len()].copy_from_slice(Self::DISCRIMINATOR);
        Self::write_u32_at(
            data,
            Self::BUCKET_ID_OFFSET,
            bucket_id,
            VaultError::BucketAccountMismatch,
        )?;
        Self::write_u8_at(
            data,
            Self::BUMP_OFFSET,
            bump,
            VaultError::BucketAccountMismatch,
        )
    }

    pub fn initialize_slot_in_data(
        data: &mut [u8],
        participant_id: u32,
        owner: Pubkey,
    ) -> Result<()> {
        let slot_offset = Self::slot_offset_for_participant_index(data, participant_id)?;
        require!(
            !Self::read_bool_at(
                data,
                slot_offset + Self::SLOT_INITIALIZED_OFFSET,
                VaultError::BucketSlotAlreadyInitialized,
            )?,
            VaultError::BucketSlotAlreadyInitialized
        );

        data[slot_offset..slot_offset + ParticipantBucketSlot::SPACE].fill(0);
        Self::write_bool_at(
            data,
            slot_offset + Self::SLOT_INITIALIZED_OFFSET,
            true,
            VaultError::BucketSlotAlreadyInitialized,
        )?;
        Self::write_pubkey_at(
            data,
            slot_offset + Self::SLOT_OWNER_OFFSET,
            owner,
            VaultError::BucketAccountMismatch,
        )?;
        Self::write_u32_at(
            data,
            slot_offset + Self::SLOT_PARTICIPANT_ID_OFFSET,
            participant_id,
            VaultError::BucketSlotMismatch,
        )?;
        Self::write_u8_at(
            data,
            slot_offset + Self::SLOT_INBOUND_POLICY_OFFSET,
            InboundChannelPolicy::ConsentRequired as u8,
            VaultError::InvalidInboundChannelPolicy,
        )?;
        Self::write_u8_at(
            data,
            slot_offset + Self::SLOT_BLS_SCHEME_VERSION_OFFSET,
            ParticipantBucketSlot::BLS_SCHEME_VERSION_UNREGISTERED,
            VaultError::AccountBlsKeyMismatch,
        )
    }

    pub fn bucket_id_for_participant_id(participant_id: u32) -> u32 {
        participant_id / PARTICIPANT_BUCKET_SLOT_COUNT as u32
    }

    pub fn slot_index_for_participant_id(participant_id: u32) -> usize {
        (participant_id % PARTICIPANT_BUCKET_SLOT_COUNT as u32) as usize
    }

    pub fn initialize_if_needed(&mut self, bucket_id: u32, bump: u8) -> Result<()> {
        if self.slots.iter().all(|slot| !slot.initialized) {
            self.bucket_id = bucket_id;
            self.bump = bump;
            self.slots = [ParticipantBucketSlot::empty(); PARTICIPANT_BUCKET_SLOT_COUNT];
            return Ok(());
        }
        require!(
            self.bucket_id == bucket_id,
            VaultError::BucketAccountMismatch
        );
        require!(self.bump == bump, VaultError::BucketAccountMismatch);
        Ok(())
    }

    pub fn verify_expected_pda(
        account_key: &Pubkey,
        bucket_id: u32,
        bump: u8,
        program_id: &Pubkey,
    ) -> Result<()> {
        let bucket_bytes = bucket_id.to_le_bytes();
        let expected_pda = Pubkey::create_program_address(
            &[Self::SEED_PREFIX, bucket_bytes.as_ref(), &[bump]],
            program_id,
        )
        .map_err(|_| error!(VaultError::BucketAccountMismatch))?;
        require!(
            *account_key == expected_pda,
            VaultError::BucketAccountMismatch
        );
        Ok(())
    }

    pub fn verify_bucket_for_participant(
        &self,
        account_key: &Pubkey,
        participant_id: u32,
        program_id: &Pubkey,
    ) -> Result<()> {
        Self::verify_expected_pda(
            account_key,
            Self::bucket_id_for_participant_id(participant_id),
            self.bump,
            program_id,
        )?;
        self.slot(participant_id).map(|_| ())
    }

    pub fn slot(&self, participant_id: u32) -> Result<&ParticipantBucketSlot> {
        require!(
            self.bucket_id == Self::bucket_id_for_participant_id(participant_id),
            VaultError::BucketAccountMismatch
        );
        let index = Self::slot_index_for_participant_id(participant_id);
        let slot = self
            .slots
            .get(index)
            .ok_or(error!(VaultError::BucketSlotMismatch))?;
        require!(slot.initialized, VaultError::ParticipantNotFound);
        require!(
            slot.participant_id == participant_id,
            VaultError::BucketSlotMismatch
        );
        Ok(slot)
    }

    pub fn slot_mut(&mut self, participant_id: u32) -> Result<&mut ParticipantBucketSlot> {
        require!(
            self.bucket_id == Self::bucket_id_for_participant_id(participant_id),
            VaultError::BucketAccountMismatch
        );
        let index = Self::slot_index_for_participant_id(participant_id);
        let slot = self
            .slots
            .get_mut(index)
            .ok_or(error!(VaultError::BucketSlotMismatch))?;
        require!(slot.initialized, VaultError::ParticipantNotFound);
        require!(
            slot.participant_id == participant_id,
            VaultError::BucketSlotMismatch
        );
        Ok(slot)
    }

    pub fn initialize_slot(
        &mut self,
        participant_id: u32,
        owner: Pubkey,
    ) -> Result<&mut ParticipantBucketSlot> {
        require!(
            self.bucket_id == Self::bucket_id_for_participant_id(participant_id),
            VaultError::BucketAccountMismatch
        );
        let index = Self::slot_index_for_participant_id(participant_id);
        let slot = self
            .slots
            .get_mut(index)
            .ok_or(error!(VaultError::BucketSlotMismatch))?;
        slot.initialize(owner, participant_id)?;
        Ok(slot)
    }

    pub fn slot_by_owner(&self, owner: &Pubkey) -> Result<&ParticipantBucketSlot> {
        self.slots
            .iter()
            .find(|slot| slot.initialized && slot.owner == *owner)
            .ok_or(error!(VaultError::ParticipantNotFound))
    }

    pub fn slot_by_owner_mut(&mut self, owner: &Pubkey) -> Result<&mut ParticipantBucketSlot> {
        self.slots
            .iter_mut()
            .find(|slot| slot.initialized && slot.owner == *owner)
            .ok_or(error!(VaultError::ParticipantNotFound))
    }

    pub fn find_slot_by_owner(&self, owner: &Pubkey) -> Option<&ParticipantBucketSlot> {
        self.slots
            .iter()
            .find(|slot| slot.initialized && slot.owner == *owner)
    }

    pub fn verify_account_info(
        account_info: &AccountInfo,
        bucket_id: u32,
        program_id: &Pubkey,
    ) -> Result<()> {
        require!(
            account_info.owner == program_id,
            VaultError::BucketAccountMismatch
        );
        let data = account_info.try_borrow_data()?;
        let (actual_bucket_id, bump) = Self::read_bucket_id_and_bump(data.as_ref())?;
        require!(
            actual_bucket_id == bucket_id,
            VaultError::BucketAccountMismatch
        );
        Self::verify_expected_pda(account_info.key, actual_bucket_id, bump, program_id)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OwnerIndexSlot {
    pub initialized: bool,
    pub owner: Pubkey,
    pub participant_id: u32,
}

impl OwnerIndexSlot {
    pub const SPACE: usize = 1 + 32 + 4;

    pub fn empty() -> Self {
        Self::default()
    }
}

#[account]
pub struct OwnerIndexBucket {
    pub bucket_id: u32,
    pub bump: u8,
    pub slots: [OwnerIndexSlot; OWNER_INDEX_BUCKET_SLOT_COUNT],
}

impl OwnerIndexBucket {
    pub const SEED_PREFIX: &'static [u8] = b"owner-index-bucket-v2";
    pub const SPACE: usize = 8 + 4 + 1 + (OWNER_INDEX_BUCKET_SLOT_COUNT * OwnerIndexSlot::SPACE);

    pub fn bucket_id_for_owner(owner: &Pubkey) -> u32 {
        let digest = Sha256::digest(owner.as_ref());
        u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) % OWNER_INDEX_BUCKET_COUNT
    }

    pub fn initialize_if_needed(&mut self, bucket_id: u32, bump: u8) -> Result<()> {
        if self.slots.iter().all(|slot| !slot.initialized) {
            self.bucket_id = bucket_id;
            self.bump = bump;
            self.slots = [OwnerIndexSlot::empty(); OWNER_INDEX_BUCKET_SLOT_COUNT];
            return Ok(());
        }
        require!(
            self.bucket_id == bucket_id,
            VaultError::BucketAccountMismatch
        );
        require!(self.bump == bump, VaultError::BucketAccountMismatch);
        Ok(())
    }

    pub fn verify_expected_pda(
        account_key: &Pubkey,
        bucket_id: u32,
        bump: u8,
        program_id: &Pubkey,
    ) -> Result<()> {
        let bucket_bytes = bucket_id.to_le_bytes();
        let expected_pda = Pubkey::create_program_address(
            &[Self::SEED_PREFIX, bucket_bytes.as_ref(), &[bump]],
            program_id,
        )
        .map_err(|_| error!(VaultError::BucketAccountMismatch))?;
        require!(
            *account_key == expected_pda,
            VaultError::BucketAccountMismatch
        );
        Ok(())
    }

    pub fn verify_for_owner(
        &self,
        account_key: &Pubkey,
        owner: &Pubkey,
        program_id: &Pubkey,
    ) -> Result<()> {
        let expected_bucket_id = Self::bucket_id_for_owner(owner);
        require!(
            self.bucket_id == expected_bucket_id,
            VaultError::BucketAccountMismatch
        );
        Self::verify_expected_pda(account_key, expected_bucket_id, self.bump, program_id)
    }

    pub fn insert_owner(&mut self, owner: Pubkey, participant_id: u32) -> Result<()> {
        require!(
            self.slots
                .iter()
                .all(|slot| !slot.initialized || slot.owner != owner),
            VaultError::OwnerAlreadyRegistered
        );
        let slot = self
            .slots
            .iter_mut()
            .find(|slot| !slot.initialized)
            .ok_or(error!(VaultError::BucketFull))?;
        *slot = OwnerIndexSlot {
            initialized: true,
            owner,
            participant_id,
        };
        Ok(())
    }

    pub fn participant_id_for_owner(&self, owner: &Pubkey) -> Result<u32> {
        self.slots
            .iter()
            .find(|slot| slot.initialized && slot.owner == *owner)
            .map(|slot| slot.participant_id)
            .ok_or(error!(VaultError::ParticipantNotFound))
    }

    pub fn participant_id_for_verified_owner(
        &self,
        account_key: &Pubkey,
        owner: &Pubkey,
        program_id: &Pubkey,
    ) -> Result<u32> {
        self.verify_for_owner(account_key, owner, program_id)?;
        self.participant_id_for_owner(owner)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelBucketSlot {
    pub initialized: bool,
    pub lower_participant_id: u32,
    pub higher_participant_id: u32,
    pub lower_to_higher: DirectionalLaneState,
    pub higher_to_lower: DirectionalLaneState,
}

impl ChannelBucketSlot {
    pub const SPACE: usize = 1 + 4 + 4 + DirectionalLaneState::SPACE + DirectionalLaneState::SPACE;

    pub fn empty() -> Self {
        Self {
            initialized: false,
            lower_participant_id: 0,
            higher_participant_id: 0,
            lower_to_higher: DirectionalLaneState::uninitialized(),
            higher_to_lower: DirectionalLaneState::uninitialized(),
        }
    }

    pub fn initialize_pair(&mut self, lower_participant_id: u32, higher_participant_id: u32) {
        self.initialized = true;
        self.lower_participant_id = lower_participant_id;
        self.higher_participant_id = higher_participant_id;
        self.lower_to_higher = DirectionalLaneState::uninitialized();
        self.higher_to_lower = DirectionalLaneState::uninitialized();
    }

    pub fn lane(&self, selector: LaneSelector) -> &DirectionalLaneState {
        match selector {
            LaneSelector::LowerToHigher => &self.lower_to_higher,
            LaneSelector::HigherToLower => &self.higher_to_lower,
        }
    }

    pub fn lane_mut(&mut self, selector: LaneSelector) -> &mut DirectionalLaneState {
        match selector {
            LaneSelector::LowerToHigher => &mut self.lower_to_higher,
            LaneSelector::HigherToLower => &mut self.higher_to_lower,
        }
    }

    pub fn read_lane_core(&self, selector: LaneSelector) -> LaneCore {
        let lane = self.lane(selector);
        LaneCore {
            initialized: lane.initialized,
            settled_cumulative: lane.settled_cumulative,
            locked_balance: lane.locked_balance,
            authorized_signer: lane.authorized_signer,
            pending_unlock_amount: lane.pending_unlock_amount,
            unlock_requested_at: lane.unlock_requested_at,
            pending_authorized_signer: lane.pending_authorized_signer,
            authorized_signer_update_requested_at: lane.authorized_signer_update_requested_at,
        }
    }
}

#[cfg_attr(not(target_os = "solana"), account)]
pub struct ChannelBucket {
    pub token_id: u16,
    pub bucket_id: u64,
    pub bump: u8,
    pub slots: [ChannelBucketSlot; CHANNEL_BUCKET_SLOT_COUNT],
}

impl ChannelBucket {
    pub const DISCRIMINATOR: &'static [u8] = &[171, 219, 130, 228, 148, 242, 103, 148];
    pub const SEED_PREFIX: &'static [u8] = b"channel-bucket-v2";
    pub const SPACE: usize = 8 + 2 + 8 + 1 + (CHANNEL_BUCKET_SLOT_COUNT * ChannelBucketSlot::SPACE);
    pub const TOKEN_ID_OFFSET: usize = 8;
    pub const BUCKET_ID_OFFSET: usize = 10;
    pub const BUMP_OFFSET: usize = 18;
    pub const SLOTS_OFFSET: usize = 19;
    pub const SLOT_INITIALIZED_OFFSET: usize = 0;
    pub const SLOT_LOWER_PARTICIPANT_ID_OFFSET: usize = 1;
    pub const SLOT_HIGHER_PARTICIPANT_ID_OFFSET: usize = 5;
    pub const LOWER_TO_HIGHER_LANE_OFFSET: usize = 9;
    pub const HIGHER_TO_LOWER_LANE_OFFSET: usize =
        Self::LOWER_TO_HIGHER_LANE_OFFSET + DirectionalLaneState::SPACE;
    pub const LANE_INITIALIZED_OFFSET: usize = 0;
    pub const LANE_SETTLED_CUMULATIVE_OFFSET: usize = 1;
    pub const LANE_LOCKED_BALANCE_OFFSET: usize = 9;
    pub const LANE_AUTHORIZED_SIGNER_OFFSET: usize = 17;
    pub const LANE_PENDING_UNLOCK_AMOUNT_OFFSET: usize = 49;
    pub const LANE_UNLOCK_REQUESTED_AT_OFFSET: usize = 57;
    pub const LANE_PENDING_AUTHORIZED_SIGNER_OFFSET: usize = 65;
    pub const LANE_AUTHORIZED_SIGNER_UPDATE_REQUESTED_AT_OFFSET: usize = 97;

    fn require_valid_discriminator(data: &[u8], error_code: VaultError) -> Result<()> {
        let discriminator = Self::DISCRIMINATOR;
        if data.len() < discriminator.len() || !data.starts_with(discriminator) {
            return Err(error_code.into());
        }
        Ok(())
    }

    fn lane_offset(selector: LaneSelector) -> usize {
        match selector {
            LaneSelector::LowerToHigher => Self::LOWER_TO_HIGHER_LANE_OFFSET,
            LaneSelector::HigherToLower => Self::HIGHER_TO_LOWER_LANE_OFFSET,
        }
    }

    pub fn read_token_bucket_and_bump(data: &[u8]) -> Result<(u16, u64, u8)> {
        Self::require_valid_discriminator(data, VaultError::BucketAccountMismatch)?;
        require!(data.len() >= Self::SPACE, VaultError::BucketAccountMismatch);
        Ok((
            ParticipantBucket::read_u16_at(
                data,
                Self::TOKEN_ID_OFFSET,
                VaultError::BucketAccountMismatch,
            )?,
            u64::from_le_bytes(
                data[Self::BUCKET_ID_OFFSET..Self::BUCKET_ID_OFFSET + 8]
                    .try_into()
                    .map_err(|_| error!(VaultError::BucketAccountMismatch))?,
            ),
            ParticipantBucket::read_u8_at(
                data,
                Self::BUMP_OFFSET,
                VaultError::BucketAccountMismatch,
            )?,
        ))
    }

    fn slot_offset_for_pair(
        data: &[u8],
        lower_participant_id: u32,
        higher_participant_id: u32,
    ) -> Result<usize> {
        let (_, bucket_id, _) = Self::read_token_bucket_and_bump(data)?;
        require!(
            bucket_id == Self::bucket_id_for_pair(lower_participant_id, higher_participant_id)?,
            VaultError::BucketAccountMismatch
        );
        require!(data.len() >= Self::SPACE, VaultError::BucketAccountMismatch);
        let slot_index = Self::slot_index_for_pair(lower_participant_id, higher_participant_id)?;
        let slot_offset = Self::SLOTS_OFFSET + slot_index * ChannelBucketSlot::SPACE;
        require!(
            data.len() >= slot_offset + ChannelBucketSlot::SPACE,
            VaultError::BucketAccountMismatch
        );
        require!(
            ParticipantBucket::read_bool_at(
                data,
                slot_offset + Self::SLOT_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        require!(
            ParticipantBucket::read_u32_at(
                data,
                slot_offset + Self::SLOT_LOWER_PARTICIPANT_ID_OFFSET,
                VaultError::BucketSlotMismatch,
            )? == lower_participant_id
                && ParticipantBucket::read_u32_at(
                    data,
                    slot_offset + Self::SLOT_HIGHER_PARTICIPANT_ID_OFFSET,
                    VaultError::BucketSlotMismatch,
                )? == higher_participant_id,
            VaultError::BucketSlotMismatch
        );
        Ok(slot_offset)
    }

    pub fn read_resolved_lane_core_from_data(
        data: &[u8],
        payer_id: u32,
        payee_id: u32,
    ) -> Result<LaneCore> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        Ok(LaneCore {
            initialized: ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            settled_cumulative: ParticipantBucket::read_u64_at(
                data,
                lane_offset + Self::LANE_SETTLED_CUMULATIVE_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            locked_balance: ParticipantBucket::read_u64_at(
                data,
                lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            authorized_signer: ParticipantBucket::read_pubkey_at(
                data,
                lane_offset + Self::LANE_AUTHORIZED_SIGNER_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            pending_unlock_amount: ParticipantBucket::read_u64_at(
                data,
                lane_offset + Self::LANE_PENDING_UNLOCK_AMOUNT_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            unlock_requested_at: i64::from_le_bytes(
                data[lane_offset + Self::LANE_UNLOCK_REQUESTED_AT_OFFSET
                    ..lane_offset + Self::LANE_UNLOCK_REQUESTED_AT_OFFSET + 8]
                    .try_into()
                    .map_err(|_| error!(VaultError::ChannelNotInitialized))?,
            ),
            pending_authorized_signer: ParticipantBucket::read_pubkey_at(
                data,
                lane_offset + Self::LANE_PENDING_AUTHORIZED_SIGNER_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            authorized_signer_update_requested_at: i64::from_le_bytes(
                data[lane_offset + Self::LANE_AUTHORIZED_SIGNER_UPDATE_REQUESTED_AT_OFFSET
                    ..lane_offset + Self::LANE_AUTHORIZED_SIGNER_UPDATE_REQUESTED_AT_OFFSET + 8]
                    .try_into()
                    .map_err(|_| error!(VaultError::ChannelNotInitialized))?,
            ),
        })
    }

    pub fn read_lane_settlement_for_selector_from_data(
        data: &[u8],
        lower_participant_id: u32,
        higher_participant_id: u32,
        selector: LaneSelector,
    ) -> Result<ChannelLaneSettlementSnapshot> {
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        require!(
            ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        Ok(ChannelLaneSettlementSnapshot {
            lane_offset,
            settled_cumulative: ParticipantBucket::read_u64_at(
                data,
                lane_offset + Self::LANE_SETTLED_CUMULATIVE_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            locked_balance: ParticipantBucket::read_u64_at(
                data,
                lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
        })
    }

    pub fn read_resolved_lane_settlement_from_data(
        data: &[u8],
        payer_id: u32,
        payee_id: u32,
    ) -> Result<ChannelLaneSettlementSnapshot> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        Self::read_lane_settlement_for_selector_from_data(
            data,
            lower_participant_id,
            higher_participant_id,
            selector,
        )
    }

    pub fn read_lane_commitment_for_selector_from_data(
        data: &[u8],
        lower_participant_id: u32,
        higher_participant_id: u32,
        selector: LaneSelector,
    ) -> Result<ChannelLaneCommitmentSnapshot> {
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        require!(
            ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        Ok(ChannelLaneCommitmentSnapshot {
            lane_offset,
            settled_cumulative: ParticipantBucket::read_u64_at(
                data,
                lane_offset + Self::LANE_SETTLED_CUMULATIVE_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            locked_balance: ParticipantBucket::read_u64_at(
                data,
                lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            authorized_signer: ParticipantBucket::read_pubkey_at(
                data,
                lane_offset + Self::LANE_AUTHORIZED_SIGNER_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
        })
    }

    pub fn read_resolved_lane_commitment_from_data(
        data: &[u8],
        payer_id: u32,
        payee_id: u32,
    ) -> Result<ChannelLaneCommitmentSnapshot> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        Self::read_lane_commitment_for_selector_from_data(
            data,
            lower_participant_id,
            higher_participant_id,
            selector,
        )
    }

    pub fn apply_lane_settlement_in_data(
        data: &mut [u8],
        payer_id: u32,
        payee_id: u32,
        target_cumulative: u64,
        locked_consumed: u64,
    ) -> Result<()> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        Self::apply_lane_settlement_for_selector_in_data(
            data,
            lower_participant_id,
            higher_participant_id,
            selector,
            target_cumulative,
            locked_consumed,
        )
    }

    fn cap_pending_unlock_at_lane_offset_in_data(
        data: &mut [u8],
        lane_offset: usize,
        max_pending_amount: u64,
    ) -> Result<()> {
        let pending_unlock_amount = ParticipantBucket::read_u64_at(
            data,
            lane_offset + Self::LANE_PENDING_UNLOCK_AMOUNT_OFFSET,
            VaultError::MathOverflow,
        )?;
        if pending_unlock_amount == 0 {
            ParticipantBucket::write_i64_at(
                data,
                lane_offset + Self::LANE_UNLOCK_REQUESTED_AT_OFFSET,
                0,
                VaultError::MathOverflow,
            )?;
            return Ok(());
        }
        if pending_unlock_amount <= max_pending_amount {
            return Ok(());
        }

        ParticipantBucket::write_u64_at(
            data,
            lane_offset + Self::LANE_PENDING_UNLOCK_AMOUNT_OFFSET,
            max_pending_amount,
            VaultError::MathOverflow,
        )?;
        if max_pending_amount == 0 {
            ParticipantBucket::write_i64_at(
                data,
                lane_offset + Self::LANE_UNLOCK_REQUESTED_AT_OFFSET,
                0,
                VaultError::MathOverflow,
            )?;
        }
        Ok(())
    }

    pub fn apply_lane_settlement_at_offset_in_data(
        data: &mut [u8],
        lane_offset: usize,
        target_cumulative: u64,
        locked_consumed: u64,
    ) -> Result<()> {
        ParticipantBucket::require_condition(
            data.len()
                >= lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET + core::mem::size_of::<u64>(),
            VaultError::BucketAccountMismatch,
        )?;
        require!(
            ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        let locked_balance = ParticipantBucket::read_u64_at(
            data,
            lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
            VaultError::MathOverflow,
        )?;
        let next_locked_balance = locked_balance
            .checked_sub(locked_consumed)
            .ok_or(error!(VaultError::MathOverflow))?;
        ParticipantBucket::write_u64_at(
            data,
            lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
            next_locked_balance,
            VaultError::MathOverflow,
        )?;
        Self::cap_pending_unlock_at_lane_offset_in_data(data, lane_offset, next_locked_balance)?;
        ParticipantBucket::write_u64_at(
            data,
            lane_offset + Self::LANE_SETTLED_CUMULATIVE_OFFSET,
            target_cumulative,
            VaultError::MathOverflow,
        )
    }

    pub fn apply_lane_settlement_for_selector_in_data(
        data: &mut [u8],
        lower_participant_id: u32,
        higher_participant_id: u32,
        selector: LaneSelector,
        target_cumulative: u64,
        locked_consumed: u64,
    ) -> Result<()> {
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        Self::apply_lane_settlement_at_offset_in_data(
            data,
            lane_offset,
            target_cumulative,
            locked_consumed,
        )
    }

    pub fn initialize_account_data(
        data: &mut [u8],
        token_id: u16,
        bucket_id: u64,
        bump: u8,
    ) -> Result<()> {
        ParticipantBucket::require_condition(
            data.len() >= Self::SPACE,
            VaultError::BucketAccountMismatch,
        )?;
        data[..Self::SPACE].fill(0);
        data[..Self::DISCRIMINATOR.len()].copy_from_slice(Self::DISCRIMINATOR);
        ParticipantBucket::write_u16_at(
            data,
            Self::TOKEN_ID_OFFSET,
            token_id,
            VaultError::BucketAccountMismatch,
        )?;
        ParticipantBucket::write_u64_at(
            data,
            Self::BUCKET_ID_OFFSET,
            bucket_id,
            VaultError::BucketAccountMismatch,
        )?;
        ParticipantBucket::write_u8_at(
            data,
            Self::BUMP_OFFSET,
            bump,
            VaultError::BucketAccountMismatch,
        )
    }

    pub fn initialize_lane_in_data(
        data: &mut [u8],
        token_id: u16,
        lower_participant_id: u32,
        higher_participant_id: u32,
        selector: LaneSelector,
        authorized_signer: Pubkey,
    ) -> Result<()> {
        let (actual_token_id, bucket_id, _) = Self::read_token_bucket_and_bump(data)?;
        require!(actual_token_id == token_id, VaultError::InvalidTokenMint);
        require!(
            bucket_id == Self::bucket_id_for_pair(lower_participant_id, higher_participant_id)?,
            VaultError::BucketAccountMismatch
        );
        ParticipantBucket::require_condition(
            data.len() >= Self::SPACE,
            VaultError::BucketAccountMismatch,
        )?;

        let slot_index = Self::slot_index_for_pair(lower_participant_id, higher_participant_id)?;
        let slot_offset = Self::SLOTS_OFFSET + slot_index * ChannelBucketSlot::SPACE;
        ParticipantBucket::require_condition(
            data.len() >= slot_offset + ChannelBucketSlot::SPACE,
            VaultError::BucketAccountMismatch,
        )?;

        let slot_initialized = ParticipantBucket::read_bool_at(
            data,
            slot_offset + Self::SLOT_INITIALIZED_OFFSET,
            VaultError::BucketAccountMismatch,
        )?;
        if slot_initialized {
            require!(
                ParticipantBucket::read_u32_at(
                    data,
                    slot_offset + Self::SLOT_LOWER_PARTICIPANT_ID_OFFSET,
                    VaultError::BucketSlotMismatch,
                )? == lower_participant_id
                    && ParticipantBucket::read_u32_at(
                        data,
                        slot_offset + Self::SLOT_HIGHER_PARTICIPANT_ID_OFFSET,
                        VaultError::BucketSlotMismatch,
                    )? == higher_participant_id,
                VaultError::BucketSlotMismatch
            );
        } else {
            data[slot_offset..slot_offset + ChannelBucketSlot::SPACE].fill(0);
            ParticipantBucket::write_bool_at(
                data,
                slot_offset + Self::SLOT_INITIALIZED_OFFSET,
                true,
                VaultError::BucketAccountMismatch,
            )?;
            ParticipantBucket::write_u32_at(
                data,
                slot_offset + Self::SLOT_LOWER_PARTICIPANT_ID_OFFSET,
                lower_participant_id,
                VaultError::BucketSlotMismatch,
            )?;
            ParticipantBucket::write_u32_at(
                data,
                slot_offset + Self::SLOT_HIGHER_PARTICIPANT_ID_OFFSET,
                higher_participant_id,
                VaultError::BucketSlotMismatch,
            )?;
        }

        let lane_offset = slot_offset + Self::lane_offset(selector);
        require!(
            !ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelAlreadyExists,
            )?,
            VaultError::ChannelAlreadyExists
        );
        data[lane_offset..lane_offset + DirectionalLaneState::SPACE].fill(0);
        ParticipantBucket::write_bool_at(
            data,
            lane_offset + Self::LANE_INITIALIZED_OFFSET,
            true,
            VaultError::ChannelAlreadyExists,
        )?;
        ParticipantBucket::write_pubkey_at(
            data,
            lane_offset + Self::LANE_AUTHORIZED_SIGNER_OFFSET,
            authorized_signer,
            VaultError::BucketAccountMismatch,
        )
    }

    pub fn add_lane_locked_balance_in_data(
        data: &mut [u8],
        payer_id: u32,
        payee_id: u32,
        amount: u64,
    ) -> Result<u64> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        require!(
            ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        let locked_balance = ParticipantBucket::read_u64_at(
            data,
            lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
            VaultError::MathOverflow,
        )?;
        let next_locked_balance = locked_balance
            .checked_add(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        ParticipantBucket::write_u64_at(
            data,
            lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
            next_locked_balance,
            VaultError::MathOverflow,
        )?;
        Ok(next_locked_balance)
    }

    pub fn request_lane_unlock_in_data(
        data: &mut [u8],
        payer_id: u32,
        payee_id: u32,
        amount: u64,
        requested_at: i64,
    ) -> Result<()> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        require!(
            ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        let locked_balance = ParticipantBucket::read_u64_at(
            data,
            lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
            VaultError::InsufficientLockedBalance,
        )?;
        require!(
            amount <= locked_balance,
            VaultError::InsufficientLockedBalance
        );
        ParticipantBucket::write_u64_at(
            data,
            lane_offset + Self::LANE_PENDING_UNLOCK_AMOUNT_OFFSET,
            amount,
            VaultError::MathOverflow,
        )?;
        ParticipantBucket::write_i64_at(
            data,
            lane_offset + Self::LANE_UNLOCK_REQUESTED_AT_OFFSET,
            requested_at,
            VaultError::MathOverflow,
        )
    }

    pub fn execute_lane_unlock_in_data(
        data: &mut [u8],
        payer_id: u32,
        payee_id: u32,
    ) -> Result<(u64, u64)> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        require!(
            ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        let pending_unlock_amount = ParticipantBucket::read_u64_at(
            data,
            lane_offset + Self::LANE_PENDING_UNLOCK_AMOUNT_OFFSET,
            VaultError::NoChannelUnlockPending,
        )?;
        let unlock_requested_at = ParticipantBucket::read_i64_at(
            data,
            lane_offset + Self::LANE_UNLOCK_REQUESTED_AT_OFFSET,
            VaultError::NoChannelUnlockPending,
        )?;
        require!(
            pending_unlock_amount > 0 && unlock_requested_at != 0,
            VaultError::NoChannelUnlockPending
        );
        let locked_balance = ParticipantBucket::read_u64_at(
            data,
            lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
            VaultError::MathOverflow,
        )?;
        let released_amount = pending_unlock_amount.min(locked_balance);
        let remaining_locked = locked_balance
            .checked_sub(released_amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        ParticipantBucket::write_u64_at(
            data,
            lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
            remaining_locked,
            VaultError::MathOverflow,
        )?;
        ParticipantBucket::write_u64_at(
            data,
            lane_offset + Self::LANE_PENDING_UNLOCK_AMOUNT_OFFSET,
            0,
            VaultError::MathOverflow,
        )?;
        ParticipantBucket::write_i64_at(
            data,
            lane_offset + Self::LANE_UNLOCK_REQUESTED_AT_OFFSET,
            0,
            VaultError::MathOverflow,
        )?;
        Ok((released_amount, remaining_locked))
    }

    pub fn cooperative_unlock_lane_in_data(
        data: &mut [u8],
        payer_id: u32,
        payee_id: u32,
        amount: u64,
    ) -> Result<(u64, u64)> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        require!(
            ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        let locked_balance = ParticipantBucket::read_u64_at(
            data,
            lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
            VaultError::InsufficientLockedBalance,
        )?;
        require!(
            amount <= locked_balance,
            VaultError::InsufficientLockedBalance
        );

        let remaining_locked = locked_balance
            .checked_sub(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        ParticipantBucket::write_u64_at(
            data,
            lane_offset + Self::LANE_LOCKED_BALANCE_OFFSET,
            remaining_locked,
            VaultError::MathOverflow,
        )?;

        Self::cap_pending_unlock_at_lane_offset_in_data(data, lane_offset, remaining_locked)?;

        Ok((amount, remaining_locked))
    }

    pub fn request_authorized_signer_update_in_data(
        data: &mut [u8],
        payer_id: u32,
        payee_id: u32,
        new_signer: Pubkey,
        requested_at: i64,
    ) -> Result<Pubkey> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        require!(
            ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        let current_authorized_signer = ParticipantBucket::read_pubkey_at(
            data,
            lane_offset + Self::LANE_AUTHORIZED_SIGNER_OFFSET,
            VaultError::ChannelNotInitialized,
        )?;
        require!(
            new_signer != Pubkey::default() && new_signer != current_authorized_signer,
            VaultError::InvalidAuthorizedSigner
        );
        ParticipantBucket::write_pubkey_at(
            data,
            lane_offset + Self::LANE_PENDING_AUTHORIZED_SIGNER_OFFSET,
            new_signer,
            VaultError::InvalidAuthorizedSigner,
        )?;
        ParticipantBucket::write_i64_at(
            data,
            lane_offset + Self::LANE_AUTHORIZED_SIGNER_UPDATE_REQUESTED_AT_OFFSET,
            requested_at,
            VaultError::MathOverflow,
        )?;
        Ok(current_authorized_signer)
    }

    pub fn execute_authorized_signer_update_in_data(
        data: &mut [u8],
        payer_id: u32,
        payee_id: u32,
    ) -> Result<(Pubkey, Pubkey)> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        let slot_offset =
            Self::slot_offset_for_pair(data, lower_participant_id, higher_participant_id)?;
        let lane_offset = slot_offset + Self::lane_offset(selector);
        require!(
            ParticipantBucket::read_bool_at(
                data,
                lane_offset + Self::LANE_INITIALIZED_OFFSET,
                VaultError::ChannelNotInitialized,
            )?,
            VaultError::ChannelNotInitialized
        );
        let previous_authorized_signer = ParticipantBucket::read_pubkey_at(
            data,
            lane_offset + Self::LANE_AUTHORIZED_SIGNER_OFFSET,
            VaultError::ChannelNotInitialized,
        )?;
        let new_authorized_signer = ParticipantBucket::read_pubkey_at(
            data,
            lane_offset + Self::LANE_PENDING_AUTHORIZED_SIGNER_OFFSET,
            VaultError::NoAuthorizedSignerUpdatePending,
        )?;
        let update_requested_at = ParticipantBucket::read_i64_at(
            data,
            lane_offset + Self::LANE_AUTHORIZED_SIGNER_UPDATE_REQUESTED_AT_OFFSET,
            VaultError::NoAuthorizedSignerUpdatePending,
        )?;
        require!(
            new_authorized_signer != Pubkey::default() && update_requested_at != 0,
            VaultError::NoAuthorizedSignerUpdatePending
        );
        ParticipantBucket::write_pubkey_at(
            data,
            lane_offset + Self::LANE_AUTHORIZED_SIGNER_OFFSET,
            new_authorized_signer,
            VaultError::InvalidAuthorizedSigner,
        )?;
        ParticipantBucket::write_pubkey_at(
            data,
            lane_offset + Self::LANE_PENDING_AUTHORIZED_SIGNER_OFFSET,
            Pubkey::default(),
            VaultError::InvalidAuthorizedSigner,
        )?;
        ParticipantBucket::write_i64_at(
            data,
            lane_offset + Self::LANE_AUTHORIZED_SIGNER_UPDATE_REQUESTED_AT_OFFSET,
            0,
            VaultError::MathOverflow,
        )?;
        Ok((previous_authorized_signer, new_authorized_signer))
    }

    pub fn verify_account_info(
        account_info: &AccountInfo,
        token_id: u16,
        bucket_id: u64,
        program_id: &Pubkey,
    ) -> Result<()> {
        require!(
            account_info.owner == program_id,
            VaultError::BucketAccountMismatch
        );
        let data = account_info.try_borrow_data()?;
        let (actual_token_id, actual_bucket_id, bump) =
            Self::read_token_bucket_and_bump(data.as_ref())?;
        require!(actual_token_id == token_id, VaultError::InvalidTokenMint);
        require!(
            actual_bucket_id == bucket_id,
            VaultError::BucketAccountMismatch
        );
        Self::verify_expected_pda(
            account_info.key,
            actual_token_id,
            actual_bucket_id,
            bump,
            program_id,
        )
    }

    pub fn canonicalize(payer_id: u32, payee_id: u32) -> Result<(u32, u32, LaneSelector)> {
        require!(payer_id != payee_id, VaultError::SelfChannelNotAllowed);
        if payer_id < payee_id {
            Ok((payer_id, payee_id, LaneSelector::LowerToHigher))
        } else {
            Ok((payee_id, payer_id, LaneSelector::HigherToLower))
        }
    }

    pub fn pair_ordinal(lower_participant_id: u32, higher_participant_id: u32) -> Result<u64> {
        require!(
            lower_participant_id < higher_participant_id,
            VaultError::SelfChannelNotAllowed
        );
        let higher = higher_participant_id as u64;
        let lower = lower_participant_id as u64;
        higher
            .checked_mul(
                higher
                    .checked_sub(1)
                    .ok_or(error!(VaultError::MathOverflow))?,
            )
            .and_then(|value| value.checked_div(2))
            .and_then(|value| value.checked_add(lower))
            .ok_or(error!(VaultError::MathOverflow))
    }

    pub fn bucket_id_for_pair(
        lower_participant_id: u32,
        higher_participant_id: u32,
    ) -> Result<u64> {
        Ok(
            Self::pair_ordinal(lower_participant_id, higher_participant_id)?
                / CHANNEL_BUCKET_SLOT_COUNT as u64,
        )
    }

    pub fn slot_index_for_pair(
        lower_participant_id: u32,
        higher_participant_id: u32,
    ) -> Result<usize> {
        Ok(
            (Self::pair_ordinal(lower_participant_id, higher_participant_id)?
                % CHANNEL_BUCKET_SLOT_COUNT as u64) as usize,
        )
    }

    pub fn initialize_if_needed(&mut self, token_id: u16, bucket_id: u64, bump: u8) -> Result<()> {
        if self.slots.iter().all(|slot| !slot.initialized) {
            self.token_id = token_id;
            self.bucket_id = bucket_id;
            self.bump = bump;
            self.slots = [ChannelBucketSlot::empty(); CHANNEL_BUCKET_SLOT_COUNT];
            return Ok(());
        }
        require!(self.token_id == token_id, VaultError::InvalidTokenMint);
        require!(
            self.bucket_id == bucket_id,
            VaultError::BucketAccountMismatch
        );
        require!(self.bump == bump, VaultError::BucketAccountMismatch);
        Ok(())
    }

    pub fn verify_expected_pda(
        account_key: &Pubkey,
        token_id: u16,
        bucket_id: u64,
        bump: u8,
        program_id: &Pubkey,
    ) -> Result<()> {
        let token_bytes = token_id.to_le_bytes();
        let bucket_bytes = bucket_id.to_le_bytes();
        let expected_pda = Pubkey::create_program_address(
            &[
                Self::SEED_PREFIX,
                token_bytes.as_ref(),
                bucket_bytes.as_ref(),
                &[bump],
            ],
            program_id,
        )
        .map_err(|_| error!(VaultError::BucketAccountMismatch))?;
        require!(
            *account_key == expected_pda,
            VaultError::BucketAccountMismatch
        );
        Ok(())
    }

    pub fn verify_bucket_for_lane(
        &self,
        account_key: &Pubkey,
        token_id: u16,
        payer_id: u32,
        payee_id: u32,
        program_id: &Pubkey,
    ) -> Result<(u32, u32, LaneSelector)> {
        let (lower_participant_id, higher_participant_id, selector) =
            Self::canonicalize(payer_id, payee_id)?;
        Self::verify_expected_pda(
            account_key,
            token_id,
            Self::bucket_id_for_pair(lower_participant_id, higher_participant_id)?,
            self.bump,
            program_id,
        )?;
        require!(self.token_id == token_id, VaultError::InvalidTokenMint);
        self.slot(lower_participant_id, higher_participant_id)
            .map(|_| ())?;
        Ok((lower_participant_id, higher_participant_id, selector))
    }

    pub fn slot(
        &self,
        lower_participant_id: u32,
        higher_participant_id: u32,
    ) -> Result<&ChannelBucketSlot> {
        let bucket_id = Self::bucket_id_for_pair(lower_participant_id, higher_participant_id)?;
        require!(
            self.bucket_id == bucket_id,
            VaultError::BucketAccountMismatch
        );
        let index = Self::slot_index_for_pair(lower_participant_id, higher_participant_id)?;
        let slot = self
            .slots
            .get(index)
            .ok_or(error!(VaultError::BucketSlotMismatch))?;
        require!(slot.initialized, VaultError::ChannelNotInitialized);
        require!(
            slot.lower_participant_id == lower_participant_id
                && slot.higher_participant_id == higher_participant_id,
            VaultError::BucketSlotMismatch
        );
        Ok(slot)
    }

    pub fn slot_mut(
        &mut self,
        lower_participant_id: u32,
        higher_participant_id: u32,
    ) -> Result<&mut ChannelBucketSlot> {
        let bucket_id = Self::bucket_id_for_pair(lower_participant_id, higher_participant_id)?;
        require!(
            self.bucket_id == bucket_id,
            VaultError::BucketAccountMismatch
        );
        let index = Self::slot_index_for_pair(lower_participant_id, higher_participant_id)?;
        let slot = self
            .slots
            .get_mut(index)
            .ok_or(error!(VaultError::BucketSlotMismatch))?;
        require!(slot.initialized, VaultError::ChannelNotInitialized);
        require!(
            slot.lower_participant_id == lower_participant_id
                && slot.higher_participant_id == higher_participant_id,
            VaultError::BucketSlotMismatch
        );
        Ok(slot)
    }

    pub fn get_or_initialize_slot_mut(
        &mut self,
        lower_participant_id: u32,
        higher_participant_id: u32,
    ) -> Result<&mut ChannelBucketSlot> {
        let bucket_id = Self::bucket_id_for_pair(lower_participant_id, higher_participant_id)?;
        require!(
            self.bucket_id == bucket_id,
            VaultError::BucketAccountMismatch
        );
        let index = Self::slot_index_for_pair(lower_participant_id, higher_participant_id)?;
        let slot = self
            .slots
            .get_mut(index)
            .ok_or(error!(VaultError::BucketSlotMismatch))?;
        if !slot.initialized {
            slot.initialize_pair(lower_participant_id, higher_participant_id);
        }
        require!(
            slot.lower_participant_id == lower_participant_id
                && slot.higher_participant_id == higher_participant_id,
            VaultError::BucketSlotMismatch
        );
        Ok(slot)
    }

    pub fn resolve_lane(&self, payer_id: u32, payee_id: u32) -> Result<&DirectionalLaneState> {
        let (lower, higher, selector) = Self::canonicalize(payer_id, payee_id)?;
        Ok(self.slot(lower, higher)?.lane(selector))
    }

    pub fn resolve_lane_mut(
        &mut self,
        payer_id: u32,
        payee_id: u32,
    ) -> Result<&mut DirectionalLaneState> {
        let (lower, higher, selector) = Self::canonicalize(payer_id, payee_id)?;
        Ok(self.slot_mut(lower, higher)?.lane_mut(selector))
    }
}

const MAX_CPI_ACCOUNT_INIT_SPACE: usize = 10_240;
const _: () = assert!(ParticipantBucket::SPACE <= MAX_CPI_ACCOUNT_INIT_SPACE);
const _: () = assert!(ChannelBucket::SPACE <= MAX_CPI_ACCOUNT_INIT_SPACE);
const _: () = assert!(OwnerIndexBucket::SPACE <= MAX_CPI_ACCOUNT_INIT_SPACE);

#[cfg(test)]
mod tests {
    use super::*;

    fn initialized_participant_bucket_data() -> Vec<u8> {
        let mut data = vec![0u8; ParticipantBucket::SPACE];
        ParticipantBucket::initialize_account_data(&mut data, 0, 255).unwrap();
        ParticipantBucket::initialize_slot_in_data(&mut data, 0, Pubkey::new_unique()).unwrap();
        data
    }

    fn initialized_channel_bucket_data() -> Vec<u8> {
        let mut data = vec![0u8; ChannelBucket::SPACE];
        let bucket_id = ChannelBucket::bucket_id_for_pair(1, 2).unwrap();
        ChannelBucket::initialize_account_data(&mut data, 1, bucket_id, 255).unwrap();
        ChannelBucket::initialize_lane_in_data(
            &mut data,
            1,
            1,
            2,
            LaneSelector::LowerToHigher,
            Pubkey::new_unique(),
        )
        .unwrap();
        data
    }

    #[test]
    fn raw_positive_delta_larger_than_u64_is_rejected() {
        let mut data = initialized_participant_bucket_data();
        let too_large = i128::from(u64::MAX) + 1;

        assert!(ParticipantBucket::apply_token_delta_in_data(&mut data, 0, 7, too_large).is_err());
        assert_eq!(
            ParticipantBucket::read_token_total_balance_or_zero_from_data(&data, 0, 7).unwrap(),
            0
        );
    }

    #[test]
    fn raw_negative_delta_larger_than_u64_is_rejected_without_wrapping() {
        let mut data = initialized_participant_bucket_data();
        ParticipantBucket::apply_token_delta_in_data(&mut data, 0, 7, 100).unwrap();
        let too_large = -(i128::from(u64::MAX) + 1);

        assert!(ParticipantBucket::apply_token_delta_in_data(&mut data, 0, 7, too_large).is_err());
        assert_eq!(
            ParticipantBucket::read_token_total_balance_from_data(&data, 0, 7).unwrap(),
            100
        );
    }

    #[test]
    fn cooperative_unlock_releases_locked_balance_and_caps_pending_unlock() {
        let mut data = initialized_channel_bucket_data();
        ChannelBucket::add_lane_locked_balance_in_data(&mut data, 1, 2, 500).unwrap();
        ChannelBucket::request_lane_unlock_in_data(&mut data, 1, 2, 300, 1000).unwrap();

        let (released_amount, remaining_locked) =
            ChannelBucket::cooperative_unlock_lane_in_data(&mut data, 1, 2, 450).unwrap();
        let lane = ChannelBucket::read_resolved_lane_core_from_data(&data, 1, 2).unwrap();

        assert_eq!(released_amount, 450);
        assert_eq!(remaining_locked, 50);
        assert_eq!(lane.locked_balance, 50);
        assert_eq!(lane.pending_unlock_amount, 50);
        assert_eq!(lane.unlock_requested_at, 1000);

        ChannelBucket::cooperative_unlock_lane_in_data(&mut data, 1, 2, 50).unwrap();
        let lane = ChannelBucket::read_resolved_lane_core_from_data(&data, 1, 2).unwrap();

        assert_eq!(lane.locked_balance, 0);
        assert_eq!(lane.pending_unlock_amount, 0);
        assert_eq!(lane.unlock_requested_at, 0);
    }

    #[test]
    fn settlement_caps_pending_unlock_before_future_relocks() {
        let mut data = initialized_channel_bucket_data();
        ChannelBucket::add_lane_locked_balance_in_data(&mut data, 1, 2, 500).unwrap();
        ChannelBucket::request_lane_unlock_in_data(&mut data, 1, 2, 300, 1000).unwrap();

        ChannelBucket::apply_lane_settlement_in_data(&mut data, 1, 2, 400, 400).unwrap();
        let lane = ChannelBucket::read_resolved_lane_core_from_data(&data, 1, 2).unwrap();

        assert_eq!(lane.settled_cumulative, 400);
        assert_eq!(lane.locked_balance, 100);
        assert_eq!(lane.pending_unlock_amount, 100);
        assert_eq!(lane.unlock_requested_at, 1000);

        ChannelBucket::add_lane_locked_balance_in_data(&mut data, 1, 2, 400).unwrap();
        ChannelBucket::execute_lane_unlock_in_data(&mut data, 1, 2).unwrap();
        let lane = ChannelBucket::read_resolved_lane_core_from_data(&data, 1, 2).unwrap();

        assert_eq!(lane.locked_balance, 400);
        assert_eq!(lane.pending_unlock_amount, 0);
        assert_eq!(lane.unlock_requested_at, 0);
    }
}
