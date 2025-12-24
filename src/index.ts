import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import * as cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, Config } from './config.js';
import {
    initDb,
    closeDb,
    getLastRound,
    clearStaleLocks,
    updateHeartbeat,
    isSafeMode,
    exitSafeMode,
    getSafeModeReason,
} from './db.js';
import { bootstrapScan, incrementalScan } from './scan.js';
import { executeBuyRound } from './buys.js';
import { executeRewardRound } from './rewards.js';
import { startStatusServer, stopStatusServer } from './status-server.js';
import { executeWithLockAndTimeout } from './execution.js';

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface CliArgs {
    bootstrap: boolean;
    onceBuy: boolean;
    onceReward: boolean;
    exitSafeMode: boolean;
}

function parseArgs(): CliArgs {
    const args = process.argv.slice(2);

    return {
        bootstrap: args.includes('--bootstrap'),
        onceBuy: args.includes('--once-buy'),
        onceReward: args.includes('--once-reward'),
        exitSafeMode: args.includes('--exit-safe-mode'),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interval to Cron Expression
// ─────────────────────────────────────────────────────────────────────────────

function secondsToCron(seconds: number): string {
    if (seconds < 60) {
        return '* * * * *';
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        return `*/${minutes} * * * *`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        return `0 */${hours} * * *`;
    }

    return '0 0 * * *';
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup Banner & Safety Checks
// ─────────────────────────────────────────────────────────────────────────────

function maskRpcUrl(url: string): string {
    return url.replace(/api-key=[^&]+/, 'api-key=****');
}

function printStartupBanner(config: Config): void {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  PRE-MAYHEM BOT - PRODUCTION');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('  Configuration:');
    console.log(`    RPC URL:              ${maskRpcUrl(config.rpcUrl)}`);
    console.log(`    Token Mint:           ${config.tokenMint.toBase58()}`);
    console.log(`    Treasury:             ${config.treasuryPubkey.toBase58()}`);
    console.log(`    Buy Interval:         ${config.buyIntervalSeconds}s`);
    console.log(`    Reward Interval:      ${config.rewardIntervalSeconds}s`);
    console.log(`    Buy Timeout:          ${config.buyJobTimeoutMs / 1000}s`);
    console.log(`    Reward Timeout:       ${config.rewardJobTimeoutMs / 1000}s`);
    console.log(`    Min SOL Reserve:      ${config.minSolReserve} SOL`);
    console.log(`    Min Reward Tokens:    ${config.minRewardTokens}`);
    console.log(`    Status Server:        http://localhost:${config.statusServerPort}/status`);
    console.log(`    Dry Run:              ${config.dryRun}`);
    console.log('');

    if (!config.dryRun) {
        console.log('  ╔═══════════════════════════════════════════════════════════╗');
        console.log('  ║   ⚠️  WARNING: DRY_RUN IS DISABLED - REAL TRANSACTIONS!   ║');
        console.log('  ╚═══════════════════════════════════════════════════════════╝');
        console.log('');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ensure Required Directories
// ─────────────────────────────────────────────────────────────────────────────

function ensureDirectories(): void {
    const dirs = ['logs', 'data', 'public'];

    for (const dir of dirs) {
        const dirPath = path.join(process.cwd(), dir);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            console.log(`[INIT] Created directory: ${dir}/`);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Treasury Balance Checks
// ─────────────────────────────────────────────────────────────────────────────

async function getTreasurySolBalance(connection: Connection, config: Config): Promise<number> {
    const balance = await connection.getBalance(config.treasuryPubkey);
    return balance / LAMPORTS_PER_SOL;
}

async function getTreasuryTokenBalance(connection: Connection, config: Config): Promise<bigint> {
    try {
        console.log(`[DEBUG] Looking for token accounts for treasury: ${config.treasuryPubkey.toBase58()}`);
        console.log(`[DEBUG] Token mint: ${config.tokenMint.toBase58()}`);

        // Query ALL token accounts owned by treasury for this mint
        const tokenAccounts = await connection.getTokenAccountsByOwner(
            config.treasuryPubkey,
            { mint: config.tokenMint }
        );

        console.log(`[DEBUG] Found ${tokenAccounts.value.length} token account(s)`);

        if (tokenAccounts.value.length === 0) {
            console.log('[DEBUG] No token accounts found for this mint');
            return BigInt(0);
        }

        // Sum up balances from all token accounts (usually just one)
        let totalBalance = BigInt(0);
        for (const account of tokenAccounts.value) {
            console.log(`[DEBUG] Token account: ${account.pubkey.toBase58()}`);
            // Parse the account data to get the balance
            // Token account data: first 64 bytes are mint (32) + owner (32), then 8 bytes for amount
            const data = account.account.data;
            const amount = data.readBigUInt64LE(64);
            console.log(`[DEBUG] Account balance: ${amount}`);
            totalBalance += amount;
        }

        console.log(`[DEBUG] Total token balance: ${totalBalance}`);
        return totalBalance;
    } catch (err) {
        console.log(`[DEBUG] Error getting token balance: ${err}`);
        return BigInt(0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Timing Guards
// ─────────────────────────────────────────────────────────────────────────────

function shouldRunBuyJob(config: Config): boolean {
    const lastBuyRound = getLastRound('buy');

    if (!lastBuyRound) {
        console.log('[GUARD] No previous buy round found, will run');
        return true;
    }

    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - lastBuyRound.ts;
    const shouldRun = elapsed >= config.buyIntervalSeconds;

    console.log(`[GUARD] Last buy: ${elapsed}s ago, interval: ${config.buyIntervalSeconds}s, should run: ${shouldRun}`);

    return shouldRun;
}

function shouldRunRewardJob(config: Config): boolean {
    const lastRewardRound = getLastRound('reward');

    if (!lastRewardRound) {
        console.log('[GUARD] No previous reward round found, will run');
        return true;
    }

    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - lastRewardRound.ts;
    const shouldRun = elapsed >= config.rewardIntervalSeconds;

    console.log(`[GUARD] Last reward: ${elapsed}s ago, interval: ${config.rewardIntervalSeconds}s, should run: ${shouldRun}`);

    return shouldRun;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown Handler
// ─────────────────────────────────────────────────────────────────────────────

let isShuttingDown = false;
let scanJobRunning = false;
let heartbeatInterval: NodeJS.Timeout | null = null;

async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
        console.log('[SHUTDOWN] Already shutting down, please wait...');
        return;
    }

    isShuttingDown = true;
    console.log('');
    console.log(`[SHUTDOWN] Received ${signal}, starting graceful shutdown...`);

    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }

    stopStatusServer();

    const maxWait = 30000;
    const startTime = Date.now();

    while (scanJobRunning && (Date.now() - startTime < maxWait)) {
        console.log('[SHUTDOWN] Waiting for in-progress scan to complete...');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('[SHUTDOWN] Closing database...');
    closeDb();

    console.log('[SHUTDOWN] Shutdown complete.');
    process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Application
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    ensureDirectories();

    const args = parseArgs();

    let config: Config;
    try {
        config = getConfig();
    } catch (err) {
        console.error('[INIT] Configuration error:', err);
        process.exit(1);
    }

    printStartupBanner(config);

    try {
        initDb();
        console.log('[INIT] Database initialized');
    } catch (err) {
        console.error('[INIT] Database error:', err);
        process.exit(1);
    }

    // Handle --exit-safe-mode CLI flag
    if (args.exitSafeMode) {
        if (isSafeMode()) {
            const reason = getSafeModeReason();
            console.log(`[SAFE-MODE] Was in safe mode due to: ${reason}`);
            exitSafeMode();
            console.log('[SAFE-MODE] Safe mode exited. You can now restart the bot.');
        } else {
            console.log('[SAFE-MODE] Bot is not in safe mode.');
        }
        closeDb();
        return;
    }

    // Check if in safe mode
    if (isSafeMode()) {
        const reason = getSafeModeReason();
        console.log('');
        console.log('  ╔═══════════════════════════════════════════════════════════╗');
        console.log('  ║   🛑 BOT IS IN SAFE MODE - JOBS WILL NOT EXECUTE          ║');
        console.log('  ╚═══════════════════════════════════════════════════════════╝');
        console.log(`  Reason: ${reason}`);
        console.log('  To exit safe mode, run: npm run start -- --exit-safe-mode');
        console.log('');
    }

    // Clear stale locks on startup
    const maxLockAge = Math.max(config.buyIntervalSeconds, config.rewardIntervalSeconds) * 2;
    console.log(`[INIT] Clearing stale locks older than ${maxLockAge}s...`);
    clearStaleLocks(maxLockAge);

    const connection = new Connection(config.rpcUrl, 'confirmed');

    try {
        const slot = await connection.getSlot();
        console.log(`[INIT] Connected to RPC (slot: ${slot})`);
    } catch (err) {
        console.error('[INIT] RPC connection error:', err);
        process.exit(1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handle CLI modes
    // ─────────────────────────────────────────────────────────────────────────

    if (args.bootstrap) {
        console.log('\n[MODE] Bootstrap - fetching historical data');
        await bootstrapScan(connection);
        console.log('[MODE] Bootstrap complete');
        closeDb();
        return;
    }

    if (args.onceBuy) {
        console.log('\n[MODE] One-time buy job');

        // Check SOL balance first
        const solBalance = await getTreasurySolBalance(connection, config);
        if (solBalance < config.minSolReserve) {
            console.log(`[BUY] ⚠️ SKIPPED - SOL balance (${solBalance.toFixed(4)}) < reserve (${config.minSolReserve})`);
            closeDb();
            return;
        }

        const result = await executeWithLockAndTimeout(
            'buy_job',
            'BUY',
            config.buyJobTimeoutMs,
            async () => executeBuyRound(connection)
        );

        if (result.success && result.result) {
            console.log('[MODE] Buy job result:', JSON.stringify(result.result, null, 2));
        }

        closeDb();
        return;
    }

    if (args.onceReward) {
        console.log('\n[MODE] One-time reward job');

        // Check token balance first
        const tokenBalance = await getTreasuryTokenBalance(connection, config);
        if (tokenBalance < BigInt(config.minRewardTokens)) {
            console.log(`[REWARD] ⚠️ SKIPPED - Token balance (${tokenBalance}) < minimum (${config.minRewardTokens})`);
            closeDb();
            return;
        }

        const result = await executeWithLockAndTimeout(
            'reward_job',
            'REWARD',
            config.rewardJobTimeoutMs,
            async () => executeRewardRound(connection)
        );

        if (result.success && result.result) {
            console.log('[MODE] Reward job result:', {
                roundId: result.result.roundId,
                winnersCount: result.result.winners.length,
                totalDistributed: result.result.totalDistributed.toString(),
                success: result.result.success,
            });
        }

        closeDb();
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Continuous mode
    // ─────────────────────────────────────────────────────────────────────────

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    console.log('[INIT] Starting heartbeat...');
    updateHeartbeat();
    heartbeatInterval = setInterval(() => {
        updateHeartbeat();
    }, 30000);

    console.log('[INIT] Starting status server...');
    startStatusServer();

    console.log('\n[MODE] Continuous operation');
    console.log(`[SCHEDULE] Buy job: every ${config.buyIntervalSeconds}s (timeout: ${config.buyJobTimeoutMs / 1000}s)`);
    console.log(`[SCHEDULE] Reward job: every ${config.rewardIntervalSeconds}s (timeout: ${config.rewardJobTimeoutMs / 1000}s)`);

    console.log('\n[GUARD] Checking last job timestamps...');
    shouldRunBuyJob(config);
    shouldRunRewardJob(config);

    console.log('\n[INIT] Running initial scan...');
    scanJobRunning = true;
    try {
        await incrementalScan(connection);
    } finally {
        scanJobRunning = false;
    }

    const buyCron = secondsToCron(config.buyIntervalSeconds);
    const rewardCron = secondsToCron(config.rewardIntervalSeconds);

    console.log(`[SCHEDULE] Buy cron: ${buyCron}`);
    console.log(`[SCHEDULE] Reward cron: ${rewardCron}`);

    // Schedule buy job
    cron.schedule(buyCron, async () => {
        if (isShuttingDown) return;

        if (!shouldRunBuyJob(config)) {
            console.log('[BUY] Interval not elapsed, skipping');
            return;
        }

        console.log('\n[BUY] ─────────────────────────────────────────');
        console.log(`[BUY] Starting job at ${new Date().toISOString()}`);

        // Check SOL balance
        try {
            const solBalance = await getTreasurySolBalance(connection, config);
            if (solBalance < config.minSolReserve) {
                console.log(`[BUY] ⚠️ SKIPPED - SOL balance (${solBalance.toFixed(4)}) < reserve (${config.minSolReserve})`);
                return;
            }
        } catch (err) {
            console.error('[BUY] Failed to check SOL balance:', err);
            return;
        }

        await executeWithLockAndTimeout(
            'buy_job',
            'BUY',
            config.buyJobTimeoutMs,
            async () => executeBuyRound(connection)
        );
    });

    // Schedule reward job
    cron.schedule(rewardCron, async () => {
        if (isShuttingDown) return;

        if (!shouldRunRewardJob(config)) {
            console.log('[REWARD] Interval not elapsed, skipping');
            return;
        }

        console.log('\n[REWARD] ─────────────────────────────────────────');
        console.log(`[REWARD] Starting job at ${new Date().toISOString()}`);

        // Check token balance
        try {
            const tokenBalance = await getTreasuryTokenBalance(connection, config);
            if (tokenBalance < BigInt(config.minRewardTokens)) {
                console.log(`[REWARD] ⚠️ SKIPPED - Token balance (${tokenBalance}) < minimum (${config.minRewardTokens})`);
                return;
            }
        } catch (err) {
            console.error('[REWARD] Failed to check token balance:', err);
            return;
        }

        await executeWithLockAndTimeout(
            'reward_job',
            'REWARD',
            config.rewardJobTimeoutMs,
            async () => executeRewardRound(connection)
        );
    });

    // Schedule periodic scan
    cron.schedule('*/10 * * * *', async () => {
        if (isShuttingDown) return;
        if (scanJobRunning) {
            console.log('[SCAN] Previous scan still running, skipping');
            return;
        }

        scanJobRunning = true;
        try {
            console.log('\n[SCAN] ─────────────────────────────────────────');
            await incrementalScan(connection);
        } catch (err) {
            console.error('[SCAN] Error:', err);
        } finally {
            scanJobRunning = false;
        }
    });

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  BOT IS RUNNING');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('  Jobs will run at scheduled intervals.');
    console.log('  Use Ctrl+C or SIGTERM to stop gracefully.');
    console.log(`  Status API: http://localhost:${config.statusServerPort}/status`);
    console.log('');
}

main().catch(err => {
    console.error('Fatal error:', err);
    closeDb();
    process.exit(1);
});
