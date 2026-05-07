// Anchor migration entrypoint for the Ryvo Network workspace.
//
// Invoked by `anchor migrate` and `anchor deploy` with a provider configured
// from the workspace's Anchor.toml. The real Ryvo deploy + initialize +
// yield-bearing bootstrap is driven by `scripts/deploy.sh`; this file is kept
// as a no-op so anchor's CLI commands that expect a migration script keep
// working.

import * as anchor from "@coral-xyz/anchor";

module.exports = async function (provider: anchor.AnchorProvider) {
  anchor.setProvider(provider);
};
