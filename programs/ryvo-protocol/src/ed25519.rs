use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ixs_sysvar;

use crate::errors::VaultError;

/// Ed25519 precompile program ID (Ed25519SigVerify111111111111111111111111111)
pub const ED25519_PROGRAM_ID: anchor_lang::solana_program::pubkey::Pubkey =
    anchor_lang::solana_program::pubkey::Pubkey::new_from_array([
        3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73,
        39, 244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
    ]);

/// Parsed Ed25519 signature data from the Ed25519 precompile instruction.
/// Adapted from Circle's gateway-wallet pattern.
///
/// The Ed25519 precompile instruction data layout per signature:
///   - [0]      num_signatures (u8)
///   - [1]      padding
///   - [2..4]   signature_offset (u16 LE)
///   - [4..6]   signature_instruction_index (u16 LE)
///   - [6..8]   public_key_offset (u16 LE)
///   - [8..10]  public_key_instruction_index (u16 LE)
///   - [10..12] message_data_offset (u16 LE)
///   - [12..14] message_data_size (u16 LE)
///   - [14..16] message_instruction_index (u16 LE)
///
/// Followed by the actual data: public_key (32), signature (64), message (variable).
pub struct Ed25519SignatureOffsets {
    pub signature_offset: u16,
    pub signature_instruction_index: u16,
    pub public_key_offset: u16,
    pub public_key_instruction_index: u16,
    pub message_data_offset: u16,
    pub message_data_size: u16,
    pub message_instruction_index: u16,
}

/// Web3.js encodes Ed25519 payload offsets as self-contained within the
/// precompile instruction by setting the instruction index fields to `u16::MAX`.
///
/// Ryvo only supports this self-contained form so the bytes parsed by the
/// program are guaranteed to be the exact bytes verified by the precompile.
pub const SELF_CONTAINED_INSTRUCTION_INDEX: u16 = u16::MAX;

fn require_self_contained_offsets(offsets: &Ed25519SignatureOffsets) -> Result<()> {
    require!(
        offsets.signature_instruction_index == SELF_CONTAINED_INSTRUCTION_INDEX
            && offsets.public_key_instruction_index == SELF_CONTAINED_INSTRUCTION_INDEX
            && offsets.message_instruction_index == SELF_CONTAINED_INSTRUCTION_INDEX,
        VaultError::InvalidEd25519Data
    );
    Ok(())
}

/// Verify that the given instructions sysvar account contains a valid Ed25519
/// precompile instruction at the expected index, and extract the signature data.
///
/// For single-sig settlement instructions, `ed25519_ix_index` is typically 0
/// (the Ed25519 verify instruction is the first instruction in the transaction).
///
/// Returns the raw instruction data bytes of the Ed25519 precompile instruction.
pub fn verify_ed25519_ix(
    instructions_sysvar: &AccountInfo,
    ed25519_ix_index: u16,
) -> Result<Vec<u8>> {
    let ix =
        ixs_sysvar::load_instruction_at_checked(ed25519_ix_index as usize, instructions_sysvar)
            .map_err(|_| error!(VaultError::InvalidEd25519Data))?;

    require!(
        ix.program_id == ED25519_PROGRAM_ID,
        VaultError::InvalidEd25519Data
    );

    Ok(ix.data)
}

/// Parse offsets for a single signature entry within the Ed25519 ix data.
/// `sig_index` is 0-based within the Ed25519 instruction (for multi-sig, 0, 1, 2...).
/// Each signature entry header is 14 bytes (after the initial 2-byte num_signatures + 2-byte padding).
pub fn parse_ed25519_offsets(ix_data: &[u8], sig_index: u16) -> Result<Ed25519SignatureOffsets> {
    // @solana/web3.js format: num_signatures(u8) + padding(u8) + 14-byte offset block per sig
    require!(ix_data.len() >= 2, VaultError::InvalidEd25519Data);
    let num_sigs = ix_data[0] as u16;
    require!(
        num_sigs > 0 && sig_index < num_sigs,
        VaultError::InvalidEd25519Data
    );

    let header_start = 2 + (sig_index as usize) * 14;
    require!(
        ix_data.len() >= header_start + 14,
        VaultError::InvalidEd25519Data
    );

    let data = &ix_data[header_start..header_start + 14];

    let offsets = Ed25519SignatureOffsets {
        signature_offset: u16::from_le_bytes([data[0], data[1]]),
        signature_instruction_index: u16::from_le_bytes([data[2], data[3]]),
        public_key_offset: u16::from_le_bytes([data[4], data[5]]),
        public_key_instruction_index: u16::from_le_bytes([data[6], data[7]]),
        message_data_offset: u16::from_le_bytes([data[8], data[9]]),
        message_data_size: u16::from_le_bytes([data[10], data[11]]),
        message_instruction_index: u16::from_le_bytes([data[12], data[13]]),
    };

    require_self_contained_offsets(&offsets)?;

    Ok(offsets)
}

/// Extract the public key from the Ed25519 ix data at the offset specified.
pub fn extract_pubkey(ix_data: &[u8], offsets: &Ed25519SignatureOffsets) -> Result<Pubkey> {
    let start = offsets.public_key_offset as usize;
    require!(ix_data.len() >= start + 32, VaultError::InvalidEd25519Data);
    Ok(Pubkey::new_from_array(
        ix_data[start..start + 32].try_into().unwrap(),
    ))
}

