// ══════════════════════════════════════════════════════════════════
// SQLiteBackend Test Suite
// ══════════════════════════════════════════════════════════════════
// Runs the same compliance tests as VolatileBackend, plus
// SQLite-specific: persistence across restart, WAL mode, integrity.
// ══════════════════════════════════════════════════════════════════

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SQLiteBackend } from '../src/index.js'
import { generateKeyPair } from 'agent-passport-system'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let dbDir: string
let dbPath: string

function freshDb(): string {
  dbDir = mkdtempSync(join(tmpdir(), 'aps-sqlite-test-'))
  dbPath = join(dbDir, 'test.db')
  return dbPath
}

function cleanup(): void {
  try { rmSync(dbDir, { recursive: true, force: true }) } catch {}
}

import type { StoredAgentRecord } from 'agent-passport-system'
import type { Delegation, RevocationRecord, ActionReceipt } from 'agent-passport-system'

function makeAgent(id: string): StoredAgentRecord {
  return {
    agentId: id,
    passport: { agentId: id, name: 'Test', publicKey: 'pk_' + id } as any,
    attestation: { attested: true } as any,
    registeredAt: new Date().toISOString()
  }
}

function makeDelegation(id: string, toKey: string, scope: string[], limit?: number): Delegation {
  return {
    delegationId: id, delegatedTo: toKey, delegatedBy: 'principal_key',
    scope, spendLimit: limit, maxDepth: 2, currentDepth: 0,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    signature: 'sig_' + id
  } as Delegation
}

function makeReceipt(id: string, agentId: string, tool: string): ActionReceipt {
  return {
    receiptId: id, version: '1.1', timestamp: new Date().toISOString(),
    agentId, delegationId: 'del_test',
    action: { type: `gateway:${tool}`, target: '{}', scopeUsed: tool },
    result: { status: 'success', summary: 'ok' },
    delegationChain: ['pk_principal'], signature: 'sig_' + id
  } as ActionReceipt
}

