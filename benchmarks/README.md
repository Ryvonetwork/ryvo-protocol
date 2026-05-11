# Benchmarks

Generated benchmark artifacts live here.

- `live/` stores snapshots derived from the protocol-only devnet demo.
- `synthetic/` stores deterministic capacity snapshots from the sizing scripts.

Snapshot JSON files are generated metadata and are ignored by git so they do
not outlive the deployment/program build that produced them.

Regenerate with:

```bash
npm run benchmarks:generate
```
