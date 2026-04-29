# Benchmarks

Generated benchmark artifacts live here.

- `live/` stores snapshots derived from the protocol-only devnet demo.
- `synthetic/` stores deterministic capacity snapshots from the sizing scripts.

Current headline BLS-only bucketed clearing estimates from the sizing model:

- balanced `v0 + ALT` clearing rounds fit `32` participants / `32` directed channels before byte limits
- overall `v0 + ALT` clearing rounds fit `16` participants / `225` directed channels before byte limits

That is the main reason this branch exists: bucketed BLS-only clearing collapses participant/channel locks into bucket accounts, then spends the recovered account budget on larger logical rounds. The live ceiling is expected to be compute-bound before the byte model is exhausted.

Regenerate with:

```bash
npm run benchmarks:generate
```
