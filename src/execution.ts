import { getConfig } from './config.js';
import {
    acquireLock,
    releaseLock,
    enterSafeMode,
    incrementRpcErrors,
    resetRpcErrors,
    isSafeMode,
    LockType,
} from './db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Execution Timeout Error
// ─────────────────────────────────────────────────────────────────────────────

export class ExecutionTimeoutError extends Error {
    constructor(jobName: string, timeoutMs: number) {
        super(`[${jobName}] Job exceeded maximum execution time of ${timeoutMs / 1000}s`);
        this.name = 'ExecutionTimeoutError';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeout Wrapper using AbortController
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a function with a timeout.
 * If timeout is exceeded, the promise rejects with ExecutionTimeoutError.
 */
export async function executeWithTimeout<T>(
    jobName: string,
    timeoutMs: number,
    fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    const controller = new AbortController();
    const { signal } = controller;

    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const result = await fn(signal);
        return result;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lock + Timeout + Try/Finally Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutionResult<T> {
    success: boolean;
    result?: T;
    error?: string;
    timedOut?: boolean;
    skipped?: boolean;
    skipReason?: string;
}

/**
 * Execute a job with:
 * 1. Safe-mode check
 * 2. DB-backed lock acquisition
 * 3. Timeout enforcement
 * 4. Guaranteed lock release in finally
 * 5. RPC error tracking
 */
export async function executeWithLockAndTimeout<T>(
    lockType: LockType,
    jobName: string,
    timeoutMs: number,
    fn: (signal: AbortSignal) => Promise<T>
): Promise<ExecutionResult<T>> {
    // Check safe mode first
    if (isSafeMode()) {
        console.log(`[${jobName}] ⚠️ Skipped - bot is in SAFE MODE`);
        return {
            success: false,
            skipped: true,
            skipReason: 'Bot is in safe mode. Run with --exit-safe-mode to resume.',
        };
    }

    // Try to acquire lock
    if (!acquireLock(lockType)) {
        console.log(`[${jobName}] Skipped - lock already held`);
        return {
            success: false,
            skipped: true,
            skipReason: 'Lock already held by another execution',
        };
    }

    const startTime = Date.now();
    console.log(`[${jobName}] ▶ Starting execution (timeout: ${timeoutMs / 1000}s)`);

    try {
        const result = await executeWithTimeout(jobName, timeoutMs, fn);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[${jobName}] ✓ Completed successfully in ${elapsed}s`);

        // Reset RPC error counter on success
        resetRpcErrors();

        return { success: true, result };
    } catch (err) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const isTimeout = err instanceof ExecutionTimeoutError ||
            (err instanceof Error && err.message.includes('aborted'));

        if (isTimeout || isAbort) {
            console.error(`[${jobName}] ⏱ TIMEOUT after ${elapsed}s - aborting`);
            console.error(`[${jobName}] Lock will be released in finally block`);

            return {
                success: false,
                error: `Timeout after ${elapsed}s`,
                timedOut: true,
            };
        }

        // Track RPC errors
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isRpcError = errorMsg.includes('503') ||
            errorMsg.includes('429') ||
            errorMsg.includes('timeout') ||
            errorMsg.includes('ECONNREFUSED') ||
            errorMsg.includes('fetch failed');

        if (isRpcError) {
            const config = getConfig();
            const errorCount = incrementRpcErrors();
            console.error(`[${jobName}] RPC error (${errorCount}/${config.maxRpcErrorsBeforePause}): ${errorMsg}`);

            if (errorCount >= config.maxRpcErrorsBeforePause) {
                enterSafeMode(`Consecutive RPC errors: ${errorCount}`);
            }
        }

        console.error(`[${jobName}] ✗ Failed after ${elapsed}s: ${errorMsg}`);

        return {
            success: false,
            error: errorMsg,
        };
    } finally {
        // GUARANTEED: Always release lock
        try {
            releaseLock(lockType);
            console.log(`[${jobName}] 🔓 Lock released in finally block`);
        } catch (unlockErr) {
            console.error(`[${jobName}] ⚠️ Failed to release lock: ${unlockErr}`);
        }
    }
}
