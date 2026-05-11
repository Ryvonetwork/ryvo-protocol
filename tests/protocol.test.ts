import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  program,
  provider,
  deployer,
  feeRecipient,
  expectProgramError,
  TEST_CHAIN_ID,
} from "./shared/setup";

describe("Protocol Configuration", () => {
  it("should update config (authority only)", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const newAuthority = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        newAuthority.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      )
    );
    const newFeeBps = 10; // 0.1%

    await program.methods
      .updateConfig(newAuthority.publicKey, null, newFeeBps, null)
      .accounts({
        authority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();

    const globalConfig = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(globalConfig.authority.toString()).to.equal(
      deployer.publicKey.toString()
    );
    expect(globalConfig.pendingAuthority.toString()).to.equal(
      newAuthority.publicKey.toString()
    );
    expect(globalConfig.feeBps).to.equal(newFeeBps);
    expect(globalConfig.chainId).to.equal(TEST_CHAIN_ID);

    await expectProgramError(
      () =>
        program.methods
          .acceptConfigAuthority()
          .accounts({
            globalConfig: globalConfigPda,
            pendingAuthority: feeRecipient.publicKey,
          } as any)
          .signers([feeRecipient])
          .rpc(),
      "UnauthorizedPendingAuthority"
    );

    await program.methods
      .acceptConfigAuthority()
      .accounts({
        globalConfig: globalConfigPda,
        pendingAuthority: newAuthority.publicKey,
      } as any)
      .signers([newAuthority])
      .rpc();

    const acceptedConfig = await program.account.globalConfig.fetch(
      globalConfigPda
    );
    expect(acceptedConfig.authority.toString()).to.equal(
      newAuthority.publicKey.toString()
    );
    expect(globalConfig.authority.toString()).to.equal(
      deployer.publicKey.toString()
    );
    expect(acceptedConfig.pendingAuthority.toString()).to.equal(
      PublicKey.default.toString()
    );

    // Restore deployer as authority for subsequent tests
    await program.methods
      .updateConfig(deployer.publicKey, null, 30, null)
      .accounts({
        authority: newAuthority.publicKey,
      } as any)
      .signers([newAuthority])
      .rpc();

    await program.methods
      .acceptConfigAuthority()
      .accounts({
        globalConfig: globalConfigPda,
        pendingAuthority: deployer.publicKey,
      } as any)
      .signers([deployer])
      .rpc();
  });
});
