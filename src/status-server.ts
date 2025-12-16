import * as http from 'http';
import { getConfig } from './config';
import { getLastRound, getLockStatus, isBotOnline, RoundRow } from './db';

// ─────────────────────────────────────────────────────────────────────────────
// Status Response Type
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusResponse {
    now: number;
    botOnline: boolean;
    dryRun: boolean;

    lastBuyTs: number | null;
    lastRewardTs: number | null;

    nextBuyTs: number | null;
    nextRewardTs: number | null;

    buyIntervalSeconds: number;
    rewardIntervalSeconds: number;

    buyInProgress: boolean;
    rewardInProgress: boolean;

    lastBuyTx: string | null;
    lastRewardTxs: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Status
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

    return {
        now,
        botOnline: isBotOnline(60), // Online if heartbeat within 60s
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
        // CORS headers
        const origin = req.headers.origin || '';

        // Allow configured origin or any origin if '*'
        if (allowedOrigin === '*' || origin === allowedOrigin) {
            res.setHeader('Access-Control-Allow-Origin', allowedOrigin === '*' ? '*' : origin);
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        // Handle preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Only handle GET /status
        if (req.method !== 'GET' || req.url !== '/status') {
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
    });
}

export function stopStatusServer(): void {
    if (server) {
        server.close();
        server = null;
        console.log('[STATUS] Server stopped');
    }
}
