use anchor_lang::prelude::*;
use hex_literal::hex;
use sha2::{Digest, Sha256};

use crate::errors::VaultError;

mod syscalls {
    #[cfg(target_os = "solana")]
    extern "C" {
        pub fn sol_curve_group_op(
            curve_id: u64,
            group_op: u64,
            left_input_addr: *const u8,
            right_input_addr: *const u8,
            result_point_addr: *mut u8,
        ) -> u64;
        pub fn sol_curve_pairing_map(
            curve_id: u64,
            num_pairs: u64,
            g1_points: *const u8,
            g2_points: *const u8,
            result: *mut u8,
        ) -> u64;
        pub fn sol_curve_decompress(curve_id: u64, point: *const u8, result: *mut u8) -> u64;
    }

    #[cfg(not(target_os = "solana"))]
    pub unsafe fn sol_curve_group_op(
        _curve_id: u64,
        _group_op: u64,
        _left_input_addr: *const u8,
        _right_input_addr: *const u8,
        _result_point_addr: *mut u8,
    ) -> u64 {
        1
    }

    #[cfg(not(target_os = "solana"))]
    pub unsafe fn sol_curve_pairing_map(
        _curve_id: u64,
        _num_pairs: u64,
        _g1_points: *const u8,
        _g2_points: *const u8,
        _result: *mut u8,
    ) -> u64 {
        1
    }

    #[cfg(not(target_os = "solana"))]
    pub unsafe fn sol_curve_decompress(_curve_id: u64, _point: *const u8, _result: *mut u8) -> u64 {
        1
    }
}

pub const BLS_SIGNATURE_COMPRESSED_SIZE: usize = 48;
pub const BLS_SIGNATURE_UNCOMPRESSED_SIZE: usize = 96;
pub const BLS_PUBLIC_KEY_COMPRESSED_SIZE: usize = 96;
pub const BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE: usize = 192;
pub const BLS_SCALAR_SIZE: usize = 32;
pub const BLS_GT_SIZE: usize = 576;

pub const BLS_REGISTRATION_MESSAGE_KIND: u8 = 0x03;
pub const BLS_REGISTRATION_MESSAGE_VERSION: u8 = 0x01;
pub const BLS_CLEARING_ROUND_MESSAGE_VERSION: u8 = 0x05;
pub const BLS_SCHEME_VERSION_V1: u8 = 1;

const ADD: u64 = 0;
const MUL: u64 = 2;

const BLS12_381_BE: u64 = 4 | 0x80;
const BLS12_381_G1_BE: u64 = 5 | 0x80;
const BLS12_381_G2_BE: u64 = 6 | 0x80;

const HASH_TO_SIGNING_POINT_TAG: &[u8] = b"agon-bls-signing-point-v1";

const BLS_SCALAR_MODULUS_BE: [u8; BLS_SCALAR_SIZE] =
    hex!("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001");

const G1_GENERATOR_UNCOMPRESSED_BE: [u8; BLS_SIGNATURE_UNCOMPRESSED_SIZE] = hex!(
    "17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb\
     08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1"
);

const NEG_G2_GENERATOR_UNCOMPRESSED_BE: [u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE] = hex!(
    "13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e\
     024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8\
     13fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed\
     0d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa"
);

fn gt_identity_be() -> [u8; BLS_GT_SIZE] {
    let mut out = [0u8; BLS_GT_SIZE];
    out[BLS_GT_SIZE - 1] = 1;
    out
}

fn compressed_point_has_infinity_flag(bytes: &[u8]) -> bool {
    bytes.first().map(|first| first & 0x40 != 0).unwrap_or(true)
}

fn is_zero_scalar(bytes: &[u8; BLS_SCALAR_SIZE]) -> bool {
    bytes.iter().all(|byte| *byte == 0)
}

fn compare_be_32(
    left: &[u8; BLS_SCALAR_SIZE],
    right: &[u8; BLS_SCALAR_SIZE],
) -> core::cmp::Ordering {
    for (left_byte, right_byte) in left.iter().zip(right.iter()) {
        match left_byte.cmp(right_byte) {
            core::cmp::Ordering::Equal => continue,
            ordering => return ordering,
        }
    }
    core::cmp::Ordering::Equal
}

