#!/usr/bin/env ts-node
/**
 * Standalone bootstrap for the v6 yield-bearing setup.
 *
 * Idempotent — safe to re-run. Performs:
 *   1. Ensures Agon GlobalConfig + TokenRegistry exist (initialise-program does this too).
 *   2. Resolves the underlying USDC mint (--usdc-mint <PUBKEY>, env USDC_MINT, or a cached
 *      deployer-controlled mint at keys/<network>-demo-usdc-mint.json).
 *   3. Initialises the mock-yield Reserve at --apy-bps (default 600 = 6%).
 *   4. Registers agUSDC as token_id=1 (kind=YieldBearing) in the Agon registry.
 *
 * Usage examples:
 *   yarn ts-node scripts/bootstrap-yield-bearing.ts --network devnet
 *   yarn ts-node scripts/bootstrap-yield-bearing.ts --network devnet \
 *     --usdc-mint Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
 *
 * The yield-bearing-demo.ts script invokes the same primitives (so running the demo also
 * bootstraps), but this thin wrapper is the recommended post-deploy step.
 */

// Re-uses the bootstrap helpers exported from yield-bearing-demo.ts. Implementation lives there
// to keep a single source of truth.
import { spawnSync } from "child_process";
import * as path from "path";

const args = process.argv.slice(2);
if (!args.includes("--bootstrap-only")) args.push("--bootstrap-only");

const result = spawnSync(
  process.execPath,
  [
    path.join(__dirname, "..", "node_modules", "ts-node", "dist", "bin.js"),
    path.join(__dirname, "yield-bearing-demo.ts"),
    ...args,
  ],
  {
    stdio: "inherit",
    env: process.env,
  }
);

process.exit(result.status ?? 1);
