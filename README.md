# Ryvo Network

This repository's first public commit captures the pre-hackathon baseline, and all later commits reflect simplification, auditing, and protocol changes made during the hackathon.

## Project Repositories

This repository contains the core onchain protocol for Ryvo: the Solana settlement layer for machine payments and agentic commerce.

- [ryvo-protocol](https://github.com/Ryvonetwork/ryvo-protocol)
  Anchor program and core onchain settlement layer: commitments, channels, BLS clearing rounds, and protocol accounts.
- [ryvo-gateway](https://github.com/Ryvonetwork/ryvo-gateway)
  x402-facing gateway that turns the protocol into a usable paid API product and exposes the Tokens API.
- [ryvo-protocol-sdk](https://github.com/Ryvonetwork/ryvo-protocol-sdk)
  TypeScript SDK for integrating with the protocol, opening channels, signing commitments, and submitting settlements.
- [ryvo-agentic](https://github.com/Ryvonetwork/ryvo-agentic)
  Agent-facing tools: one-step installer, Gateway / Protocol CLIs and MCP servers, agent wallet, and Ryvo skills.
- [research](https://github.com/Ryvonetwork/research)
  Solana × x402 research — Artemis-truth numbers and the channel + BLS compression math behind Ryvo's fee / throughput claims.
- [docs](https://github.com/Ryvonetwork/docs)
  Product, protocol, and integration docs.
- [ryvo-app](https://github.com/Ryvonetwork/ryvo-app) (private — Colosseum has access)
  Public-facing app and website.

## Prerequisites

- Node.js 18+
- Rust
- Solana CLI
- Anchor

## Install

```bash
npm install
```

## Build

```bash
anchor build -- --features custom-heap
```

## Test

```bash
anchor test -- --features custom-heap
```

Windows + WSL local validator flow:

```powershell
.\scripts\test-local.ps1
```

## Verify

```bash
npm run verify
```

## Deploy

```bash
npm run deploy:devnet
```
