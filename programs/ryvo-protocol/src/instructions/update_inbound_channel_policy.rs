use anchor_lang::prelude::*;

use crate::events::InboundChannelPolicyUpdated;
use crate::state::{InboundChannelPolicy, OwnerIndexBucket, ParticipantBucket};

pub fn handler(ctx: Context<UpdateInboundChannelPolicy>, inbound_channel_policy: u8) -> Result<()> {
    let policy = InboundChannelPolicy::try_from(inbound_channel_policy)?;
    let owner = ctx.accounts.owner.key();
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
    {
        let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
        let mut participant_bucket_data = participant_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::write_inbound_channel_policy_in_data(
            participant_bucket_data.as_mut(),
            participant_id,
            policy,
        )?;
    }

    emit!(InboundChannelPolicyUpdated {
        participant_id,
        inbound_channel_policy,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateInboundChannelPolicy<'info> {
    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw policy mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Account<'info, OwnerIndexBucket>,

    pub owner: Signer<'info>,
}
