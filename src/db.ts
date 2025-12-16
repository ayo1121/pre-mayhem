import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// Database Interface Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HolderRow {
    wallet: string;
    first_seen_ts: number | null;
    last_seen_ts: number | null;
    last_balance_raw: string | null;
    last_balance_check_ts: number | null;
    last_decrease_ts: number | null;
    continuity_start_ts: number | null;
    streak_rounds: number;
    twb_score: number;
    cumulative_buy_sol: number;
    cumulative_buy_sol_low_confidence: number;
    is_blacklisted: number;
}

export interface RoundRow {
    round_id: string;
    type: 'buy' | 'reward';
    ts: number;
    txs_json: string;
    meta_json: string;
}

export interface ScanStateRow {
    key: string;
    value: string;
}

export interface ExecutionLockRow {
    lock_type: string;
    acquired_ts: number;
    pid: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Definition
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = `
-- Holders table: tracks all token holders and their eligibility data
CREATE TABLE IF NOT EXISTS holders (
  wallet TEXT PRIMARY KEY,
  first_seen_ts INTEGER,
  last_seen_ts INTEGER,
  last_balance_raw TEXT,
  last_balance_check_ts INTEGER,
  last_decrease_ts INTEGER,
  continuity_start_ts INTEGER,
  streak_rounds INTEGER DEFAULT 0,
  twb_score REAL DEFAULT 0.0,
  cumulative_buy_sol REAL DEFAULT 0.0,
  cumulative_buy_sol_low_confidence REAL DEFAULT 0.0,
  is_blacklisted INTEGER DEFAULT 0
);

-- Rounds table: tracks buy and reward rounds
CREATE TABLE IF NOT EXISTS rounds (
  round_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  txs_json TEXT,
  meta_json TEXT
);

-- Scan state: tracks indexing progress
CREATE TABLE IF NOT EXISTS scan_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Execution locks: prevents overlapping job execution
CREATE TABLE IF NOT EXISTS execution_locks (
  lock_type TEXT PRIMARY KEY,
  acquired_ts INTEGER NOT NULL,
  pid INTEGER NOT NULL
);

-- Bot heartbeat: used to determine if bot is online
CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_holders_eligible ON holders(
  is_blacklisted, cumulative_buy_sol, first_seen_ts
);

CREATE INDEX IF NOT EXISTS idx_rounds_type_ts ON rounds(type, ts);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Database Class
// ─────────────────────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function initDb(): Database.Database {
    if (_db) return _db;

    const config = getConfig();

    // Ensure data directory exists
    const dataDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    _db = new Database(config.dbPath);
    _db.pragma('journal_mode = WAL');
    _db.exec(SCHEMA);

    console.log(`[DB] Initialized database at ${config.dbPath}`);
    return _db;
}

export function getDb(): Database.Database {
    if (!_db) {
        return initDb();
    }
    return _db;
}

export function closeDb(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution Lock Functions
// ─────────────────────────────────────────────────────────────────────────────

export type LockType = 'buy_job' | 'reward_job';

/**
 * Attempt to acquire an execution lock.
 * Returns true if lock acquired, false if already held.
 */
export function acquireLock(lockType: LockType): boolean {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const pid = process.pid;

    try {
        // Try to insert lock
        db.prepare(`
            INSERT INTO execution_locks (lock_type, acquired_ts, pid)
            VALUES (?, ?, ?)
        `).run(lockType, now, pid);

        console.log(`[LOCK] Acquired ${lockType} lock (pid: ${pid})`);
        return true;
    } catch (err) {
        // Lock already exists
        console.log(`[LOCK] Failed to acquire ${lockType} - already held`);
        return false;
    }
}

/**
 * Release an execution lock.
 */
export function releaseLock(lockType: LockType): void {
    const db = getDb();

    db.prepare('DELETE FROM execution_locks WHERE lock_type = ?').run(lockType);
    console.log(`[LOCK] Released ${lockType} lock`);
}

/**
 * Check if a lock is currently held.
 */
export function isLockHeld(lockType: LockType): boolean {
    const db = getDb();
    const row = db.prepare('SELECT * FROM execution_locks WHERE lock_type = ?')
        .get(lockType) as ExecutionLockRow | undefined;
    return row !== undefined;
}

/**
 * Clear stale locks that are older than maxAge seconds.
 * Called on startup to clean up after crashes.
 */
export function clearStaleLocks(maxAgeSeconds: number): void {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - maxAgeSeconds;

    const result = db.prepare(`
        DELETE FROM execution_locks WHERE acquired_ts < ?
    `).run(cutoff);

    if (result.changes > 0) {
        console.log(`[LOCK] Cleared ${result.changes} stale lock(s) older than ${maxAgeSeconds}s`);
    }
}

/**
 * Get lock status for status API.
 */
export function getLockStatus(): { buyInProgress: boolean; rewardInProgress: boolean } {
    return {
        buyInProgress: isLockHeld('buy_job'),
        rewardInProgress: isLockHeld('reward_job'),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot Heartbeat Functions
// ─────────────────────────────────────────────────────────────────────────────

const HEARTBEAT_KEY = 'heartbeat_ts';

/**
 * Update bot heartbeat timestamp.
 */
export function updateHeartbeat(): void {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
        INSERT INTO bot_state (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(HEARTBEAT_KEY, now.toString());
}

/**
 * Get last heartbeat timestamp.
 */
export function getHeartbeat(): number | null {
    const db = getDb();
    const row = db.prepare('SELECT value FROM bot_state WHERE key = ?')
        .get(HEARTBEAT_KEY) as { value: string } | undefined;

    return row ? parseInt(row.value, 10) : null;
}

/**
 * Check if bot is online based on heartbeat.
 * Bot is considered online if heartbeat is within the last 60 seconds.
 */
export function isBotOnline(maxHeartbeatAgeSeconds: number = 60): boolean {
    const heartbeat = getHeartbeat();
    if (!heartbeat) return false;

    const now = Math.floor(Date.now() / 1000);
    return (now - heartbeat) < maxHeartbeatAgeSeconds;
}

/**
 * Get heartbeat age in seconds.
 */
export function getHeartbeatAge(): number {
    const heartbeat = getHeartbeat();
    if (!heartbeat) return Infinity;

    const now = Math.floor(Date.now() / 1000);
    return now - heartbeat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe Mode Functions (latching - requires manual exit)
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_MODE_KEY = 'safe_mode';
const SAFE_MODE_REASON_KEY = 'safe_mode_reason';
const RPC_ERROR_COUNT_KEY = 'consecutive_rpc_errors';

/**
 * Enter safe mode (latches until manual exit).
 */
export function enterSafeMode(reason: string): void {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
        INSERT INTO bot_state (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(SAFE_MODE_KEY, now.toString());

    db.prepare(`
        INSERT INTO bot_state (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(SAFE_MODE_REASON_KEY, reason);

    console.log(`[SAFE-MODE] ⚠️ ENTERED SAFE MODE: ${reason}`);
    console.log(`[SAFE-MODE] Bot will NOT execute jobs until manually exited.`);
    console.log(`[SAFE-MODE] Run with --exit-safe-mode to resume operations.`);
}

/**
 * Exit safe mode (manual action required).
 */
export function exitSafeMode(): void {
    const db = getDb();

    db.prepare('DELETE FROM bot_state WHERE key = ?').run(SAFE_MODE_KEY);
    db.prepare('DELETE FROM bot_state WHERE key = ?').run(SAFE_MODE_REASON_KEY);
    db.prepare('DELETE FROM bot_state WHERE key = ?').run(RPC_ERROR_COUNT_KEY);

    console.log(`[SAFE-MODE] ✅ Exited safe mode. Operations resumed.`);
}

/**
 * Check if bot is in safe mode.
 */
export function isSafeMode(): boolean {
    const db = getDb();
    const row = db.prepare('SELECT value FROM bot_state WHERE key = ?')
        .get(SAFE_MODE_KEY) as { value: string } | undefined;

    return row !== undefined;
}

/**
 * Get safe mode reason if in safe mode.
 */
export function getSafeModeReason(): string | null {
    const db = getDb();
    const row = db.prepare('SELECT value FROM bot_state WHERE key = ?')
        .get(SAFE_MODE_REASON_KEY) as { value: string } | undefined;

    return row?.value ?? null;
}

/**
 * Increment consecutive RPC error counter.
 * Returns the new count.
 */
export function incrementRpcErrors(): number {
    const db = getDb();
    const current = getRpcErrorCount();
    const newCount = current + 1;

    db.prepare(`
        INSERT INTO bot_state (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(RPC_ERROR_COUNT_KEY, newCount.toString());

    return newCount;
}

/**
 * Reset RPC error counter (on successful operation).
 */
export function resetRpcErrors(): void {
    const db = getDb();
    db.prepare('DELETE FROM bot_state WHERE key = ?').run(RPC_ERROR_COUNT_KEY);
}

/**
 * Get current RPC error count.
 */
export function getRpcErrorCount(): number {
    const db = getDb();
    const row = db.prepare('SELECT value FROM bot_state WHERE key = ?')
        .get(RPC_ERROR_COUNT_KEY) as { value: string } | undefined;

    return row ? parseInt(row.value, 10) : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Holder Queries
// ─────────────────────────────────────────────────────────────────────────────

export function upsertHolder(wallet: string, updates: Partial<HolderRow>): void {
    const db = getDb();

    // Build upsert query
    const columns = ['wallet', ...Object.keys(updates)];
    const placeholders = columns.map(() => '?').join(', ');
    const updateClauses = Object.keys(updates)
        .map(col => `${col} = excluded.${col}`)
        .join(', ');

    const sql = `
    INSERT INTO holders (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(wallet) DO UPDATE SET ${updateClauses}
  `;

    db.prepare(sql).run(wallet, ...Object.values(updates));
}

export function getHolder(wallet: string): HolderRow | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM holders WHERE wallet = ?').get(wallet) as HolderRow | undefined;
}

export function getAllHolders(): HolderRow[] {
    const db = getDb();
    return db.prepare('SELECT * FROM holders').all() as HolderRow[];
}

export function getEligibleHolders(
    minAgeDays: number,
    minContinuitySeconds: number,
    minCumulativeBuySol: number
): HolderRow[] {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const minAgeTs = now - (minAgeDays * 24 * 60 * 60);
    const minContinuityTs = now - minContinuitySeconds;

    const sql = `
    SELECT * FROM holders
    WHERE is_blacklisted = 0
      AND first_seen_ts IS NOT NULL
      AND first_seen_ts <= ?
      AND continuity_start_ts IS NOT NULL
      AND continuity_start_ts <= ?
      AND cumulative_buy_sol >= ?
      AND last_balance_raw IS NOT NULL
      AND CAST(last_balance_raw AS INTEGER) > 0
  `;

    return db.prepare(sql).all(minAgeTs, minContinuityTs, minCumulativeBuySol) as HolderRow[];
}

export function updateHolderBalance(
    wallet: string,
    balanceRaw: string,
    checkTs: number,
    previousBalanceRaw: string | null
): void {
    const db = getDb();
    const holder = getHolder(wallet);

    const currentBalance = BigInt(balanceRaw);
    const prevBalance = previousBalanceRaw ? BigInt(previousBalanceRaw) : BigInt(0);

    let continuityStartTs = holder?.continuity_start_ts ?? checkTs;
    let streakRounds = holder?.streak_rounds ?? 0;
    let twbScore = holder?.twb_score ?? 0;

    // Check for balance decrease (selling)
    if (currentBalance < prevBalance) {
        // Reset continuity and streak on sell
        continuityStartTs = checkTs;
        streakRounds = 0;
        twbScore = 0;
    }

    upsertHolder(wallet, {
        last_balance_raw: balanceRaw,
        last_balance_check_ts: checkTs,
        last_decrease_ts: currentBalance < prevBalance ? checkTs : holder?.last_decrease_ts ?? null,
        continuity_start_ts: continuityStartTs,
        streak_rounds: streakRounds,
        twb_score: twbScore,
        last_seen_ts: checkTs,
    });
}

export function incrementBuySol(
    wallet: string,
    solAmount: number,
    highConfidence: boolean
): void {
    const db = getDb();
    const holder = getHolder(wallet);

    if (highConfidence) {
        const currentBuy = holder?.cumulative_buy_sol ?? 0;
        upsertHolder(wallet, {
            cumulative_buy_sol: currentBuy + solAmount,
        });
    } else {
        const currentLowConf = holder?.cumulative_buy_sol_low_confidence ?? 0;
        upsertHolder(wallet, {
            cumulative_buy_sol_low_confidence: currentLowConf + solAmount,
        });
    }
}

export function updateStreakAndTwb(
    wallet: string,
    tokenBalanceUi: number,
    rewardIntervalSeconds: number
): void {
    const holder = getHolder(wallet);
    if (!holder) return;

    const twbIncrement = tokenBalanceUi * (rewardIntervalSeconds / 3600);

    upsertHolder(wallet, {
        streak_rounds: holder.streak_rounds + 1,
        twb_score: holder.twb_score + twbIncrement,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Round Queries
// ─────────────────────────────────────────────────────────────────────────────

export function insertRound(round: RoundRow): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO rounds (round_id, type, ts, txs_json, meta_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(round.round_id, round.type, round.ts, round.txs_json, round.meta_json);
}

export function getLastRound(type: 'buy' | 'reward'): RoundRow | undefined {
    const db = getDb();
    return db.prepare(`
    SELECT * FROM rounds WHERE type = ? ORDER BY ts DESC LIMIT 1
  `).get(type) as RoundRow | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan State Queries
// ─────────────────────────────────────────────────────────────────────────────

export function getScanState(key: string): string | null {
    const db = getDb();
    const row = db.prepare('SELECT value FROM scan_state WHERE key = ?').get(key) as ScanStateRow | undefined;
    return row?.value ?? null;
}

export function setScanState(key: string, value: string): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO scan_state (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
