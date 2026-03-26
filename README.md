# @aeoess/storage-sqlite

SQLite persistence backend for [Agent Passport System](https://github.com/aeoess/agent-passport-system). Makes APS deployable — state survives restarts.

## Install

```bash
npm install agent-passport-system @aeoess/storage-sqlite
```

## Usage

```typescript
import { SQLiteBackend } from '@aeoess/storage-sqlite'
import { createProxyGateway } from 'agent-passport-system'

const storage = new SQLiteBackend({ path: './gateway.db' })
await storage.initialize()

// Use with gateway (PR 3 — coming soon)
// const gateway = createProxyGateway(config, executor, { storage })

// Or use directly
await storage.putAgent(agentRecord)
await storage.putDelegation(delegation)
await storage.appendReceipt(receipt)

// Atomic spend — no race conditions
const res = await storage.reserveSpend('del-001', 50, 'USD')
if (res.success) {
  // ... execute action ...
  await storage.commitSpend(res.reservationId!)
  // If action fails: await storage.releaseSpend(res.reservationId!)
}

// Checkpoints with external anchoring
storage.onCheckpoint((hash, seq) => {
  console.log(`Checkpoint ${seq}: ${hash}`)
  // In production: post to webhook, log to S3, email principal
})
await storage.createCheckpoint('gw-001', gatewayPrivateKey)

// Startup integrity check
const report = await storage.verifyIntegrity()
if (report.errors.length > 0) {
  console.error('Integrity check failed:', report.errors)
  // Enter read-only mode or fail closed
}

await storage.close()
```

## What it provides

Single trust domain persistence. One gateway, one database, one authoritative view of delegations, revocations, receipts, and reputation.

- **WAL mode** — concurrent reads, fast writes
- **Atomic transactions** — `BEGIN IMMEDIATE` write lock, full rollback on error
- **Reserve/commit/release spend** — no race conditions even with async execution
- **Cursor pagination** on receipts — no OOM on large histories
- **GDPR tombstoning** — redact payload, preserve chain integrity
- **Signed checkpoints** — monotonic sequence, external anchoring callback
- **Startup integrity verification** — receipt chain, checkpoint monotonicity, schema version
- **Auto-pruning** of expired nonces and spend reservations

## What it does NOT provide

- Multi-gateway coordination (use the private gateway product)
- Revocation propagation across gateways
- Receipt replication or escrow
- High-availability / clustering
- Encryption at rest

## Schema

12 tables: `_meta`, `agents`, `delegations`, `reputation`, `revocations`, `receipts`, `demotions`, `key_rotations`, `replay_nonces`, `spend_reservations`, `checkpoints`. Additive-only migrations. Signed protocol objects stored as raw JSON in `payload` columns — never modified, never re-signed.

## License

Apache 2.0 — Copyright 2024-2026 Tymofii Pidlisnyi
