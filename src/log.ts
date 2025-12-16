import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { SwapResult } from './jupiter';
import { RewardRoundResult } from './rewards';

// ─────────────────────────────────────────────────────────────────────────────
// Ensure Public Directory
// ─────────────────────────────────────────────────────────────────────────────

function ensurePublicDir(): string {
    const config = getConfig();
    if (!fs.existsSync(config.publicDir)) {
        fs.mkdirSync(config.publicDir, { recursive: true });
    }
    return config.publicDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Buy Logs
// ─────────────────────────────────────────────────────────────────────────────

export interface BuyLogEntry {
    timestamp: number;
    timestampIso: string;
    treasuryPubkey: string;
    solSpent: number;
    tokenReceived: number;
    txSignature: string | null;
    success: boolean;
    error?: string;
}

export function writeBuyLog(swapResult: SwapResult, treasuryPubkey: string): void {
    const publicDir = ensurePublicDir();

    const entry: BuyLogEntry = {
        timestamp: Math.floor(Date.now() / 1000),
        timestampIso: new Date().toISOString(),
        treasuryPubkey,
        solSpent: swapResult.inAmountSol,
        tokenReceived: swapResult.outAmountToken,
        txSignature: swapResult.signature || null,
        success: swapResult.success,
        error: swapResult.error,
    };

    const filePath = path.join(publicDir, 'last_buy.json');
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));

    console.log(`[LOG] Wrote buy log to ${filePath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reward Logs
// ─────────────────────────────────────────────────────────────────────────────

export interface RewardLogEntry {
    roundId: string;
    timestamp: number;
    timestampIso: string;
    treasuryPubkey: string;
    treasuryBalanceBefore: string;
    totalDistributed: string;
    perWinnerAmount: string;
    winnersCount: number;
    winners: Array<{
        wallet: string;
        weight: number;
        rewardAmount: number;
    }>;
    transactions: string[];
    success: boolean;
    error?: string;
}

export function writeRewardLog(result: RewardRoundResult): void {
    const config = getConfig();
    const publicDir = ensurePublicDir();

    const entry: RewardLogEntry = {
        roundId: result.roundId,
        timestamp: result.timestamp,
        timestampIso: new Date(result.timestamp * 1000).toISOString(),
        treasuryPubkey: config.treasuryPubkey.toBase58(),
        treasuryBalanceBefore: result.treasuryBalanceBefore.toString(),
        totalDistributed: result.totalDistributed.toString(),
        perWinnerAmount: result.perWinnerAmount.toString(),
        winnersCount: result.winners.length,
        winners: result.winners.map(w => ({
            wallet: w.wallet,
            weight: w.weight,
            rewardAmount: w.rewardAmountUi,
        })),
        transactions: result.transactions,
        success: result.success,
        error: result.error,
    };

    const filePath = path.join(publicDir, 'last_reward.json');
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));

    console.log(`[LOG] Wrote reward log to ${filePath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// History Log (JSONL)
// ─────────────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
    type: 'buy' | 'reward';
    timestamp: number;
    timestampIso: string;
    data: BuyLogEntry | RewardLogEntry;
}

export function appendHistoryLog(
    type: 'buy' | 'reward',
    data: SwapResult | RewardRoundResult
): void {
    const config = getConfig();
    const publicDir = ensurePublicDir();
    const filePath = path.join(publicDir, 'history.jsonl');

    let entry: HistoryEntry;

    if (type === 'buy') {
        const swapResult = data as SwapResult;
        entry = {
            type: 'buy',
            timestamp: Math.floor(Date.now() / 1000),
            timestampIso: new Date().toISOString(),
            data: {
                timestamp: Math.floor(Date.now() / 1000),
                timestampIso: new Date().toISOString(),
                treasuryPubkey: config.treasuryPubkey.toBase58(),
                solSpent: swapResult.inAmountSol,
                tokenReceived: swapResult.outAmountToken,
                txSignature: swapResult.signature || null,
                success: swapResult.success,
                error: swapResult.error,
            },
        };
    } else {
        const rewardResult = data as RewardRoundResult;
        entry = {
            type: 'reward',
            timestamp: rewardResult.timestamp,
            timestampIso: new Date(rewardResult.timestamp * 1000).toISOString(),
            data: {
                roundId: rewardResult.roundId,
                timestamp: rewardResult.timestamp,
                timestampIso: new Date(rewardResult.timestamp * 1000).toISOString(),
                treasuryPubkey: config.treasuryPubkey.toBase58(),
                treasuryBalanceBefore: rewardResult.treasuryBalanceBefore.toString(),
                totalDistributed: rewardResult.totalDistributed.toString(),
                perWinnerAmount: rewardResult.perWinnerAmount.toString(),
                winnersCount: rewardResult.winners.length,
                winners: rewardResult.winners.map(w => ({
                    wallet: w.wallet,
                    weight: w.weight,
                    rewardAmount: w.rewardAmountUi,
                })),
                transactions: rewardResult.transactions,
                success: rewardResult.success,
                error: rewardResult.error,
            },
        };
    }

    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(filePath, line);

    console.log(`[LOG] Appended ${type} entry to history.jsonl`);
}
