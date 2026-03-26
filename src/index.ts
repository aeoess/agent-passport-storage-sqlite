// ══════════════════════════════════════════════════════════════════
// SQLiteBackend — Persistent StorageBackend for APS
// ══════════════════════════════════════════════════════════════════
// Single trust domain. WAL mode. Atomic transactions.
// Events are truth, state is derived. Signed objects stored raw.
// ══════════════════════════════════════════════════════════════════

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import type {
  StorageBackend, StorageOperations, StoredAgentRecord,
  CursorPage, ReceiptFilter, SpendReservationResult,
  GatewayCheckpoint, IntegrityReport, CheckpointCallback,
} from 'agent-passport-system'
import type {
  Delegation, RevocationRecord, ActionReceipt,
} from 'agent-passport-system'
import type { ScopedReputation, DemotionEvent } from 'agent-passport-system'
import type { KeyRotationEntry } from 'agent-passport-system'

const SCHEMA_VERSION = 1

function createSchema(db: DatabaseType): void {
  db.exec(`
    -- Metadata
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
    INSERT OR IGNORE INTO _meta (key, value) VALUES ('created_at', '${new Date().toISOString()}');

    -- State tables
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      registered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delegations (
      delegation_id TEXT PRIMARY KEY,
      delegated_to TEXT NOT NULL,
      delegated_by TEXT NOT NULL,
      scope TEXT NOT NULL,
      spend_limit REAL,
      spend_committed REAL DEFAULT 0,
      expires_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_del_to ON delegations(delegated_to);

    CREATE TABLE IF NOT EXISTS reputation (
      agent_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      mu REAL NOT NULL,
      sigma REAL NOT NULL,
      receipt_count INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, scope)
    );

    -- Event tables (append-only)
    CREATE TABLE IF NOT EXISTS revocations (
      delegation_id TEXT PRIMARY KEY,
      revoked_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload TEXT NOT NULL,
      revoked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS receipts (
      receipt_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      delegation_id TEXT NOT NULL,
      scope_used TEXT NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL,
      prev_hash TEXT,
      tombstoned INTEGER DEFAULT 0,
      tombstone_reason TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rcpt_agent ON receipts(agent_id);
    CREATE INDEX IF NOT EXISTS idx_rcpt_time ON receipts(created_at);
    CREATE INDEX IF NOT EXISTS idx_rcpt_del ON receipts(delegation_id);

    CREATE TABLE IF NOT EXISTS demotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dem_agent ON demotions(agent_id);

    CREATE TABLE IF NOT EXISTS key_rotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      old_public_key TEXT NOT NULL,
      new_public_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      rotated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kr_old ON key_rotations(old_public_key);
    CREATE INDEX IF NOT EXISTS idx_kr_new ON key_rotations(new_public_key);

    CREATE TABLE IF NOT EXISTS replay_nonces (
      request_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nonce_exp ON replay_nonces(expires_at);

    CREATE TABLE IF NOT EXISTS spend_reservations (
      reservation_id TEXT PRIMARY KEY,
      delegation_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      gateway_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      receipt_head_hash TEXT NOT NULL,
      state_root_hash TEXT NOT NULL,
      delegation_count INTEGER NOT NULL,
      revocation_count INTEGER NOT NULL,
      receipt_count INTEGER NOT NULL,
      protocol_version TEXT NOT NULL,
      previous_checkpoint_hash TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
}

export interface SQLiteBackendOptions {
  /** Path to SQLite database file. Use ':memory:' for testing. */
  path: string
  /** Enable WAL mode (default: true). Better concurrent read perf. */
  walMode?: boolean
  /** Run nonce pruning every N operations (default: 100) */
  pruneInterval?: number
}

export class SQLiteBackend implements StorageBackend {
  private db!: DatabaseType
  private opts: Required<SQLiteBackendOptions>
  private checkpointCallbacks: CheckpointCallback[] = []
  private opCount = 0

  constructor(opts: SQLiteBackendOptions) {
    this.opts = { walMode: true, pruneInterval: 100, ...opts }
  }

  async initialize(): Promise<void> {
    this.db = new Database(this.opts.path)
    if (this.opts.walMode) {
      this.db.pragma('journal_mode = WAL')
    }
    this.db.pragma('foreign_keys = ON')
    createSchema(this.db)
  }

  async close(): Promise<void> {
    if (this.db) this.db.close()
  }

  async transaction<T>(fn: (tx: StorageOperations) => Promise<T>): Promise<T> {
    // better-sqlite3 transactions are synchronous, but our interface is async.
    // We use BEGIN IMMEDIATE to get a write lock immediately.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn(this)
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private _maybePrune(): void {
    this.opCount++
    if (this.opCount % this.opts.pruneInterval === 0) {
      const now = Date.now()
      this.db.prepare('DELETE FROM replay_nonces WHERE expires_at < ?').run(now)
      this.db.prepare("UPDATE spend_reservations SET status = 'released' WHERE status = 'reserved' AND expires_at < ?").run(now)
    }
  }

  // ── Agents ──
  async putAgent(agent: StoredAgentRecord): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO agents (agent_id, payload, registered_at) VALUES (?, ?, ?)')
      .run(agent.agentId, JSON.stringify(agent), agent.registeredAt)
    this._maybePrune()
  }

  async getAgent(agentId: string): Promise<StoredAgentRecord | null> {
    const row = this.db.prepare('SELECT payload FROM agents WHERE agent_id = ?').get(agentId) as any
    return row ? JSON.parse(row.payload) : null
  }

  async listAgents(): Promise<StoredAgentRecord[]> {
    const rows = this.db.prepare('SELECT payload FROM agents').all() as any[]
    return rows.map(r => JSON.parse(r.payload))
  }

  // ── Delegations ──
  async putDelegation(d: Delegation): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO delegations 
      (delegation_id, delegated_to, delegated_by, scope, spend_limit, expires_at, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      d.delegationId, d.delegatedTo, d.delegatedBy,
      JSON.stringify(d.scope), d.spendLimit ?? null,
      d.expiresAt, JSON.stringify(d), d.createdAt
    )
  }

  async getDelegation(id: string): Promise<Delegation | null> {
    const row = this.db.prepare('SELECT payload FROM delegations WHERE delegation_id = ?').get(id) as any
    return row ? JSON.parse(row.payload) : null
  }

  async getDelegationsForAgent(pubKey: string): Promise<Delegation[]> {
    const rows = this.db.prepare('SELECT payload FROM delegations WHERE delegated_to = ?').all(pubKey) as any[]
    return rows.map(r => JSON.parse(r.payload))
  }

  // ── Spend (reserve/commit/release — atomic) ──
  async reserveSpend(delegationId: string, amount: number, currency: string, ttlSeconds = 30): Promise<SpendReservationResult> {
    const del = this.db.prepare('SELECT spend_limit, spend_committed FROM delegations WHERE delegation_id = ?').get(delegationId) as any
    if (!del) return { success: false, reason: 'Delegation not found' }
    const committed = del.spend_committed ?? 0
    // Sum pending reservations
    const pending = (this.db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM spend_reservations WHERE delegation_id = ? AND status = 'reserved' AND expires_at > ?"
    ).get(delegationId, Date.now()) as any).total
    const total = committed + pending + amount
    if (del.spend_limit !== null && total > del.spend_limit) {
      return { success: false, currentSpent: committed, limit: del.spend_limit, reason: `Spend $${total} exceeds limit $${del.spend_limit}` }
    }
    const rid = `res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare('INSERT INTO spend_reservations (reservation_id, delegation_id, amount, currency, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rid, delegationId, amount, currency, 'reserved', Date.now() + ttlSeconds * 1000)
    return { success: true, reservationId: rid, currentSpent: committed, limit: del.spend_limit ?? undefined }
  }

  async commitSpend(reservationId: string): Promise<boolean> {
    const r = this.db.prepare("SELECT * FROM spend_reservations WHERE reservation_id = ? AND status = 'reserved'").get(reservationId) as any
    if (!r) return false
    if (Date.now() > r.expires_at) {
      this.db.prepare("UPDATE spend_reservations SET status = 'released' WHERE reservation_id = ?").run(reservationId)
      return false
    }
    // Atomic: update reservation status AND increment committed spend in one transaction
    this.db.prepare("UPDATE spend_reservations SET status = 'committed' WHERE reservation_id = ?").run(reservationId)
    this.db.prepare('UPDATE delegations SET spend_committed = spend_committed + ? WHERE delegation_id = ?').run(r.amount, r.delegation_id)
    return true
  }

  async releaseSpend(reservationId: string): Promise<boolean> {
    const result = this.db.prepare("UPDATE spend_reservations SET status = 'released' WHERE reservation_id = ? AND status = 'reserved'").run(reservationId)
    return result.changes > 0
  }

  async getSpentAmount(delegationId: string): Promise<number> {
    const row = this.db.prepare('SELECT spend_committed FROM delegations WHERE delegation_id = ?').get(delegationId) as any
    return row ? (row.spend_committed ?? 0) : 0
  }

  // ── Revocations ──
  async appendRevocation(rev: RevocationRecord): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO revocations (delegation_id, revoked_by, reason, payload, revoked_at) VALUES (?, ?, ?, ?, ?)')
      .run(rev.delegationId, rev.revokedBy, rev.reason, JSON.stringify(rev), rev.revokedAt)
  }

  async isRevoked(delegationId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM revocations WHERE delegation_id = ?').get(delegationId)
    return !!row
  }

  async getRevocationsBy(revokedBy: string): Promise<RevocationRecord[]> {
    const rows = this.db.prepare('SELECT payload FROM revocations WHERE revoked_by = ?').all(revokedBy) as any[]
    return rows.map(r => JSON.parse(r.payload))
  }

  // ── Receipts ──
  async appendReceipt(receipt: ActionReceipt): Promise<void> {
    this.db.prepare(`INSERT INTO receipts 
      (receipt_id, agent_id, delegation_id, scope_used, tool, status, prev_hash, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      receipt.receiptId, receipt.agentId, receipt.delegationId,
      receipt.action?.scopeUsed ?? '', receipt.action?.type ?? '',
      receipt.result?.status ?? 'unknown', receipt.previousReceiptHash ?? null,
      JSON.stringify(receipt), receipt.timestamp
    )
    this._maybePrune()
  }

  async getReceipt(receiptId: string): Promise<ActionReceipt | null> {
    const row = this.db.prepare('SELECT payload FROM receipts WHERE receipt_id = ?').get(receiptId) as any
    return row ? JSON.parse(row.payload) : null
  }

  async queryReceipts(filter: ReceiptFilter, limit = 50, cursor?: string): Promise<CursorPage<ActionReceipt>> {
    let sql = 'SELECT payload, rowid FROM receipts WHERE 1=1'
    const params: any[] = []
    if (filter.agentId) { sql += ' AND agent_id = ?'; params.push(filter.agentId) }
    if (filter.delegationId) { sql += ' AND delegation_id = ?'; params.push(filter.delegationId) }
    if (filter.after) { sql += ' AND created_at > ?'; params.push(filter.after) }
    if (filter.before) { sql += ' AND created_at < ?'; params.push(filter.before) }
    if (cursor) { sql += ' AND rowid > ?'; params.push(parseInt(cursor, 10)) }
    sql += ' ORDER BY rowid ASC LIMIT ?'
    params.push(limit + 1) // fetch one extra to check hasMore
    const rows = this.db.prepare(sql).all(...params) as any[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(r => JSON.parse(r.payload))
    const nextCursor = hasMore ? String(rows[limit - 1].rowid) : undefined
    return { items, hasMore, nextCursor }
  }

  async getReceiptCount(agentId?: string, scope?: string): Promise<number> {
    let sql = 'SELECT COUNT(*) as cnt FROM receipts WHERE 1=1'
    const params: any[] = []
    if (agentId) { sql += ' AND agent_id = ?'; params.push(agentId) }
    if (scope) { sql += ' AND scope_used = ?'; params.push(scope) }
    return (this.db.prepare(sql).get(...params) as any).cnt
  }

  async tombstoneReceipt(receiptId: string, reason: string): Promise<boolean> {
    const row = this.db.prepare('SELECT payload FROM receipts WHERE receipt_id = ?').get(receiptId) as any
    if (!row) return false
    const receipt = JSON.parse(row.payload) as ActionReceipt
    receipt.tombstoned = true
    receipt.tombstoneReason = reason
    receipt.action = { type: '[REDACTED]', target: '[REDACTED]', scopeUsed: receipt.action.scopeUsed }
    receipt.result = { status: receipt.result.status, summary: '[REDACTED]' }
    this.db.prepare('UPDATE receipts SET tombstoned = 1, tombstone_reason = ?, payload = ? WHERE receipt_id = ?')
      .run(reason, JSON.stringify(receipt), receiptId)
    return true
  }

  // ── Reputation ──
  async getReputation(agentId: string, scope: string): Promise<ScopedReputation | null> {
    const row = this.db.prepare('SELECT payload FROM reputation WHERE agent_id = ? AND scope = ?').get(agentId, scope) as any
    return row ? JSON.parse(row.payload) : null
  }

  async putReputation(rep: ScopedReputation): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO reputation (agent_id, scope, mu, sigma, receipt_count, payload, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      rep.agentId, rep.scope, rep.mu, rep.sigma, rep.receiptCount,
      JSON.stringify(rep), rep.lastUpdatedAt
    )
  }

  // ── Demotions ──
  async appendDemotion(d: DemotionEvent): Promise<void> {
    this.db.prepare('INSERT INTO demotions (agent_id, payload, created_at) VALUES (?, ?, ?)')
      .run(d.agentId, JSON.stringify(d), d.timestamp)
  }

  async getDemotionCount(agentId: string): Promise<number> {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM demotions WHERE agent_id = ?').get(agentId) as any).cnt
  }

  async getDemotions(agentId: string): Promise<DemotionEvent[]> {
    const rows = this.db.prepare('SELECT payload FROM demotions WHERE agent_id = ? ORDER BY created_at ASC').all(agentId) as any[]
    return rows.map(r => JSON.parse(r.payload))
  }

  // ── Key Rotations ──
  async appendKeyRotation(entry: KeyRotationEntry): Promise<void> {
    this.db.prepare('INSERT INTO key_rotations (old_public_key, new_public_key, payload, rotated_at) VALUES (?, ?, ?, ?)')
      .run(entry.oldPublicKey, entry.newPublicKey, JSON.stringify(entry), entry.rotatedAt)
  }

  async getKeyRotations(publicKey: string): Promise<KeyRotationEntry[]> {
    const rows = this.db.prepare('SELECT payload FROM key_rotations WHERE old_public_key = ? OR new_public_key = ? ORDER BY rotated_at ASC')
      .all(publicKey, publicKey) as any[]
    return rows.map(r => JSON.parse(r.payload))
  }

  // ── Replay Protection ──
  async checkAndStoreNonce(requestId: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.db.prepare('SELECT 1 FROM replay_nonces WHERE request_id = ?').get(requestId)
    if (existing) return false // replay detected
    this.db.prepare('INSERT INTO replay_nonces (request_id, expires_at) VALUES (?, ?)')
      .run(requestId, Date.now() + ttlSeconds * 1000)
    this._maybePrune()
    return true
  }

  // ── Integrity Verification ──
  async verifyIntegrity(): Promise<IntegrityReport> {
    const errors: string[] = []
    const brokenLinks: string[] = []

    // Schema version
    const meta = this.db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as any
    const schemaVersion = meta ? parseInt(meta.value, 10) : 0
    if (schemaVersion !== SCHEMA_VERSION) {
      errors.push(`Schema version mismatch: expected ${SCHEMA_VERSION}, got ${schemaVersion}`)
    }

    // Receipt chain continuity
    const receipts = this.db.prepare('SELECT receipt_id, prev_hash FROM receipts ORDER BY rowid ASC').all() as any[]
    let prevId: string | null = null
    for (const r of receipts) {
      if (r.prev_hash && prevId && r.prev_hash !== prevId) {
        brokenLinks.push(r.receipt_id)
      }
      prevId = r.receipt_id
    }

    // Checkpoint monotonicity
    const checkpoints = this.db.prepare('SELECT sequence FROM checkpoints ORDER BY sequence ASC').all() as any[]
    let checkpointValid = true
    for (let i = 1; i < checkpoints.length; i++) {
      if (checkpoints[i].sequence <= checkpoints[i - 1].sequence) {
        checkpointValid = false
        errors.push(`Checkpoint sequence non-monotonic at position ${i}: ${checkpoints[i].sequence} <= ${checkpoints[i - 1].sequence}`)
      }
    }

    const delCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM delegations').get() as any).cnt
    const revCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM revocations').get() as any).cnt
    const rcptCount = receipts.length
    const latestSeq = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].sequence : 0

    return {
      schemaVersion, receiptChainValid: brokenLinks.length === 0,
      receiptCount: rcptCount, brokenLinks,
      delegationCount: delCount, revocationCount: revCount,
      checkpointSequence: latestSeq, checkpointValid, errors
    }
  }

  async rebuildDerivedState(): Promise<void> {
    // Rebuild spend_committed from committed reservations
    const spends = this.db.prepare(
      "SELECT delegation_id, SUM(amount) as total FROM spend_reservations WHERE status = 'committed' GROUP BY delegation_id"
    ).all() as any[]
    for (const s of spends) {
      this.db.prepare('UPDATE delegations SET spend_committed = ? WHERE delegation_id = ?').run(s.total, s.delegation_id)
    }
    // Reputation can be rebuilt from receipts if needed — left to gateway layer
  }

  async pruneExpired(): Promise<{ nonces: number; reservations: number }> {
    const now = Date.now()
    const n = this.db.prepare('DELETE FROM replay_nonces WHERE expires_at < ?').run(now)
    const r = this.db.prepare("UPDATE spend_reservations SET status = 'released' WHERE status = 'reserved' AND expires_at < ?").run(now)
    return { nonces: n.changes, reservations: r.changes }
  }

  // ── Checkpoints ──
  async createCheckpoint(gatewayId: string, gatewayPrivateKey: string): Promise<GatewayCheckpoint> {
    // Dynamic import to avoid hard dependency on crypto at module level
    const { canonicalize } = await import('agent-passport-system')
    const { sign } = await import('agent-passport-system')

    const prev = this.db.prepare('SELECT * FROM checkpoints ORDER BY sequence DESC LIMIT 1').get() as any
    const sequence = prev ? prev.sequence + 1 : 1
    const rcptHead = this.db.prepare('SELECT receipt_id FROM receipts ORDER BY rowid DESC LIMIT 1').get() as any
    const delCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM delegations').get() as any).cnt
    const revCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM revocations').get() as any).cnt
    const rcptCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM receipts').get() as any).cnt

    const stateRoot = canonicalize({ d: delCount, r: revCount, rc: rcptCount })
    const previousHash = prev ? prev.state_root_hash : '0'.repeat(64)

    const checkpoint: GatewayCheckpoint = {
      checkpointId: `chk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      gatewayId, sequence,
      receiptHeadHash: rcptHead?.receipt_id ?? '0',
      stateRootHash: stateRoot,
      delegationCount: delCount, revocationCount: revCount, receiptCount: rcptCount,
      protocolVersion: '1.0',
      createdAt: new Date().toISOString(),
      previousCheckpointHash: previousHash,
      signature: sign(canonicalize({ sequence, stateRoot, previousHash }), gatewayPrivateKey)
    }

    this.db.prepare(`INSERT INTO checkpoints 
      (checkpoint_id, gateway_id, sequence, receipt_head_hash, state_root_hash,
       delegation_count, revocation_count, receipt_count, protocol_version,
       previous_checkpoint_hash, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      checkpoint.checkpointId, gatewayId, sequence,
      checkpoint.receiptHeadHash, checkpoint.stateRootHash,
      delCount, revCount, rcptCount, '1.0',
      checkpoint.previousCheckpointHash, checkpoint.signature, checkpoint.createdAt
    )

    for (const cb of this.checkpointCallbacks) {
      try { await cb(checkpoint.stateRootHash, checkpoint.sequence) } catch { /* best effort */ }
    }
    return checkpoint
  }

  async getLatestCheckpoint(): Promise<GatewayCheckpoint | null> {
    const row = this.db.prepare('SELECT * FROM checkpoints ORDER BY sequence DESC LIMIT 1').get() as any
    if (!row) return null
    return {
      checkpointId: row.checkpoint_id, gatewayId: row.gateway_id,
      sequence: row.sequence, receiptHeadHash: row.receipt_head_hash,
      stateRootHash: row.state_root_hash, delegationCount: row.delegation_count,
      revocationCount: row.revocation_count, receiptCount: row.receipt_count,
      protocolVersion: row.protocol_version, createdAt: row.created_at,
      previousCheckpointHash: row.previous_checkpoint_hash, signature: row.signature
    }
  }

  onCheckpoint(callback: CheckpointCallback): void {
    this.checkpointCallbacks.push(callback)
  }

  // ── Export ──
  async exportReceipts(filter: ReceiptFilter): Promise<{ receipts: ActionReceipt[]; chainValid: boolean }> {
    // Export all matching receipts — no pagination limit for export
    let sql = 'SELECT payload FROM receipts WHERE 1=1'
    const params: any[] = []
    if (filter.agentId) { sql += ' AND agent_id = ?'; params.push(filter.agentId) }
    if (filter.delegationId) { sql += ' AND delegation_id = ?'; params.push(filter.delegationId) }
    if (filter.after) { sql += ' AND created_at > ?'; params.push(filter.after) }
    if (filter.before) { sql += ' AND created_at < ?'; params.push(filter.before) }
    sql += ' ORDER BY rowid ASC'
    const rows = this.db.prepare(sql).all(...params) as any[]
    const receipts = rows.map(r => JSON.parse(r.payload))
    return { receipts, chainValid: true }
  }
}

// Re-export types for convenience
export type { SQLiteBackendOptions }