fn subtract_modulus_be(bytes: &mut [u8; BLS_SCALAR_SIZE]) {
    let mut borrow = 0u16;
    for index in (0..BLS_SCALAR_SIZE).rev() {
        let left = bytes[index] as u16;
        let right = BLS_SCALAR_MODULUS_BE[index] as u16 + borrow;
        if left >= right {
            bytes[index] = (left - right) as u8;
            borrow = 0;
        } else {
            bytes[index] = ((left + 256) - right) as u8;
            borrow = 1;
        }
    }
}

fn reduce_to_scalar_be(bytes: &mut [u8; BLS_SCALAR_SIZE]) {
    while compare_be_32(bytes, &BLS_SCALAR_MODULUS_BE) != core::cmp::Ordering::Less {
        subtract_modulus_be(bytes);
    }
}

pub fn hash_message_to_scalar_be(message: &[u8]) -> [u8; BLS_SCALAR_SIZE] {
    let mut hasher = Sha256::new();
    hasher.update(HASH_TO_SIGNING_POINT_TAG);
    hasher.update(message);
    let mut scalar = hasher.finalize().into();
    reduce_to_scalar_be(&mut scalar);

    if is_zero_scalar(&scalar) {
        let mut retry_hasher = Sha256::new();
        retry_hasher.update(HASH_TO_SIGNING_POINT_TAG);
        retry_hasher.update(message);
        retry_hasher.update([1u8]);
        scalar = retry_hasher.finalize().into();
        reduce_to_scalar_be(&mut scalar);
        if is_zero_scalar(&scalar) {
            scalar[BLS_SCALAR_SIZE - 1] = 1;
        }
    }

    scalar
}

