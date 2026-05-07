use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::state::GlobalConfig;

pub const CLEARING_ROUND_MESSAGE_KIND: u8 = 0x02;
pub const CLEARING_ROUND_MESSAGE_VERSION: u8 = 0x04;
pub const CLEARING_ROUND_FIXED_HEADER_SIZE: usize = 21;

#[derive(Debug)]
pub(crate) struct ParticipantBlockMeta {
    pub(crate) participant_id: u32,
    pub(crate) entry_count: u8,
    pub(crate) entries_offset: usize,
}

#[derive(Debug)]
pub(crate) struct ChannelEntry {
    pub(crate) payee_ref: u8,
    pub(crate) target_cumulative: u64,
}

#[derive(Debug)]
pub(crate) struct ParsedClearingRoundLayout {
    pub(crate) token_id: u16,
    pub(crate) blocks: Vec<ParticipantBlockMeta>,
    pub(crate) channel_count: usize,
}

pub(crate) fn read_varint_u64(msg: &[u8], offset: &mut usize) -> Result<u64> {
    let mut shift = 0u32;
    let mut value = 0u64;

    loop {
        require!(*offset < msg.len(), VaultError::InvalidClearingRoundMessage);
        let byte = msg[*offset];
        *offset += 1;

        let chunk = (byte & 0x7f) as u64;
        if shift == 63 {
            require!(chunk <= 1, VaultError::InvalidClearingRoundMessage);
        }
        value |= chunk
            .checked_shl(shift)
            .ok_or(error!(VaultError::InvalidClearingRoundMessage))?;

        if (byte & 0x80) == 0 {
            return Ok(value);
        }

        shift = shift
            .checked_add(7)
            .ok_or(error!(VaultError::InvalidClearingRoundMessage))?;
        require!(shift < 64, VaultError::InvalidClearingRoundMessage);
    }
}

pub(crate) fn read_varint_u32(msg: &[u8], offset: &mut usize) -> Result<u32> {
    let value = read_varint_u64(msg, offset)?;
    require!(
        value <= u32::MAX as u64,
        VaultError::InvalidClearingRoundMessage
    );
    Ok(value as u32)
}

pub(crate) fn parse_clearing_round_header_with_version(
    msg: &[u8],
    global_config: &GlobalConfig,
    expected_version: u8,
) -> Result<(u16, u8, usize)> {
    require!(
        msg.len() >= CLEARING_ROUND_FIXED_HEADER_SIZE,
        VaultError::InvalidClearingRoundMessage
    );
    require!(
        msg[0] == CLEARING_ROUND_MESSAGE_KIND && msg[1] == expected_version,
        VaultError::InvalidClearingRoundMessage
    );
    require!(
        msg[2..18] == global_config.message_domain,
        VaultError::InvalidMessageDomain
    );

    let token_id = u16::from_le_bytes(msg[18..20].try_into().unwrap());
    let participant_count = msg[20];
    require!(
        participant_count > 0,
        VaultError::InvalidClearingRoundMessage
    );

    Ok((
        token_id,
        participant_count,
        CLEARING_ROUND_FIXED_HEADER_SIZE,
    ))
}

pub(crate) fn parse_channel_entry(msg: &[u8], offset: &mut usize) -> Result<ChannelEntry> {
    require!(*offset < msg.len(), VaultError::InvalidClearingRoundMessage);
    let payee_ref = msg[*offset];
    *offset += 1;
    let target_cumulative = read_varint_u64(msg, offset)?;

    Ok(ChannelEntry {
        payee_ref,
        target_cumulative,
    })
}

