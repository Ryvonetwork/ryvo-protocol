use anchor_lang::prelude::*;

use crate::events::WithdrawalCancelled;
use crate::state::{OwnerIndexBucket, ParticipantBucket};

pub fn handler(ctx: Context<CancelWithdrawal>, token_id: u16) -> Result<()> {
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
    let amount_returned = {
        let participant_bucket_info = ctx.accounts.participant_bucket.to_account_info();
        let mut participant_bucket_data = participant_bucket_info.try_borrow_mut_data()?;
        ParticipantBucket::cancel_token_withdrawal_in_data(
            participant_bucket_data.as_mut(),
            participant_id,
            token_id,
        )?
    };

    emit!(WithdrawalCancelled {
        participant_id,
        token_id,
        amount_returned,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelWithdrawal<'info> {
    /// CHECK: Verified with ParticipantBucket::verify_account_info before raw withdrawal mutation.
    #[account(mut)]
    pub participant_bucket: UncheckedAccount<'info>,

    pub owner_index_bucket: Account<'info, OwnerIndexBucket>,

    pub owner: Signer<'info>,
}
