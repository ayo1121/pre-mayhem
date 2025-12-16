import { Connection } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { getConfig } from './config';
import { insertRound } from './db';
import { getSolBalance, solToLamports } from './token';
import { swapSolToToken, SwapResult } from './jupiter';
import { writeBuyLog, appendHistoryLog } from './log';

// ─────────────────────────────────────────────────────────────────────────────
// Buy Job Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BuyRoundResult {
    roundId: string;
    timestamp: number;
    treasurySolBalance: number;
    spendableAmount: number;
    actualBuyAmount: number;  // NEW: After applying cap
    swapResult: SwapResult | null;
    skipped: boolean;
    skipReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Buy Job Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute the hourly buy job.
 * 
 * Steps:
 * 1. Fetch treasury SOL balance
 * 2. Calculate spendable = balance - reserve
 * 3. Apply safety cap: actual = min(spendable, MAX_BUY_SOL_PER_HOUR)
 * 4. If actual < MIN_BUY_SOL, skip
 * 5. Swap SOL → TOKEN via Jupiter
 * 6. Log results
 */
export async function executeBuyRound(connection: Connection): Promise<BuyRoundResult> {
    const config = getConfig();
    const roundId = uuidv4();
    const timestamp = Math.floor(Date.now() / 1000);

    console.log(`[BUY] Starting buy round ${roundId}`);

    const result: BuyRoundResult = {
        roundId,
        timestamp,
        treasurySolBalance: 0,
        spendableAmount: 0,
        actualBuyAmount: 0,
        swapResult: null,
        skipped: false,
    };

    try {
        // Step 1: Get treasury SOL balance
        const solBalance = await getSolBalance(connection, config.treasuryPubkey);
        result.treasurySolBalance = solBalance;

        console.log(`[BUY] Treasury SOL balance: ${solBalance}`);

        // Step 2: Calculate spendable amount
        const spendable = solBalance - config.solFeeReserve;
        result.spendableAmount = Math.max(0, spendable);

        console.log(`[BUY] Spendable (after ${config.solFeeReserve} SOL reserve): ${result.spendableAmount}`);

        // Step 3: Apply safety cap
        result.actualBuyAmount = Math.min(result.spendableAmount, config.maxBuySolPerHour);

        if (result.actualBuyAmount < result.spendableAmount) {
            console.log(`[BUY] Safety cap applied: ${result.spendableAmount} SOL → ${result.actualBuyAmount} SOL (max: ${config.maxBuySolPerHour})`);
        }

        // Step 4: Check minimum
        if (result.actualBuyAmount < config.minBuySol) {
            console.log(`[BUY] Skipping: actual ${result.actualBuyAmount} < min ${config.minBuySol}`);
            result.skipped = true;
            result.skipReason = `Insufficient balance: ${result.actualBuyAmount} SOL < ${config.minBuySol} SOL minimum`;
            return result;
        }

        // Step 5: Execute swap
        const spendLamports = BigInt(solToLamports(result.actualBuyAmount));

        console.log(`[BUY] Executing swap: ${result.actualBuyAmount} SOL → TOKEN`);

        result.swapResult = await swapSolToToken(connection, spendLamports);

        // Step 6: Log results
        if (result.swapResult.success) {
            console.log(`[BUY] Swap successful: ${result.swapResult.signature}`);
        } else {
            console.log(`[BUY] Swap failed: ${result.swapResult.error}`);
        }

        // Insert round record
        insertRound({
            round_id: roundId,
            type: 'buy',
            ts: timestamp,
            txs_json: JSON.stringify(result.swapResult.signature ? [result.swapResult.signature] : []),
            meta_json: JSON.stringify({
                solSpent: result.swapResult.inAmountSol,
                tokenReceived: result.swapResult.outAmountToken,
                success: result.swapResult.success,
                error: result.swapResult.error,
                safetyCap: config.maxBuySolPerHour,
                spendableBeforeCap: result.spendableAmount,
            }),
        });

        // Write transparency logs
        writeBuyLog(result.swapResult, config.treasuryPubkey.toBase58());
        appendHistoryLog('buy', result.swapResult);

        console.log(`[BUY] Round ${roundId} completed`);

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('[BUY] Round failed:', errorMessage);

        result.swapResult = {
            success: false,
            error: errorMessage,
            inAmountSol: result.actualBuyAmount,
            outAmountToken: 0,
        };
    }

    return result;
}
