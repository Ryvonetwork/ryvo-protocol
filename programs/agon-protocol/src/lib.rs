use anchor_lang::prelude::*;

mod balance_deltas;

pub mod bls;
pub mod ed25519;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::cancel_withdrawal::*;
use instructions::cooperative_unlock_channel_funds::*;
use instructions::create_channel::*;
use instructions::deposit::*;
use instructions::deposit_for::*;
use instructions::execute_unlock_channel_funds::*;
use instructions::execute_update_channel_authorized_signer::*;
use instructions::execute_withdrawal_timelocked::*;
use instructions::initialize::*;
use instructions::initialize_participant::*;
use instructions::lock_channel_funds::*;
use instructions::register_participant_bls_key::*;
use instructions::request_unlock_channel_funds::*;
use instructions::request_update_channel_authorized_signer::*;
use instructions::request_withdrawal::*;
use instructions::settle_clearing_round::*;
use instructions::settle_commitment_bundle::*;
use instructions::settle_individual::*;
use instructions::token_registry::*;
use instructions::update_config::*;
use instructions::update_inbound_channel_policy::*;

declare_id!("3UyUFeNsUYPpM6hMRf7H8wg3MKEXQ82rqnsXhZrUwgSD");

#[cfg(feature = "custom-heap")]
solana_allocator::custom_heap!();

#[program]
pub mod agon_protocol {
    use super::*;

