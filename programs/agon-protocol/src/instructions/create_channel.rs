use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::VaultError;
use crate::events::ChannelCreated;
use crate::state::{
    ChannelBucket, InboundChannelPolicy, OwnerIndexBucket, ParticipantBucket, TokenRegistry,
};

/// Create a channel from payer to payee. Must be called before any payment commitments are signed or settled.
/// Payer signs and pays the ~0.002 SOL rent. Ensures predictable UX: payees and facilitators
/// never pay for channel creation.
pub fn handler(
    ctx: Context<CreateChannel>,
    token_id: u16,
    lower_participant_id: u32,
    higher_participant_id: u32,
    channel_bucket_id: u64,
    authorized_signer: Option<Pubkey>,
) -> Result<()> {
    // Validate token is registered
    ctx.accounts
        .token_registry
        .find_token(token_id)
        .ok_or(VaultError::TokenNotFound)?;

    let payer_owner = ctx.accounts.owner.key();
    let payer_id = ctx
        .accounts
        .owner_index_bucket
        .participant_id_for_verified_owner(
            &ctx.accounts.owner_index_bucket.key(),
            &payer_owner,
            ctx.program_id,
        )?;
    let payer_bucket_info = ctx.accounts.payer_bucket.to_account_info();
    ParticipantBucket::verify_account_info(
        &payer_bucket_info,
        ParticipantBucket::bucket_id_for_participant_id(payer_id),
        ctx.program_id,
    )?;
    let payer_owner = {
        let payer_bucket_data = payer_bucket_info.try_borrow_data()?;
        ParticipantBucket::read_slot_owner_from_data(payer_bucket_data.as_ref(), payer_id)?
    };

    let payee_id = if payer_id == lower_participant_id {
        higher_participant_id
    } else if payer_id == higher_participant_id {
        lower_participant_id
    } else {
        return Err(error!(VaultError::AccountIdMismatch));
    };
    let (expected_lower_participant_id, expected_higher_participant_id, selector) =
        ChannelBucket::canonicalize(payer_id, payee_id)?;
    require!(
        lower_participant_id == expected_lower_participant_id
            && higher_participant_id == expected_higher_participant_id,
        VaultError::AccountIdMismatch
    );
    let payee_bucket_info = ctx.accounts.payee_bucket.to_account_info();
    ParticipantBucket::verify_account_info(
        &payee_bucket_info,
        ParticipantBucket::bucket_id_for_participant_id(payee_id),
        ctx.program_id,
    )?;
    let (payee_owner_key, payee_policy) = {
        let payee_bucket_data = payee_bucket_info.try_borrow_data()?;
        (
            ParticipantBucket::read_slot_owner_from_data(payee_bucket_data.as_ref(), payee_id)?,
            ParticipantBucket::read_inbound_channel_policy_from_data(
                payee_bucket_data.as_ref(),
                payee_id,
            )?,
        )
    };

    if let Some(payee_owner) = ctx.accounts.payee_owner.as_ref() {
        require!(
            payee_owner.key() == payee_owner_key,
            VaultError::InboundChannelConsentRequired
        );
    }

    match payee_policy {
        InboundChannelPolicy::Permissionless => {}
        InboundChannelPolicy::ConsentRequired => {
            require!(
                ctx.accounts
                    .payee_owner
                    .as_ref()
                    .map(|payee_owner| payee_owner.key() == payee_owner_key)
                    .unwrap_or(false),
                VaultError::InboundChannelConsentRequired
            );
        }
        InboundChannelPolicy::Disabled => {
            return Err(error!(VaultError::InboundChannelsDisabled));
        }
    }

    let expected_channel_bucket_id =
        ChannelBucket::bucket_id_for_pair(lower_participant_id, higher_participant_id)?;
    require!(
        channel_bucket_id == expected_channel_bucket_id,
        VaultError::BucketAccountMismatch
    );
    let channel_bucket_info = ctx.accounts.channel_bucket.to_account_info();
    if channel_bucket_info.data_is_empty() {
        let rent = Rent::get()?;
        let token_id_bytes = token_id.to_le_bytes();
        let channel_bucket_id_bytes = channel_bucket_id.to_le_bytes();
        let bump = [ctx.bumps.channel_bucket];
        let signer_seeds: &[&[u8]] = &[
            ChannelBucket::SEED_PREFIX,
            token_id_bytes.as_ref(),
            channel_bucket_id_bytes.as_ref(),
            bump.as_ref(),
        ];
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.owner.to_account_info(),
                    to: channel_bucket_info.clone(),
                },
                &[signer_seeds],
            ),
            rent.minimum_balance(ChannelBucket::SPACE),
            ChannelBucket::SPACE as u64,
            ctx.program_id,
        )?;
        let mut channel_bucket_data = channel_bucket_info.try_borrow_mut_data()?;
        ChannelBucket::initialize_account_data(
            channel_bucket_data.as_mut(),
            token_id,
            channel_bucket_id,
            ctx.bumps.channel_bucket,
        )?;
    } else {
        ChannelBucket::verify_account_info(
            &channel_bucket_info,
            token_id,
            channel_bucket_id,
            ctx.program_id,
        )?;
    }

    {
        let mut channel_bucket_data = channel_bucket_info.try_borrow_mut_data()?;
        ChannelBucket::initialize_lane_in_data(
            channel_bucket_data.as_mut(),
            token_id,
            lower_participant_id,
            higher_participant_id,
            selector,
            authorized_signer.unwrap_or(payer_owner),
        )?;
    }

    emit!(ChannelCreated {
        payer_id,
        payee_id,
        token_id,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(token_id: u16, lower_participant_id: u32, higher_participant_id: u32, channel_bucket_id: u64)]
pub struct CreateChannel<'info> {
    #[account(
        seeds = [TokenRegistry::SEED_PREFIX],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw reads.
    pub payer_bucket: UncheckedAccount<'info>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw reads.
    pub payee_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Account<'info, OwnerIndexBucket>,

    /// CHECK: Created or verified manually, then mutated through fixed-offset helpers.
    #[account(
        mut,
        seeds = [
            ChannelBucket::SEED_PREFIX,
            &token_id.to_le_bytes(),
            channel_bucket_id.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub channel_bucket: UncheckedAccount<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub payee_owner: Option<Signer<'info>>,

    pub system_program: Program<'info, System>,
}