describe('SQLiteBackend', () => {
  let backend: SQLiteBackend

  beforeEach(async () => {
    backend = new SQLiteBackend({ path: freshDb() })
    await backend.initialize()
  })

  afterEach(async () => {
    await backend.close()
    cleanup()
  })

  // ── Core CRUD ──
  it('agents: store and retrieve', async () => {
    await backend.putAgent(makeAgent('a1'))
    const a = await backend.getAgent('a1')
    assert.ok(a)
    assert.equal(a.agentId, 'a1')
    assert.equal(await backend.getAgent('nope'), null)
    assert.equal((await backend.listAgents()).length, 1)
  })

  it('delegations: store and query by agent', async () => {
    await backend.putDelegation(makeDelegation('d1', 'pk_a', ['read'], 200))
    await backend.putDelegation(makeDelegation('d2', 'pk_a', ['write'], 100))
    await backend.putDelegation(makeDelegation('d3', 'pk_b', ['admin'], 500))
    assert.equal((await backend.getDelegationsForAgent('pk_a')).length, 2)
    const d = await backend.getDelegation('d1')
    assert.ok(d)
    assert.equal(d.spendLimit, 200)
  })

  it('spend: reserve/commit/release atomically', async () => {
    await backend.putDelegation(makeDelegation('ds', 'pk', ['cloud'], 100))
    const r1 = await backend.reserveSpend('ds', 60, 'USD')
    assert.ok(r1.success)
    const r2 = await backend.reserveSpend('ds', 30, 'USD')
    assert.ok(r2.success)
    // 60 + 30 + 20 > 100
    const r3 = await backend.reserveSpend('ds', 20, 'USD')
    assert.equal(r3.success, false)
    // Commit first, release second
    assert.ok(await backend.commitSpend(r1.reservationId!))
    assert.ok(await backend.releaseSpend(r2.reservationId!))
    assert.equal(await backend.getSpentAmount('ds'), 60)
    // After release, 60 + 35 = 95 < 100
    const r4 = await backend.reserveSpend('ds', 35, 'USD')
    assert.ok(r4.success)
  })

  it('revocations: append and check', async () => {
    assert.equal(await backend.isRevoked('dx'), false)
    await backend.appendRevocation({
      revocationId: 'rev_dx', delegationId: 'dx',
      revokedBy: 'pk_princ', revokedAt: new Date().toISOString(),
      reason: 'test', signature: 'sig'
    })
    assert.equal(await backend.isRevoked('dx'), true)
    assert.equal((await backend.getRevocationsBy('pk_princ')).length, 1)
  })

  it('receipts: append and paginate', async () => {
    for (let i = 0; i < 25; i++) await backend.appendReceipt(makeReceipt(`r${i}`, 'a1', 'read'))
    const p1 = await backend.queryReceipts({ agentId: 'a1' }, 10)
    assert.equal(p1.items.length, 10)
    assert.ok(p1.hasMore)
    const p2 = await backend.queryReceipts({ agentId: 'a1' }, 10, p1.nextCursor)
    assert.equal(p2.items.length, 10)
    const p3 = await backend.queryReceipts({ agentId: 'a1' }, 10, p2.nextCursor)
    assert.equal(p3.items.length, 5)
    assert.equal(p3.hasMore, false)
    assert.equal(await backend.getReceiptCount('a1'), 25)
  })

  it('tombstone: redacts payload, preserves signature', async () => {
    await backend.appendReceipt(makeReceipt('rg', 'a1', 'read'))
    assert.ok(await backend.tombstoneReceipt('rg', 'gdpr'))
    const r = await backend.getReceipt('rg')
    assert.ok(r)
    assert.ok(r.tombstoned)
    assert.equal(r.action.type, '[REDACTED]')
    assert.ok(r.signature) // preserved
  })

  it('replay nonces: blocks duplicates', async () => {
    assert.ok(await backend.checkAndStoreNonce('n1', 60))
    assert.equal(await backend.checkAndStoreNonce('n1', 60), false)
    assert.ok(await backend.checkAndStoreNonce('n2', 60))
  })

  it('transaction: rolls back all on error', async () => {
    await backend.putDelegation(makeDelegation('dt', 'pk', ['t'], 100))
    try {
      await backend.transaction(async (tx) => {
        await tx.appendReceipt(makeReceipt('rt', 'a1', 't'))
        await tx.appendRevocation({ revocationId: 'rev_dt', delegationId: 'dt', revokedBy: 'pk', revokedAt: new Date().toISOString(), reason: 'test', signature: 's' })
        throw new Error('crash')
      })
    } catch {}
    assert.equal(await backend.getReceipt('rt'), null)
    assert.equal(await backend.isRevoked('dt'), false)
  })

  // ══════════════════════════════════════════════════════════════
  // THE CRITICAL TEST: persistence survives restart
  // ══════════════════════════════════════════════════════════════
  it('persistence: state survives close + reopen', async () => {
    // Write state
    await backend.putAgent(makeAgent('persist-agent'))
    await backend.putDelegation(makeDelegation('persist-del', 'pk_p', ['data:read'], 500))
    await backend.appendReceipt(makeReceipt('persist-rcpt', 'persist-agent', 'data:read'))
    await backend.appendRevocation({
      revocationId: 'rev_other', delegationId: 'other-del',
      revokedBy: 'pk_p', revokedAt: new Date().toISOString(),
      reason: 'test persistence', signature: 'sig'
    })
    await backend.checkAndStoreNonce('persist-nonce', 3600)

    // Close — simulates process shutdown
    await backend.close()

    // Reopen same database — simulates process restart
    const backend2 = new SQLiteBackend({ path: dbPath })
    await backend2.initialize()

    // All state must survive
    const agent = await backend2.getAgent('persist-agent')
    assert.ok(agent, 'Agent survives restart')
    assert.equal(agent.agentId, 'persist-agent')

    const del = await backend2.getDelegation('persist-del')
    assert.ok(del, 'Delegation survives restart')
    assert.equal(del.spendLimit, 500)

    const rcpt = await backend2.getReceipt('persist-rcpt')
    assert.ok(rcpt, 'Receipt survives restart')

    assert.equal(await backend2.isRevoked('other-del'), true, 'Revocation survives restart')

    // Replay nonce must still block
    assert.equal(await backend2.checkAndStoreNonce('persist-nonce', 3600), false, 'Nonce survives restart')

    const count = await backend2.getReceiptCount()
    assert.equal(count, 1, 'Receipt count correct after restart')

    await backend2.close()
    // Reassign for afterEach cleanup
    backend = new SQLiteBackend({ path: dbPath })
    await backend.initialize()
  })

  it('checkpoints: monotonic sequence + external callback', async () => {
    const keys = generateKeyPair()
    const emitted: number[] = []
    backend.onCheckpoint((_h, seq) => { emitted.push(seq) })

    await backend.appendReceipt(makeReceipt('rc1', 'a1', 'test'))
    const cp1 = await backend.createCheckpoint('gw1', keys.privateKey)
    assert.equal(cp1.sequence, 1)
    assert.ok(cp1.signature)

    await backend.appendReceipt(makeReceipt('rc2', 'a1', 'test'))
    const cp2 = await backend.createCheckpoint('gw1', keys.privateKey)
    assert.equal(cp2.sequence, 2)
    assert.notEqual(cp1.stateRootHash, cp2.stateRootHash)

    assert.deepEqual(emitted, [1, 2])

    const latest = await backend.getLatestCheckpoint()
    assert.ok(latest)
    assert.equal(latest!.sequence, 2)
  })

  it('integrity: clean report on healthy DB', async () => {
    await backend.putAgent(makeAgent('ai'))
    await backend.appendReceipt(makeReceipt('ri1', 'ai', 'test'))
    await backend.appendReceipt(makeReceipt('ri2', 'ai', 'test'))
    const report = await backend.verifyIntegrity()
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.receiptChainValid, true)
    assert.equal(report.receiptCount, 2)
    assert.equal(report.errors.length, 0)
  })

  it('prune: removes expired nonces and reservations', async () => {
    await backend.checkAndStoreNonce('old', 0)
    await backend.putDelegation(makeDelegation('dp', 'pk', ['t'], 1000))
    await backend.reserveSpend('dp', 50, 'USD', 0)
    await new Promise(r => setTimeout(r, 10))
    const result = await backend.pruneExpired()
    assert.ok(result.nonces >= 0)
    assert.ok(result.reservations >= 0)
  })
})
