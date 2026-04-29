use anchor_lang::prelude::*;

use crate::bls::{verify_pop, BLS_PUBLIC_KEY_COMPRESSED_SIZE, BLS_SIGNATURE_COMPRESSED_SIZE};
use crate::errors::VaultError;
use crate::events::ParticipantBlsKeyRegistered;
use crate::state::{GlobalConfig, OwnerIndexBucket, ParticipantBucket, ParticipantBucketSlot};

pub fn handler(
    ctx: Context<RegisterParticipantBlsKey>,
    bls_pubkey_compressed: [u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
    pop_signature_compressed: [u8; BLS_SIGNATURE_COMPRESSED_SIZE],
) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    let participant_bucket_key = ctx.accounts.participant_bucket.key();
    let participant_id = ctx
        .accounts
        .owner_index_bucket
        .participant_id_for_verified_owner(
            &ctx.accounts.owner_index_bucket.key(),
            &owner,
            ctx.program_id,
        )?;
    ParticipantBucket::verify_account_info(
        &ctx.accounts.participant_bucket.to_account_info(),
        ParticipantBucket::bucket_id_for_participant_id(participant_id),
        ctx.program_id,
    )?;

    verify_pop(
        ctx.accounts.global_config.message_domain,
        participant_id,
        &owner,
        &bls_pubkey_compressed,
        &pop_signature_compressed,
    )?;

    {
        let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
        let participant_bucket_data = participant_bucket_info.try_borrow_data()?;
        let (_, bls_scheme_version, _) =
            ParticipantBucket::read_slot_owner_and_bls_registration_from_data(
                participant_bucket_data.as_ref(),
                participant_id,
            )?;
        require!(
            bls_scheme_version == ParticipantBucketSlot::BLS_SCHEME_VERSION_UNREGISTERED,
            VaultError::ParticipantBlsKeyAlreadyRegistered
        );
    }
    let scheme_version = ParticipantBucketSlot::BLS_SCHEME_VERSION_V1;
    {
        let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
        let mut participant_bucket_data = participant_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::write_bls_registration_in_data(
            participant_bucket_data.as_mut(),
            participant_id,
            scheme_version,
            &bls_pubkey_compressed,
        )?;
    }

    emit!(ParticipantBlsKeyRegistered {
        owner,
        participant_id,
        participant_bucket: participant_bucket_key,
        scheme_version,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RegisterParticipantBlsKey<'info> {
    #[account(
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw slot mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Account<'info, OwnerIndexBucket>,

    #[account(mut)]
    pub owner: Signer<'info>,
}
