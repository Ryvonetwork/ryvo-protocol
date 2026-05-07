import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { createHash } from "crypto";
import { RyvoProtocol } from "../target/types/ryvo_protocol";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.AnchorProvider.env();
const program = anchor.workspace.ryvoProtocol as Program<RyvoProtocol>;

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const TEST_CHAIN_ID = 3;
const TEST_TOKEN_ID = 1;
const MESSAGE_DOMAIN_TAG = Buffer.from("ryvo-message-domain-v1", "utf8");

function findGlobalConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  )[0];
}

function findTokenRegistryPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token-registry")],
    program.programId
  )[0];
}

function deriveMessageDomain(programId: PublicKey, chainId: number): Buffer {
  return createHash("sha256")
    .update(MESSAGE_DOMAIN_TAG)
    .update(programId.toBuffer())
    .update(Buffer.from([chainId & 0xff, (chainId >> 8) & 0xff]))
    .digest()
    .subarray(0, 16);
}

async function expectProgramError(
  fn: () => Promise<unknown>,
  errorSubstring: string
): Promise<void> {
  try {
    await fn();
    expect.fail(
      `Expected error containing "${errorSubstring}" but call succeeded`
    );
  } catch (e: any) {
    const msg = e.message ?? e.toString();
    const logs = e.logs?.join(" ") ?? "";
    expect(`${msg} ${logs}`).to.include(errorSubstring);
  }
}

async function airdrop(pubkey: PublicKey, sol = 2) {
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      pubkey,
      sol * anchor.web3.LAMPORTS_PER_SOL
    )
  );
}