pub fn build_registration_message(
    message_domain: [u8; 16],
    participant_id: u32,
    owner: &Pubkey,
    bls_pubkey_compressed: &[u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
) -> Vec<u8> {
    let mut message = Vec::with_capacity(2 + 16 + 4 + 32 + BLS_PUBLIC_KEY_COMPRESSED_SIZE);
    message.push(BLS_REGISTRATION_MESSAGE_KIND);
    message.push(BLS_REGISTRATION_MESSAGE_VERSION);
    message.extend_from_slice(&message_domain);
    message.extend_from_slice(&participant_id.to_le_bytes());
    message.extend_from_slice(owner.as_ref());
    message.extend_from_slice(bls_pubkey_compressed);
    message
}

fn decompress_g1_be(
    compressed: &[u8; BLS_SIGNATURE_COMPRESSED_SIZE],
) -> Result<[u8; BLS_SIGNATURE_UNCOMPRESSED_SIZE]> {
    require!(
        !compressed_point_has_infinity_flag(compressed),
        VaultError::InvalidBlsSignature
    );
    let mut point = [0u8; BLS_SIGNATURE_UNCOMPRESSED_SIZE];
    let result = unsafe {
        syscalls::sol_curve_decompress(BLS12_381_G1_BE, compressed.as_ptr(), point.as_mut_ptr())
    };
    require!(result == 0, VaultError::InvalidBlsSignature);
    Ok(point)
}

fn decompress_g2_be(
    compressed: &[u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
) -> Result<[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE]> {
    require!(
        !compressed_point_has_infinity_flag(compressed),
        VaultError::InvalidBlsPublicKey
    );
    let mut point = [0u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE];
    let result = unsafe {
        syscalls::sol_curve_decompress(BLS12_381_G2_BE, compressed.as_ptr(), point.as_mut_ptr())
    };
    require!(result == 0, VaultError::InvalidBlsPublicKey);
    Ok(point)
}

fn add_g2_be(
    left: &[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE],
    right: &[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE],
) -> Result<[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE]> {
    let mut result_point = [0u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE];
    let result = unsafe {
        syscalls::sol_curve_group_op(
            BLS12_381_G2_BE,
            ADD,
            left.as_ptr(),
            right.as_ptr(),
            result_point.as_mut_ptr(),
        )
    };
    require!(result == 0, VaultError::BlsSyscallFailed);
    Ok(result_point)
}

fn multiply_g1_be(
    scalar_be: &[u8; BLS_SCALAR_SIZE],
    point: &[u8; BLS_SIGNATURE_UNCOMPRESSED_SIZE],
) -> Result<[u8; BLS_SIGNATURE_UNCOMPRESSED_SIZE]> {
    let mut result_point = [0u8; BLS_SIGNATURE_UNCOMPRESSED_SIZE];
    let result = unsafe {
        syscalls::sol_curve_group_op(
            BLS12_381_G1_BE,
            MUL,
            scalar_be.as_ptr(),
            point.as_ptr(),
            result_point.as_mut_ptr(),
        )
    };
    require!(result == 0, VaultError::BlsSyscallFailed);
    Ok(result_point)
}

fn pairing_product_is_identity_be(
    g1_points: &[[u8; BLS_SIGNATURE_UNCOMPRESSED_SIZE]],
    g2_points: &[[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE]],
) -> Result<bool> {
    require!(
        !g1_points.is_empty() && g1_points.len() == g2_points.len() && g1_points.len() <= 8,
        VaultError::BlsSyscallFailed
    );

    let mut gt_result = [0u8; BLS_GT_SIZE];
    let result = unsafe {
        syscalls::sol_curve_pairing_map(
            BLS12_381_BE,
            g1_points.len() as u64,
            g1_points.as_ptr() as *const u8,
            g2_points.as_ptr() as *const u8,
            gt_result.as_mut_ptr(),
        )
    };
    require!(result == 0, VaultError::BlsSyscallFailed);
    Ok(gt_result == gt_identity_be())
}

pub fn hash_message_to_signing_point_be(
    message: &[u8],
) -> Result<[u8; BLS_SIGNATURE_UNCOMPRESSED_SIZE]> {
    let scalar = hash_message_to_scalar_be(message);
    multiply_g1_be(&scalar, &G1_GENERATOR_UNCOMPRESSED_BE)
}

pub fn aggregate_pubkeys_be(
    pubkeys_compressed: &[[u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE]],
) -> Result<[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE]> {
    require!(
        !pubkeys_compressed.is_empty(),
        VaultError::ParticipantBlsKeyNotFound
    );

    let mut aggregate = decompress_g2_be(&pubkeys_compressed[0])?;
    for pubkey in &pubkeys_compressed[1..] {
        let point = decompress_g2_be(pubkey)?;
        aggregate = add_g2_be(&aggregate, &point)?;
    }
    Ok(aggregate)
}

pub fn aggregate_pubkey_with_compressed_be(
    current_aggregate: Option<[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE]>,
    pubkey_compressed: &[u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
) -> Result<[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE]> {
    let point = decompress_g2_be(pubkey_compressed)?;
    match current_aggregate {
        Some(aggregate) => add_g2_be(&aggregate, &point),
        None => Ok(point),
    }
}

pub fn verify_pop(
    message_domain: [u8; 16],
    participant_id: u32,
    owner: &Pubkey,
    bls_pubkey_compressed: &[u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE],
    pop_signature_compressed: &[u8; BLS_SIGNATURE_COMPRESSED_SIZE],
) -> Result<()> {
    let message =
        build_registration_message(message_domain, participant_id, owner, bls_pubkey_compressed);
    let message_point = hash_message_to_signing_point_be(&message)?;
    let signature_point = decompress_g1_be(pop_signature_compressed)?;
    let public_key_point = decompress_g2_be(bls_pubkey_compressed)?;

    let is_valid = pairing_product_is_identity_be(
        &[signature_point, message_point],
        &[NEG_G2_GENERATOR_UNCOMPRESSED_BE, public_key_point],
    )?;
    require!(is_valid, VaultError::InvalidBlsProofOfPossession);
    Ok(())
}

pub fn verify_same_message_aggregate_signature(
    message: &[u8],
    aggregate_signature_compressed: &[u8; BLS_SIGNATURE_COMPRESSED_SIZE],
    aggregate_pubkey_uncompressed: &[u8; BLS_PUBLIC_KEY_UNCOMPRESSED_SIZE],
) -> Result<()> {
    let message_point = hash_message_to_signing_point_be(message)?;
    let signature_point = decompress_g1_be(aggregate_signature_compressed)?;
    let is_valid = pairing_product_is_identity_be(
        &[signature_point, message_point],
        &[
            NEG_G2_GENERATOR_UNCOMPRESSED_BE,
            *aggregate_pubkey_uncompressed,
        ],
    )?;
    require!(is_valid, VaultError::InvalidBlsSignature);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_infinity_points_are_rejected_before_syscall() {
        let mut signature = [0u8; BLS_SIGNATURE_COMPRESSED_SIZE];
        signature[0] = 0xc0;
        assert!(decompress_g1_be(&signature).is_err());

        let mut pubkey = [0u8; BLS_PUBLIC_KEY_COMPRESSED_SIZE];
        pubkey[0] = 0xc0;
        assert!(decompress_g2_be(&pubkey).is_err());
    }
}
