import { bls12_381 } from "@noble/curves/bls12-381";
import { PublicKey } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";

const MESSAGE_DOMAIN_TAG = Buffer.from("agon-message-domain-v1", "utf8");
const BLS_SIGNING_POINT_TAG = Buffer.from("agon-bls-signing-point-v1", "utf8");
const BLS_SCALAR_MODULUS =
  0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

export const BLS_PUBLIC_KEY_COMPRESSED_SIZE = 96;
export const BLS_SIGNATURE_COMPRESSED_SIZE = 48;
export const BLS_CLEARING_ROUND_MESSAGE_VERSION = 0x05;
export const BLS_REGISTRATION_MESSAGE_KIND = 0x03;
export const BLS_REGISTRATION_MESSAGE_VERSION = 0x01;

export type BlsKeypair = {
  secretScalar: bigint;
  publicKeyCompressed: Buffer;
};

export function deriveMessageDomain(
  programId: PublicKey,
  chainId: number
): Buffer {
  return createHash("sha256")
    .update(MESSAGE_DOMAIN_TAG)
    .update(programId.toBuffer())
    .update(Buffer.from([chainId & 0xff, (chainId >> 8) & 0xff]))
    .digest()
    .subarray(0, 16);
}

export function reduceBlsScalarBytes(bytes: Buffer): Buffer {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  while (value >= BLS_SCALAR_MODULUS) {
    value -= BLS_SCALAR_MODULUS;
  }
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

function normalizeZeroScalar(scalarBytes: Buffer): Buffer {
  if (!scalarBytes.equals(Buffer.alloc(32))) {
    return scalarBytes;
  }
  const normalized = Buffer.alloc(32);
  normalized[31] = 1;
  return normalized;
}

export function createBlsKeypairFromSeed(
  seed: Buffer | Uint8Array
): BlsKeypair {
  const scalarBytes = normalizeZeroScalar(
    reduceBlsScalarBytes(createHash("sha256").update(Buffer.from(seed)).digest())
  );
  const secretScalar = BigInt(`0x${scalarBytes.toString("hex")}`);
  return {
    secretScalar,
    publicKeyCompressed: Buffer.from(
      bls12_381.G2.ProjectivePoint.BASE.multiply(secretScalar).toRawBytes(true)
    ),
  };
}

export function createRandomBlsKeypair(): BlsKeypair {
  return createBlsKeypairFromSeed(randomBytes(32));
}

function hashMessageToBlsScalar(message: Buffer | Uint8Array): bigint {
  let scalarBytes = reduceBlsScalarBytes(
    createHash("sha256").update(BLS_SIGNING_POINT_TAG).update(message).digest()
  );

  if (scalarBytes.equals(Buffer.alloc(32))) {
    scalarBytes = reduceBlsScalarBytes(
      createHash("sha256")
        .update(BLS_SIGNING_POINT_TAG)
        .update(message)
        .update(Buffer.from([1]))
        .digest()
    );
    scalarBytes = normalizeZeroScalar(scalarBytes);
  }

  return BigInt(`0x${scalarBytes.toString("hex")}`);
}

function hashMessageToBlsPoint(message: Buffer | Uint8Array) {
  return bls12_381.G1.ProjectivePoint.BASE.multiply(
    hashMessageToBlsScalar(Buffer.from(message))
  );
}

export function signBlsMessage(
  keypair: Pick<BlsKeypair, "secretScalar">,
  message: Buffer | Uint8Array
): Buffer {
  const signature = hashMessageToBlsPoint(Buffer.from(message)).multiply(
    keypair.secretScalar
  );
  return Buffer.from(signature.toRawBytes(true));
}

export function aggregateBlsSignatures(
  signatures: Array<Buffer | Uint8Array>
): Buffer {
  const aggregate = signatures.reduce(
    (point, signature) =>
      point.add(bls12_381.G1.ProjectivePoint.fromHex(signature)),
    bls12_381.G1.ProjectivePoint.ZERO
  );
  return Buffer.from(aggregate.toRawBytes(true));
}

export function createBlsRegistrationMessage(params: {
  participantId: number;
  owner: PublicKey;
  blsPubkeyCompressed: Buffer | Uint8Array;
  messageDomain: Buffer | Uint8Array;
}): Buffer {
  const participantIdBytes = Buffer.alloc(4);
  participantIdBytes.writeUInt32LE(params.participantId, 0);
  return Buffer.concat([
    Buffer.from([
      BLS_REGISTRATION_MESSAGE_KIND,
      BLS_REGISTRATION_MESSAGE_VERSION,
    ]),
    Buffer.from(params.messageDomain),
    participantIdBytes,
    params.owner.toBuffer(),
    Buffer.from(params.blsPubkeyCompressed),
  ]);
}