pub(crate) fn parse_clearing_round_layout_with_version(
    msg: &[u8],
    global_config: &GlobalConfig,
    expected_version: u8,
) -> Result<ParsedClearingRoundLayout> {
    let (token_id, participant_count, mut offset) =
        parse_clearing_round_header_with_version(msg, global_config, expected_version)?;
    let mut blocks = Vec::with_capacity(participant_count as usize);
    let mut channel_count = 0usize;

    for _ in 0..participant_count {
        let participant_id = read_varint_u32(msg, &mut offset)?;
        require!(offset < msg.len(), VaultError::InvalidClearingRoundMessage);
        let entry_count = msg[offset];
        offset += 1;
        let entries_offset = offset;

        for _ in 0..entry_count {
            let _ = parse_channel_entry(msg, &mut offset)?;
            channel_count += 1;
        }

        blocks.push(ParticipantBlockMeta {
            participant_id,
            entry_count,
            entries_offset,
        });
    }

    require!(offset == msg.len(), VaultError::InvalidClearingRoundMessage);
    Ok(ParsedClearingRoundLayout {
        token_id,
        blocks,
        channel_count,
    })
}

#[cfg(test)]
fn parse_clearing_round_layout(
    msg: &[u8],
    global_config: &GlobalConfig,
) -> Result<ParsedClearingRoundLayout> {
    parse_clearing_round_layout_with_version(msg, global_config, CLEARING_ROUND_MESSAGE_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::GlobalConfig;
    use proptest::prelude::*;
    use std::collections::{BTreeMap, BTreeSet};

    fn add_position(
        positions: &mut Vec<(u32, i128)>,
        participant_id: u32,
        delta: i128,
    ) -> Result<()> {
        if let Some((_, amount)) = positions
            .iter_mut()
            .find(|(candidate_id, _)| *candidate_id == participant_id)
        {
            *amount = amount
                .checked_add(delta)
                .ok_or(error!(VaultError::NetPositionOverflow))?;
            return Ok(());
        }

        positions.push((participant_id, delta));
        Ok(())
    }

    fn test_global_config(message_domain: [u8; 16]) -> GlobalConfig {
        GlobalConfig {
            authority: Pubkey::default(),
            fee_recipient: Pubkey::default(),
            fee_bps: 0,
            withdrawal_timelock_seconds: 0,
            channel_unlock_timelock_seconds: 0,
            registration_fee_lamports: 0,
            next_participant_id: 1,
            bump: 0,
            chain_id: GlobalConfig::DEVNET_CHAIN_ID,
            message_domain,
            pending_authority: Pubkey::default(),
            _reserved: [0u8; 6],
        }
    }

    fn encode_varint_u64(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value > 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
        out
    }

    fn encode_varint_u32(value: u32) -> Vec<u8> {
        encode_varint_u64(value as u64)
    }

    fn build_clearing_round_message_bytes(
        message_domain: [u8; 16],
        token_id: u16,
        blocks: &[(u32, Vec<(u8, u64)>)],
    ) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(CLEARING_ROUND_MESSAGE_KIND);
        out.push(CLEARING_ROUND_MESSAGE_VERSION);
        out.extend_from_slice(&message_domain);
        out.extend_from_slice(&token_id.to_le_bytes());
        out.push(blocks.len() as u8);
        for (participant_id, entries) in blocks {
            out.extend_from_slice(&encode_varint_u32(*participant_id));
            out.push(entries.len() as u8);
            for (payee_ref, target_cumulative) in entries {
                out.push(*payee_ref);
                out.extend_from_slice(&encode_varint_u64(*target_cumulative));
            }
        }
        out
    }

    #[test]
    fn clearing_round_header_rejects_zero_participants() {
        let message_domain = [7u8; 16];
        let global_config = test_global_config(message_domain);
        let message = vec![
            CLEARING_ROUND_MESSAGE_KIND,
            CLEARING_ROUND_MESSAGE_VERSION,
            message_domain[0],
            message_domain[1],
            message_domain[2],
            message_domain[3],
            message_domain[4],
            message_domain[5],
            message_domain[6],
            message_domain[7],
            message_domain[8],
            message_domain[9],
            message_domain[10],
            message_domain[11],
            message_domain[12],
            message_domain[13],
            message_domain[14],
            message_domain[15],
            1,
            0,
            0,
        ];
        let err = parse_clearing_round_layout(&message, &global_config).unwrap_err();
        assert_eq!(err, error!(VaultError::InvalidClearingRoundMessage));
    }

    proptest! {
        #[test]
        fn clearing_round_layout_round_trips_random_v4_blocks(
            participant_count in 1usize..=10,
            token_id in any::<u16>(),
            message_domain in prop::array::uniform16(any::<u8>()),
        ) {
            let mut blocks = Vec::with_capacity(participant_count);
            let mut unique_ids = BTreeSet::new();
            for idx in 0..participant_count {
                unique_ids.insert((idx as u32) * 3 + 1);
            }
            let participant_ids: Vec<u32> = unique_ids.into_iter().collect();
            for (idx, participant_id) in participant_ids.iter().enumerate() {
                let entry_count = (idx % 4) + 1;
                let mut entries = Vec::with_capacity(entry_count);
                for entry_idx in 0..entry_count {
                    let payee_ref = ((idx + entry_idx + 1) % participant_count) as u8;
                    let target_cumulative = ((idx + 1) as u64) * 100 + entry_idx as u64 + 1;
                    entries.push((payee_ref, target_cumulative));
                }
                blocks.push((*participant_id, entries));
            }

            let message = build_clearing_round_message_bytes(message_domain, token_id, &blocks);
            let parsed = parse_clearing_round_layout(&message, &test_global_config(message_domain))
                .expect("parser should accept generated message");

            prop_assert_eq!(parsed.token_id, token_id);
            prop_assert_eq!(parsed.blocks.len(), participant_count);

            for (idx, block_meta) in parsed.blocks.iter().enumerate() {
                prop_assert_eq!(block_meta.participant_id, blocks[idx].0);
                prop_assert_eq!(block_meta.entry_count as usize, blocks[idx].1.len());

                let mut cursor = block_meta.entries_offset;
                let mut recovered = Vec::with_capacity(blocks[idx].1.len());
                for _ in 0..block_meta.entry_count {
                    let entry = parse_channel_entry(&message, &mut cursor)
                        .expect("entry should parse");
                    recovered.push((entry.payee_ref, entry.target_cumulative));
                }
                prop_assert_eq!(recovered, blocks[idx].1.clone());
            }
        }

        #[test]
        fn clearing_round_position_aggregation_matches_naive_netting(
            participant_count in 2usize..=8,
            message_domain in prop::array::uniform16(any::<u8>()),
        ) {
            let token_id = 17u16;
            let participant_ids: Vec<u32> = (0..participant_count).map(|idx| idx as u32 + 10).collect();
            let mut blocks = Vec::with_capacity(participant_count);
            let mut expected = BTreeMap::<u32, i128>::new();

            for (idx, participant_id) in participant_ids.iter().enumerate() {
                let next_ref = ((idx + 1) % participant_count) as u8;
                let prev_ref = ((idx + participant_count - 1) % participant_count) as u8;
                let first = (idx as u64 + 1) * 50;
                let second = (idx as u64 + 1) * 20;
                blocks.push((*participant_id, vec![(next_ref, first), (prev_ref, second)]));

                *expected.entry(*participant_id).or_default() -= (first + second) as i128;
                *expected.entry(participant_ids[next_ref as usize]).or_default() += first as i128;
                *expected.entry(participant_ids[prev_ref as usize]).or_default() += second as i128;
            }

            let message = build_clearing_round_message_bytes(message_domain, token_id, &blocks);
            let parsed = parse_clearing_round_layout(&message, &test_global_config(message_domain))
                .expect("parser should accept generated message");

            let mut actual_positions = Vec::new();
            let block_ids: Vec<u32> = parsed.blocks.iter().map(|block| block.participant_id).collect();
            for block in &parsed.blocks {
                let mut cursor = block.entries_offset;
                for _ in 0..block.entry_count {
                    let entry = parse_channel_entry(&message, &mut cursor)
                        .expect("entry should parse");
                    let payee_id = block_ids[entry.payee_ref as usize];
                    add_position(&mut actual_positions, block.participant_id, -(entry.target_cumulative as i128))
                        .expect("payer delta should accumulate");
                    add_position(&mut actual_positions, payee_id, entry.target_cumulative as i128)
                        .expect("payee delta should accumulate");
                }
            }

            let actual_map: BTreeMap<u32, i128> = actual_positions.into_iter().collect();
            prop_assert_eq!(actual_map, expected);
        }
    }
}