describe("Bootstrap (isolated)", () => {
  const upgradeAuthority = (provider.wallet as any).payer as Keypair;
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  );
  const globalConfigPda = findGlobalConfigPda();
  const tokenRegistryPda = findTokenRegistryPda();

  const feeRecipient = Keypair.generate();
  const nominatedAuthority = Keypair.generate();
  const unauthorizedInitializer = Keypair.generate();
  const unauthorizedRegistryAuthority = Keypair.generate();

  before(async () => {
    await airdrop(feeRecipient.publicKey);
    await airdrop(nominatedAuthority.publicKey);
    await airdrop(unauthorizedInitializer.publicKey);
    await airdrop(unauthorizedRegistryAuthority.publicKey);
  });

  it("rejects InvalidFeeBps (too low)", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initialize(
            TEST_CHAIN_ID,
            2,
            new anchor.BN(0),
            nominatedAuthority.publicKey
          )
          .accounts({
            upgradeAuthority: upgradeAuthority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            program: program.programId,
            programData: programDataPda,
          } as any)
          .rpc(),
      "InvalidFeeBps"
    );
  });

  it("rejects InvalidFeeBps (too high)", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initialize(
            TEST_CHAIN_ID,
            31,
            new anchor.BN(0),
            nominatedAuthority.publicKey
          )
          .accounts({
            upgradeAuthority: upgradeAuthority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            program: program.programId,
            programData: programDataPda,
          } as any)
          .rpc(),
      "InvalidFeeBps"
    );
  });

  it("rejects InvalidFeeRecipient (zero address)", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initialize(
            TEST_CHAIN_ID,
            30,
            new anchor.BN(0),
            nominatedAuthority.publicKey
          )
          .accounts({
            upgradeAuthority: upgradeAuthority.publicKey,
            feeRecipient: PublicKey.default,
            program: program.programId,
            programData: programDataPda,
          } as any)
          .rpc(),
      "fee_recipient"
    );
  });

  it("rejects InvalidRegistrationFee (out of range)", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initialize(
            TEST_CHAIN_ID,
            30,
            new anchor.BN(500_000),
            nominatedAuthority.publicKey
          )
          .accounts({
            upgradeAuthority: upgradeAuthority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            program: program.programId,
            programData: programDataPda,
          } as any)
          .rpc(),
      "InvalidRegistrationFee"
    );
  });

  it("rejects unauthorized initializers that are not the program upgrade authority", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initialize(
            TEST_CHAIN_ID,
            30,
            new anchor.BN(0),
            nominatedAuthority.publicKey
          )
          .accounts({
            upgradeAuthority: unauthorizedInitializer.publicKey,
            feeRecipient: feeRecipient.publicKey,
            program: program.programId,
            programData: programDataPda,
          } as any)
          .signers([unauthorizedInitializer])
          .rpc(),
      "UnauthorizedInitializer"
    );
  });

  it("bootstraps with upgrade authority active and nominated authority pending", async () => {
    await program.methods
      .initialize(
        TEST_CHAIN_ID,
        30,
        new anchor.BN(0),
        nominatedAuthority.publicKey
      )
      .accounts({
        upgradeAuthority: upgradeAuthority.publicKey,
        feeRecipient: feeRecipient.publicKey,
        program: program.programId,
        programData: programDataPda,
      } as any)
      .rpc();

    const globalConfig = await program.account.globalConfig.fetch(globalConfigPda);
    expect(globalConfig.authority.toString()).to.equal(
      upgradeAuthority.publicKey.toString()
    );
    expect(globalConfig.pendingAuthority.toString()).to.equal(
      nominatedAuthority.publicKey.toString()
    );
    expect(globalConfig.feeRecipient.toString()).to.equal(
      feeRecipient.publicKey.toString()
    );
    expect(globalConfig.feeBps).to.equal(30);
    expect(globalConfig.chainId).to.equal(TEST_CHAIN_ID);
    const expectedMessageDomain = deriveMessageDomain(
      program.programId,
      TEST_CHAIN_ID
    );
    expect(Buffer.from(globalConfig.messageDomain)).to.deep.equal(
      expectedMessageDomain
    );
  });

  it("requires the exact pending config authority to accept the handoff", async () => {
    await expectProgramError(
      () =>
        program.methods
          .acceptConfigAuthority()
          .accounts({
            globalConfig: globalConfigPda,
            pendingAuthority: unauthorizedRegistryAuthority.publicKey,
          } as any)
          .signers([unauthorizedRegistryAuthority])
          .rpc(),
      "UnauthorizedPendingAuthority"
    );

    await program.methods
      .acceptConfigAuthority()
      .accounts({
        globalConfig: globalConfigPda,
        pendingAuthority: nominatedAuthority.publicKey,
      } as any)
      .signers([nominatedAuthority])
      .rpc();

    const acceptedConfig = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(acceptedConfig.authority.toString()).to.equal(
      nominatedAuthority.publicKey.toString()
    );
    expect(acceptedConfig.pendingAuthority.toString()).to.equal(
      PublicKey.default.toString()
    );
  });

  it("requires the active config authority to initialize the token registry", async () => {
    await expectProgramError(
      () =>
        program.methods
          .initializeTokenRegistry()
          .accounts({
            tokenRegistry: tokenRegistryPda,
            globalConfig: globalConfigPda,
            authority: unauthorizedRegistryAuthority.publicKey,
          } as any)
          .signers([unauthorizedRegistryAuthority])
          .rpc(),
      "UnauthorizedTokenRegistration"
    );

    await program.methods
      .initializeTokenRegistry()
      .accounts({
        tokenRegistry: tokenRegistryPda,
        globalConfig: globalConfigPda,
        authority: nominatedAuthority.publicKey,
      } as any)
      .signers([nominatedAuthority])
      .rpc();

    const registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);
    expect(registry.authority.toString()).to.equal(
      nominatedAuthority.publicKey.toString()
    );
    expect(registry.pendingAuthority.toString()).to.equal(
      PublicKey.default.toString()
    );
  });

  it("allows the registry authority to register the first token after bootstrap", async () => {
    const mint = await createMint(
      provider.connection,
      upgradeAuthority,
      upgradeAuthority.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    const symbolBytes = Buffer.from("TOK1\x00\x00\x00\x00");

    await expectProgramError(
      () =>
        program.methods
          .registerToken(TEST_TOKEN_ID, [...symbolBytes])
          .accounts({
            tokenRegistry: tokenRegistryPda,
            mint,
            globalConfig: globalConfigPda,
            authority: unauthorizedRegistryAuthority.publicKey,
          } as any)
          .signers([unauthorizedRegistryAuthority])
          .rpc(),
      "UnauthorizedTokenRegistration"
    );

    await program.methods
      .registerToken(TEST_TOKEN_ID, [...symbolBytes])
      .accounts({
        tokenRegistry: tokenRegistryPda,
        mint,
        globalConfig: globalConfigPda,
        authority: nominatedAuthority.publicKey,
      } as any)
      .signers([nominatedAuthority])
      .rpc();

    const registry = await program.account.tokenRegistry.fetch(tokenRegistryPda);
    expect(registry.tokens).to.have.length(1);
    expect(registry.tokens[0].id).to.equal(TEST_TOKEN_ID);
    expect(registry.tokens[0].mint.toString()).to.equal(mint.toString());
  });
});
