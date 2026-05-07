# Ryvo Network

This repository's first public commit captures the pre-hackathon baseline, and all later commits reflect simplification, auditing, and protocol changes made during the hackathon.

## Project Repositories

This repository contains the core onchain protocol for Ryvo: the Solana settlement layer for machine payments and agentic commerce.

- [Ryvo Network](https://github.com/Ryvonetwork/ryvo-protocol)
  Anchor program, settlement logic, commitments, channels, and clearing.
- [Ryvo Gateway](https://github.com/Ryvonetwork/ryvo-gateway)
  x402-facing gateway that turns the protocol into a usable paid API product.
- [Ryvo Network SDK](https://github.com/Ryvonetwork/ryvo-protocol-sdk)
  TypeScript SDK for integrating with the protocol and building on top of it.
- [Docs](https://github.com/Ryvonetwork/docs)
  Product, protocol, and integration docs.
- [Ryvo App](https://github.com/Ryvonetwork/ryvo-app)
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
