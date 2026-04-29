use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::VaultError;
use crate::events::ParticipantInitialized;
use crate::state::{GlobalConfig, OwnerIndexBucket, ParticipantBucket};

pub fn handler(
    ctx: Context<InitializeParticipant>,
    participant_bucket_id: u32,
    owner_index_bucket_id: u32,
) -> Result<()> {
    let config = &mut ctx.accounts.global_config;
    let participant_id = config.next_participant_id;
    let expected_participant_bucket_id =
        ParticipantBucket::bucket_id_for_participant_id(participant_id);
    let expected_owner_index_bucket_id =
        OwnerIndexBucket::bucket_id_for_owner(&ctx.accounts.owner.key());
    require!(
        participant_bucket_id == expected_participant_bucket_id,
        VaultError::BucketAccountMismatch
    );
    require!(
        owner_index_bucket_id == expected_owner_index_bucket_id,
        VaultError::BucketAccountMismatch
    );

    // Transfer registration fee if non-zero
    if config.registration_fee_lamports > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
            ),
            config.registration_fee_lamports,
        )?;
    }

    let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
    if participant_bucket_info.data_is_empty() {
        let rent = Rent::get()?;
        let bucket_id_bytes = participant_bucket_id.to_le_bytes();
        let bump = [ctx.bumps.participant_bucket];
        let signer_seeds: &[&[u8]] = &[
            ParticipantBucket::SEED_PREFIX,
            bucket_id_bytes.as_ref(),
            bump.as_ref(),
        ];
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.owner.to_account_info(),
                    to: participant_bucket_info.clone(),
                },
                &[signer_seeds],
            ),
            rent.minimum_balance(ParticipantBucket::SPACE),
            ParticipantBucket::SPACE as u64,
            ctx.program_id,
        )?;
        let mut participant_bucket_data = participant_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::initialize_account_data(
            participant_bucket_data.as_mut(),
            participant_bucket_id,
            ctx.bumps.participant_bucket,
        )?;
    } else {
        ParticipantBucket::verify_account_info(
            &participant_bucket_info,
            participant_bucket_id,
            ctx.program_id,
        )?;
    }

    ctx.accounts
        .owner_index_bucket
        .initialize_if_needed(owner_index_bucket_id, ctx.bumps.owner_index_bucket)?;

    {
        let mut participant_bucket_data = participant_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::initialize_slot_in_data(
            participant_bucket_data.as_mut(),
            participant_id,
            ctx.accounts.owner.key(),
        )?;
    }
    ctx.accounts
        .owner_index_bucket
        .insert_owner(ctx.accounts.owner.key(), participant_id)?;

    // Increment global counter
    config.next_participant_id = config
        .next_participant_id
        .checked_add(1)
        .ok_or(error!(VaultError::MathOverflow))?;

    emit!(ParticipantInitialized {
        owner: ctx.accounts.owner.key(),
        participant_id,
        registration_fee_lamports: config.registration_fee_lamports,
        inbound_channel_policy: crate::state::InboundChannelPolicy::ConsentRequired as u8,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(participant_bucket_id: u32, owner_index_bucket_id: u32)]
pub struct InitializeParticipant<'info> {
    #[account(
        mut,
        seeds = [GlobalConfig::SEED_PREFIX],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// CHECK: Created or verified manually, then mutated through fixed-offset helpers.
    #[account(
        mut,
        seeds = [
            ParticipantBucket::SEED_PREFIX,
            participant_bucket_id.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub participant_bucket: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        space = OwnerIndexBucket::SPACE,
        seeds = [
            OwnerIndexBucket::SEED_PREFIX,
            owner_index_bucket_id.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub owner_index_bucket: Account<'info, OwnerIndexBucket>,

    #[account(
        mut,
        constraint = fee_recipient.key() == global_config.fee_recipient @ VaultError::InvalidFeeRecipient,
    )]
    pub fee_recipient: SystemAccount<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}
