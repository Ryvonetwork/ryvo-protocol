# Agon Protocol

This repository's first public commit captures the pre-hackathon baseline, and all later commits reflect simplification, auditing, and protocol changes made during the hackathon.

## Project Repositories

This repository contains the core onchain protocol for Agon: the Solana settlement layer for machine payments and agentic commerce.

- [Agon Protocol](https://github.com/Agonx402/agon-protocol)
  Anchor program, settlement logic, commitments, channels, and clearing.
- [Agon Gateway](https://github.com/Agonx402/agon-gateway)
  x402-facing gateway that turns the protocol into a usable paid API product.
- [Agon Protocol SDK](https://github.com/Agonx402/agon-protocol-sdk)
  TypeScript SDK for integrating with the protocol and building on top of it.
- [Docs](https://github.com/Agonx402/docs)
  Product, protocol, and integration docs.
- [Agon App](https://github.com/Agonx402/agon-app)
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