/// Extract the message bytes from the Ed25519 ix data at the offset specified.
pub fn extract_message(ix_data: &[u8], offsets: &Ed25519SignatureOffsets) -> Result<Vec<u8>> {
    let start = offsets.message_data_offset as usize;
    let size = offsets.message_data_size as usize;
    require!(
        ix_data.len() >= start + size,
        VaultError::InvalidEd25519Data
    );
    Ok(ix_data[start..start + size].to_vec())
}

fn message_range(ix_data: &[u8], offsets: &Ed25519SignatureOffsets) -> Result<(usize, usize)> {
    let start = offsets.message_data_offset as usize;
    let size = offsets.message_data_size as usize;
    require!(
        ix_data.len() >= start + size,
        VaultError::InvalidEd25519Data
    );
    Ok((start, size))
}

/// Convenience: verify CPI guard — the current instruction must be from this program.
pub fn assert_no_cpi(instructions_sysvar: &AccountInfo, program_id: &Pubkey) -> Result<()> {
    let current_ix = ixs_sysvar::get_instruction_relative(0, instructions_sysvar)
        .map_err(|_| error!(VaultError::CpiNotAllowed))?;
    require!(
        current_ix.program_id == *program_id,
        VaultError::CpiNotAllowed
    );
    Ok(())
}

/// Helper for cooperative clearing rounds: extracts all pubkeys that signed the exact same message.
pub struct VerifiedSharedMessage {
    pub signers: Vec<Pubkey>,
    ix_data: Vec<u8>,
    message_offset: usize,
    message_size: usize,
}

impl VerifiedSharedMessage {
    pub fn message(&self) -> &[u8] {
        &self.ix_data[self.message_offset..self.message_offset + self.message_size]
    }
}

/// Returns the signer set plus a borrowed view into the shared signed message bytes.
pub fn verify_and_extract_all_signatures(
    instructions_sysvar: &AccountInfo,
    ed25519_ix_index: u16,
) -> Result<VerifiedSharedMessage> {
    let ix_data = verify_ed25519_ix(instructions_sysvar, ed25519_ix_index)?;

    require!(ix_data.len() >= 2, VaultError::InvalidEd25519Data);
    let num_sigs = ix_data[0] as u16;
    require!(num_sigs > 0, VaultError::InvalidEd25519Data);

    let mut signers = Vec::with_capacity(num_sigs as usize);

    // Extract the very first signature's message to establish the baseline
    let first_offsets = parse_ed25519_offsets(&ix_data, 0)?;
    let (message_offset, message_size) = message_range(&ix_data, &first_offsets)?;
    let shared_message = &ix_data[message_offset..message_offset + message_size];
    signers.push(extract_pubkey(&ix_data, &first_offsets)?);

    // Verify all subsequent signatures signed the exact same bytes
    for i in 1..num_sigs {
        let offsets = parse_ed25519_offsets(&ix_data, i)?;
        let (candidate_offset, candidate_size) = message_range(&ix_data, &offsets)?;
        require!(
            candidate_size == message_size
                && ix_data[candidate_offset..candidate_offset + candidate_size] == *shared_message,
            VaultError::InvalidEd25519Data
        );

        signers.push(extract_pubkey(&ix_data, &offsets)?);
    }

    Ok(VerifiedSharedMessage {
        signers,
        ix_data,
        message_offset,
        message_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_offsets_ix_data(
        signature_instruction_index: u16,
        public_key_instruction_index: u16,
        message_instruction_index: u16,
    ) -> Vec<u8> {
        let mut data = vec![0u8; 16];
        data[0] = 1;
        data[1] = 0;
        data[2..4].copy_from_slice(&32u16.to_le_bytes());
        data[4..6].copy_from_slice(&signature_instruction_index.to_le_bytes());
        data[6..8].copy_from_slice(&64u16.to_le_bytes());
        data[8..10].copy_from_slice(&public_key_instruction_index.to_le_bytes());
        data[10..12].copy_from_slice(&96u16.to_le_bytes());
        data[12..14].copy_from_slice(&12u16.to_le_bytes());
        data[14..16].copy_from_slice(&message_instruction_index.to_le_bytes());
        data
    }

    #[test]
    fn parse_ed25519_offsets_accepts_self_contained_layout() {
        let ix_data = build_offsets_ix_data(
            SELF_CONTAINED_INSTRUCTION_INDEX,
            SELF_CONTAINED_INSTRUCTION_INDEX,
            SELF_CONTAINED_INSTRUCTION_INDEX,
        );

        let offsets = parse_ed25519_offsets(&ix_data, 0).unwrap();
        assert_eq!(
            offsets.message_instruction_index,
            SELF_CONTAINED_INSTRUCTION_INDEX
        );
    }

    #[test]
    fn parse_ed25519_offsets_rejects_cross_instruction_message_reference() {
        let ix_data = build_offsets_ix_data(
            SELF_CONTAINED_INSTRUCTION_INDEX,
            SELF_CONTAINED_INSTRUCTION_INDEX,
            1,
        );

        assert!(parse_ed25519_offsets(&ix_data, 0).is_err());
    }
}
