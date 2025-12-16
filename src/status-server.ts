import * as http from 'http';
import * as crypto from 'crypto';
import { getConfig } from './config.js';
import {
    getLastRound,
    getLockStatus,
    isBotOnline,
    getHeartbeatAge,
    isSafeMode,
    getSafeModeReason,
} from './db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Status Response Type
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusResponse {
    // Meta
    now: number;
    sourceOfTruth: 'server';
    checksum: string;

    // Bot state
    botOnline: boolean;
    heartbeatAgeSeconds: number;
    safeMode: boolean;
    safeModeReason: string | null;
    dryRun: boolean;

    // Timestamps
    lastBuyTs: number | null;
    lastRewardTs: number | null;
    nextBuyTs: number | null;
    nextRewardTs: number | null;

    // Intervals
    buyIntervalSeconds: number;
    rewardIntervalSeconds: number;

    // In-progress flags
    buyInProgress: boolean;
    rewardInProgress: boolean;

    // Transaction references
    lastBuyTx: string | null;
    lastRewardTxs: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting (in-memory, per-IP)
// ─────────────────────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute

interface RateLimitEntry {
    count: number;
    windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        // New window
        rateLimitMap.set(ip, { count: 1, windowStart: now });
        return true;
    }

    if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
        return false; // Rate limited
    }

    entry.count++;
    return true;
}

// Cleanup old entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap.entries()) {
        if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
            rateLimitMap.delete(ip);
        }
    }
}, 60000);

// ─────────────────────────────────────────────────────────────────────────────
// Build Status with Checksum
// ─────────────────────────────────────────────────────────────────────────────

function buildStatus(): StatusResponse {
    const config = getConfig();
    const now = Math.floor(Date.now() / 1000);

    // Get last rounds
    const lastBuyRound = getLastRound('buy');
    const lastRewardRound = getLastRound('reward');

    // Get lock status
    const locks = getLockStatus();

    // Parse transactions from rounds
    let lastBuyTx: string | null = null;
    let lastRewardTxs: string[] = [];

    if (lastBuyRound?.txs_json) {
        try {
            const txs = JSON.parse(lastBuyRound.txs_json);
            lastBuyTx = Array.isArray(txs) && txs.length > 0 ? txs[0] : null;
        } catch { }
    }

    if (lastRewardRound?.txs_json) {
        try {
            lastRewardTxs = JSON.parse(lastRewardRound.txs_json) || [];
        } catch { }
    }

    // Calculate next timestamps
    const lastBuyTs = lastBuyRound?.ts ?? null;
    const lastRewardTs = lastRewardRound?.ts ?? null;

    const nextBuyTs = lastBuyTs !== null
        ? lastBuyTs + config.buyIntervalSeconds
        : null;
    const nextRewardTs = lastRewardTs !== null
        ? lastRewardTs + config.rewardIntervalSeconds
        : null;

    // Build response without checksum first
    const heartbeatAgeSeconds = getHeartbeatAge();
    const safeMode = isSafeMode();

    const response: Omit<StatusResponse, 'checksum'> = {
        now,
        sourceOfTruth: 'server',
        botOnline: isBotOnline(60),
        heartbeatAgeSeconds: heartbeatAgeSeconds === Infinity ? -1 : heartbeatAgeSeconds,
        safeMode,
        safeModeReason: safeMode ? getSafeModeReason() : null,
        dryRun: config.dryRun,

        lastBuyTs,
        lastRewardTs,
        nextBuyTs,
        nextRewardTs,

        buyIntervalSeconds: config.buyIntervalSeconds,
        rewardIntervalSeconds: config.rewardIntervalSeconds,

        buyInProgress: locks.buyInProgress,
        rewardInProgress: locks.rewardInProgress,

        lastBuyTx,
        lastRewardTxs,
    };

    // Generate checksum of critical fields
    const criticalData = JSON.stringify({
        now: response.now,
        botOnline: response.botOnline,
        safeMode: response.safeMode,
        lastBuyTs: response.lastBuyTs,
        lastRewardTs: response.lastRewardTs,
        nextBuyTs: response.nextBuyTs,
        nextRewardTs: response.nextRewardTs,
    });
    const checksum = crypto.createHash('sha256').update(criticalData).digest('hex').slice(0, 16);

    return { ...response, checksum };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────────────────────────────

let server: http.Server | null = null;

export function startStatusServer(): void {
    const config = getConfig();
    const port = config.statusServerPort;
    const allowedOrigin = config.statusAllowedOrigin;

    server = http.createServer((req, res) => {
        // Get client IP
        const ip = req.socket.remoteAddress || 'unknown';

        // Reject non-GET/OPTIONS methods immediately
        if (req.method !== 'GET' && req.method !== 'OPTIONS') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        // CORS headers - strict mode (no wildcards in production)
        const origin = req.headers.origin || '';

        if (allowedOrigin === '*') {
            // Development mode - allow all
            res.setHeader('Access-Control-Allow-Origin', '*');
        } else if (origin === allowedOrigin) {
            // Production mode - exact match only
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }
        // If origin doesn't match, no CORS header = browser blocks

        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

        // Handle preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Rate limiting
        if (!checkRateLimit(ip)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Rate limit exceeded',
                retryAfterSeconds: 60,
            }));
            return;
        }

        // Only handle GET /status
        if (req.url !== '/status') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        try {
            const status = buildStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status));
        } catch (err) {
            console.error('[STATUS] Error building status:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    });

    server.listen(port, () => {
        console.log(`[STATUS] Server listening on port ${port}`);
        console.log(`[STATUS] Allowed origin: ${allowedOrigin}`);
        console.log(`[STATUS] Rate limit: ${RATE_LIMIT_MAX_REQUESTS} req/min per IP`);
    });
}

export function stopStatusServer(): void {
    if (server) {
        server.close();
        server = null;
        console.log('[STATUS] Server stopped');
    }
}