    /// Initialize the protocol: creates GlobalConfig PDA.
    /// `chain_id` selects the immutable settlement domain and default timing policy.
    pub fn initialize(
        ctx: Context<Initialize>,
        chain_id: u16,
        fee_bps: u16,
        registration_fee_lamports: u64,
        initial_authority: Option<Pubkey>,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            chain_id,
            fee_bps,
            registration_fee_lamports,
            initial_authority,
        )
    }

    /// Update protocol configuration (authority only).
    /// Settlement chain_id and default timing policies are immutable and cannot be changed.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_authority: Option<Pubkey>,
        new_fee_recipient: Option<Pubkey>,
        new_fee_bps: Option<u16>,
        new_registration_fee_lamports: Option<u64>,
    ) -> Result<()> {
        instructions::update_config::handler(
            ctx,
            new_authority,
            new_fee_recipient,
            new_fee_bps,
            new_registration_fee_lamports,
        )
    }

    /// Pending config authority accepts the handoff.
    pub fn accept_config_authority(ctx: Context<AcceptConfigAuthority>) -> Result<()> {
        instructions::update_config::accept_config_authority(ctx)
    }

    /// One-time participant registration.
    pub fn initialize_participant(
        ctx: Context<InitializeParticipant>,
        participant_bucket_id: u32,
        owner_index_bucket_id: u32,
    ) -> Result<()> {
        instructions::initialize_participant::handler(
            ctx,
            participant_bucket_id,
            owner_index_bucket_id,
        )
    }

    /// Register a BLS key used only for cooperative clearing rounds.
    pub fn register_participant_bls_key(
        ctx: Context<RegisterParticipantBlsKey>,
        bls_pubkey_compressed: [u8; 96],
        pop_signature_compressed: [u8; 48],
    ) -> Result<()> {
        instructions::register_participant_bls_key::handler(
            ctx,
            bls_pubkey_compressed,
            pop_signature_compressed,
        )
    }

    /// Update the participant's inbound channel policy.
    pub fn update_inbound_channel_policy(
        ctx: Context<UpdateInboundChannelPolicy>,
        inbound_channel_policy: u8,
    ) -> Result<()> {
        instructions::update_inbound_channel_policy::handler(ctx, inbound_channel_policy)
    }

    /// Deposit tokens into the vault (credits signer's vault).
    pub fn deposit(ctx: Context<Deposit>, token_id: u16, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, token_id, amount)
    }

    /// Deposit a registered token for multiple participants in one tx.
    /// Funder's ATA to vault; credits each recipient.
    /// amounts.len() must equal remaining participant bucket slots. Max 16 recipients.
    pub fn deposit_for(
        ctx: Context<DepositFor>,
        token_id: u16,
        participant_ids: Vec<u32>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        instructions::deposit_for::handler(ctx, token_id, participant_ids, amounts)
    }

    /// Request a timelocked withdrawal for a specific token.
    pub fn request_withdrawal(
        ctx: Context<RequestWithdrawal>,
        token_id: u16,
        amount: u64,
        destination: Pubkey,
    ) -> Result<()> {
        instructions::request_withdrawal::handler(ctx, token_id, amount, destination)
    }

    /// Cancel a pending withdrawal for a specific token.
    pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>, token_id: u16) -> Result<()> {
        instructions::cancel_withdrawal::handler(ctx, token_id)
    }

    /// Execute a withdrawal for a specific token after timelock expires.
    pub fn execute_withdrawal_timelocked(
        ctx: Context<ExecuteWithdrawalTimelocked>,
        token_id: u16,
        participant_id: u32,
    ) -> Result<()> {
        instructions::execute_withdrawal_timelocked::handler(ctx, token_id, participant_id)
    }

    /// Create a token-specific channel from payer to payee. Must be called before any payment commitments are signed or settled.
    /// Payer signs and pays ~0.002 SOL rent. Ensures payees and facilitators never pay for creation.
    pub fn create_channel(
        ctx: Context<CreateChannel>,
        token_id: u16,
        lower_participant_id: u32,
        higher_participant_id: u32,
        channel_bucket_id: u64,
        authorized_signer: Option<Pubkey>,
    ) -> Result<()> {
        instructions::create_channel::handler(
            ctx,
            token_id,
            lower_participant_id,
            higher_participant_id,
            channel_bucket_id,
            authorized_signer,
        )
    }

    /// Request a timelocked partial unlock of channel collateral.
    pub fn request_unlock_channel_funds(
        ctx: Context<RequestUnlockChannelFunds>,
        token_id: u16,
        payee_participant_id: u32,
        amount: u64,
    ) -> Result<()> {
        instructions::request_unlock_channel_funds::handler(
            ctx,
            token_id,
            payee_participant_id,
            amount,
        )
    }

    /// Execute a previously requested collateral unlock once its timelock expires.
    pub fn execute_unlock_channel_funds(
        ctx: Context<ExecuteUnlockChannelFunds>,
        token_id: u16,
        payee_participant_id: u32,
    ) -> Result<()> {
        instructions::execute_unlock_channel_funds::handler(ctx, token_id, payee_participant_id)
    }

    /// Instantly release channel collateral when both channel counterparties consent.
    pub fn cooperative_unlock_channel_funds(
        ctx: Context<CooperativeUnlockChannelFunds>,
        token_id: u16,
        payee_participant_id: u32,
        amount: u64,
    ) -> Result<()> {
        instructions::cooperative_unlock_channel_funds::handler(
            ctx,
            token_id,
            payee_participant_id,
            amount,
        )
    }

    /// Request a timelocked rotation of the channel's authorized signer.
    pub fn request_update_channel_authorized_signer(
        ctx: Context<RequestUpdateChannelAuthorizedSigner>,
        token_id: u16,
        payee_participant_id: u32,
        new_signer: Pubkey,
    ) -> Result<()> {
        instructions::request_update_channel_authorized_signer::handler(
            ctx,
            token_id,
            payee_participant_id,
            new_signer,
        )
    }

    /// Execute a previously requested authorized-signer rotation once its timelock expires.
    pub fn execute_update_channel_authorized_signer(
        ctx: Context<ExecuteUpdateChannelAuthorizedSigner>,
        token_id: u16,
        payee_participant_id: u32,
    ) -> Result<()> {
        instructions::execute_update_channel_authorized_signer::handler(
            ctx,
            token_id,
            payee_participant_id,
        )
    }

    /// Lock tokens as ring-fenced collateral for a specific payee channel.
    pub fn lock_channel_funds(
        ctx: Context<LockChannelFunds>,
        token_id: u16,
        payee_participant_id: u32,
        amount: u64,
    ) -> Result<()> {
        instructions::lock_channel_funds::handler(ctx, token_id, payee_participant_id, amount)
    }

    /// Settle a single payment commitment. Submitter must be the payee or an authorized settler.
    pub fn settle_individual(ctx: Context<SettleIndividual>) -> Result<()> {
        instructions::settle_individual::handler(ctx)
    }

    /// Settle many latest commitments for one payee across many unilateral channels.
    pub fn settle_commitment_bundle<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleCommitmentBundle<'info>>,
        count: u8,
    ) -> Result<()> {
        instructions::settle_commitment_bundle::handler(ctx, count)
    }

    /// BLS-authenticated cooperative clearing round: advances many logical channels and applies
    /// only net participant balance changes through bucket accounts.
    pub fn settle_clearing_round<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleClearingRound<'info>>,
        message: Vec<u8>,
        aggregate_signature_compressed: [u8; 48],
    ) -> Result<()> {
        instructions::settle_clearing_round::handler(ctx, message, aggregate_signature_compressed)
    }

    /// Initialize the token registry (authority only, called once after program deployment).
    pub fn initialize_token_registry(ctx: Context<InitializeTokenRegistry>) -> Result<()> {
        instructions::token_registry::initialize_token_registry(ctx)
    }

    /// Register a new token in the registry (authority only).
    pub fn register_token(
        ctx: Context<RegisterToken>,
        token_id: u16,
        symbol_bytes: [u8; 8],
    ) -> Result<()> {
        instructions::token_registry::register_token(ctx, token_id, symbol_bytes)
    }

    /// Nominate a pending token registry authority.
    pub fn update_registry_authority(
        ctx: Context<UpdateRegistryAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::token_registry::update_registry_authority(ctx, new_authority)
    }

    /// Pending token registry authority accepts the handoff.
    pub fn accept_registry_authority(ctx: Context<AcceptRegistryAuthority>) -> Result<()> {
        instructions::token_registry::accept_registry_authority(ctx)
    }
}
