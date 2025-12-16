import { Connection } from '@solana/web3.js';
import * as cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, Config } from './config';
import {
    initDb,
    closeDb,
    getLastRound,
    acquireLock,
    releaseLock,
    clearStaleLocks,
    updateHeartbeat,
    LockType,
} from './db';
import { bootstrapScan, incrementalScan } from './scan';
import { executeBuyRound } from './buys';
import { executeRewardRound } from './rewards';
import { startStatusServer, stopStatusServer } from './status-server';

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface CliArgs {
    bootstrap: boolean;
    onceBuy: boolean;
    onceReward: boolean;
}

function parseArgs(): CliArgs {
    const args = process.argv.slice(2);

    return {
        bootstrap: args.includes('--bootstrap'),
        onceBuy: args.includes('--once-buy'),
        onceReward: args.includes('--once-reward'),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interval to Cron Expression
// ─────────────────────────────────────────────────────────────────────────────

function secondsToCron(seconds: number): string {
    if (seconds < 60) {
        // Every N seconds (not practical for cron, use minimum 1 minute)
        return '* * * * *';
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        // Every N minutes
        return `*/${minutes} * * * *`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        // Every N hours
        return `0 */${hours} * * *`;
    }

    // Daily
    return '0 0 * * *';
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup Banner & Safety Checks
// ─────────────────────────────────────────────────────────────────────────────

function maskRpcUrl(url: string): string {
    // Mask API key in RPC URL for security
    return url.replace(/api-key=[^&]+/, 'api-key=****');
}

function printStartupBanner(config: Config): void {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  PUMPFUN AGE STREAK BOT - PRODUCTION');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('  Configuration:');
    console.log(`    RPC URL:              ${maskRpcUrl(config.rpcUrl)}`);
    console.log(`    Token Mint:           ${config.tokenMint.toBase58()}`);
    console.log(`    Treasury:             ${config.treasuryPubkey.toBase58()}`);
    console.log(`    Buy Interval:         ${config.buyIntervalSeconds}s (${config.buyIntervalSeconds / 3600}h)`);
    console.log(`    Reward Interval:      ${config.rewardIntervalSeconds}s (${config.rewardIntervalSeconds / 3600}h)`);
    console.log(`    Status Server:        http://localhost:${config.statusServerPort}/status`);
    console.log(`    Dry Run:              ${config.dryRun}`);
    console.log('');

    if (!config.dryRun) {
        console.log('');
        console.log('  ╔═══════════════════════════════════════════════════════════╗');
        console.log('  ║                                                           ║');
        console.log('  ║   ⚠️  WARNING: DRY_RUN IS DISABLED!                        ║');
        console.log('  ║                                                           ║');
        console.log('  ║   This bot will execute REAL transactions with REAL SOL.  ║');
        console.log('  ║   Make sure you have tested thoroughly before deploying.  ║');
        console.log('  ║                                                           ║');
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
// Job Timing Guards (Prevent Double Execution After Restart)
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
// Crash-Safe Job Execution with Locks
// ─────────────────────────────────────────────────────────────────────────────

async function executeWithLock<T>(
    lockType: LockType,
    jobName: string,
    jobFn: () => Promise<T>
): Promise<T | null> {
    // Try to acquire lock
    if (!acquireLock(lockType)) {
        console.log(`[${jobName}] Lock held, skipping execution`);
        return null;
    }

    try {
        return await jobFn();
    } catch (err) {
        console.error(`[${jobName}] Job error:`, err);
        throw err;
    } finally {
        // Always release lock
        releaseLock(lockType);
    }
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

    // Stop heartbeat
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }

    // Stop status server
    stopStatusServer();

    // Release any locks we might hold
    try {
        releaseLock('buy_job');
        releaseLock('reward_job');
    } catch { }

    // Wait for in-progress scan to complete (max 30 seconds)
    const maxWait = 30000;
    const startTime = Date.now();

    while (scanJobRunning && (Date.now() - startTime < maxWait)) {
        console.log('[SHUTDOWN] Waiting for in-progress scan to complete...');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Close database
    console.log('[SHUTDOWN] Closing database...');
    closeDb();

    // Flush stdout/stderr
    console.log('[SHUTDOWN] Shutdown complete.');

    process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Application
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // Ensure required directories exist
    ensureDirectories();

    // Parse CLI arguments
    const args = parseArgs();

    // Load configuration
    let config: Config;
    try {
        config = getConfig();
    } catch (err) {
        console.error('[INIT] Configuration error:', err);
        process.exit(1);
    }

    // Print startup banner
    printStartupBanner(config);

    // Initialize database
    try {
        initDb();
        console.log('[INIT] Database initialized');
    } catch (err) {
        console.error('[INIT] Database error:', err);
        process.exit(1);
    }

    // Clear stale locks on startup (2× interval)
    const maxLockAge = Math.max(config.buyIntervalSeconds, config.rewardIntervalSeconds) * 2;
    console.log(`[INIT] Clearing stale locks older than ${maxLockAge}s...`);
    clearStaleLocks(maxLockAge);

    // Create connection
    const connection = new Connection(config.rpcUrl, 'confirmed');

    try {
        // Test connection
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
        const result = await executeWithLock('buy_job', 'BUY', () => executeBuyRound(connection));
        if (result) {
            console.log('[MODE] Buy job result:', JSON.stringify(result, null, 2));
        }
        closeDb();
        return;
    }

    if (args.onceReward) {
        console.log('\n[MODE] One-time reward job');
        const result = await executeWithLock('reward_job', 'REWARD', () => executeRewardRound(connection));
        if (result) {
            console.log('[MODE] Reward job result:', {
                roundId: result.roundId,
                winnersCount: result.winners.length,
                totalDistributed: result.totalDistributed.toString(),
                success: result.success,
                error: result.error,
            });
        }
        closeDb();
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Register shutdown handlers BEFORE starting jobs
    // ─────────────────────────────────────────────────────────────────────────

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // ─────────────────────────────────────────────────────────────────────────
    // Start heartbeat (every 30 seconds)
    // ─────────────────────────────────────────────────────────────────────────

    console.log('[INIT] Starting heartbeat...');
    updateHeartbeat(); // Initial heartbeat
    heartbeatInterval = setInterval(() => {
        updateHeartbeat();
    }, 30000);

    // ─────────────────────────────────────────────────────────────────────────
    // Start status server
    // ─────────────────────────────────────────────────────────────────────────

    console.log('[INIT] Starting status server...');
    startStatusServer();

    // ─────────────────────────────────────────────────────────────────────────
    // Continuous mode with scheduled jobs
    // ─────────────────────────────────────────────────────────────────────────

    console.log('\n[MODE] Continuous operation');
    console.log(`[SCHEDULE] Buy job: every ${config.buyIntervalSeconds} seconds`);
    console.log(`[SCHEDULE] Reward job: every ${config.rewardIntervalSeconds} seconds`);

    // Check timing guards for initial state
    console.log('\n[GUARD] Checking last job timestamps...');
    shouldRunBuyJob(config);
    shouldRunRewardJob(config);

    // Initial scan
    console.log('\n[INIT] Running initial scan...');
    scanJobRunning = true;
    try {
        await incrementalScan(connection);
    } finally {
        scanJobRunning = false;
    }

    // Convert intervals to cron expressions
    const buyCron = secondsToCron(config.buyIntervalSeconds);
    const rewardCron = secondsToCron(config.rewardIntervalSeconds);

    console.log(`[SCHEDULE] Buy cron: ${buyCron}`);
    console.log(`[SCHEDULE] Reward cron: ${rewardCron}`);

    // Schedule buy job
    cron.schedule(buyCron, async () => {
        if (isShuttingDown) return;

        // Check timing guard
        if (!shouldRunBuyJob(config)) {
            console.log('[BUY] Interval not elapsed, skipping');
            return;
        }

        console.log('\n[BUY] ─────────────────────────────────────────');
        console.log(`[BUY] Starting job at ${new Date().toISOString()}`);

        try {
            await executeWithLock('buy_job', 'BUY', () => executeBuyRound(connection));
        } catch (err) {
            console.error('[BUY] Job error:', err);
        }
    });

    // Schedule reward job
    cron.schedule(rewardCron, async () => {
        if (isShuttingDown) return;

        // Check timing guard
        if (!shouldRunRewardJob(config)) {
            console.log('[REWARD] Interval not elapsed, skipping');
            return;
        }

        console.log('\n[REWARD] ─────────────────────────────────────────');
        console.log(`[REWARD] Starting job at ${new Date().toISOString()}`);

        try {
            await executeWithLock('reward_job', 'REWARD', () => executeRewardRound(connection));
        } catch (err) {
            console.error('[REWARD] Job error:', err);
        }
    });

    // Schedule periodic scan (every 10 minutes)
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

// Run main
main().catch(err => {
    console.error('Fatal error:', err);
    closeDb();
    process.exit(1);
});
