import { Connection } from '@solana/web3.js';
import { getConfig } from './config';
import { getEligibleHolders, HolderRow, updateStreakAndTwb } from './db';
import { getWalletAgeDays } from './age';
import { rawToUi } from './token';

// ─────────────────────────────────────────────────────────────────────────────
// Seeded PRNG (Mulberry32)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mulberry32 - Simple seeded PRNG
 * Returns a function that produces random numbers in [0, 1)
 */
function mulberry32(seed: number): () => number {
    return function () {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * Create a seed from multiple inputs using a simple hash function
 */
function createSeed(timestamp: number, tokenMint: string, blockhash: string): number {
    // Simple string-to-number hash
    const combined = `${timestamp}-${tokenMint}-${blockhash}`;
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
        const char = combined.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EligibleHolder {
    wallet: string;
    walletAgeDays: number;
    streakRounds: number;
    twbScore: number;
    cumulativeBuySol: number;
    tokenBalanceUi: number;
    tokenBalanceRaw: string;
    weight: number;
}

export interface Winner extends EligibleHolder {
    rewardAmount: number;
}

export interface LotteryContext {
    seed: number;
    seedInputs: {
        timestamp: number;
        tokenMint: string;
        blockhash: string;
    };
    roundId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weight Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate lottery weight for a holder.
 * 
 * Formula:
 *   weight = sqrt(wallet_age_days) 
 *          × min(3, 1 + streak_rounds / 10) 
 *          × min(5, 1 + log10(1 + twb_score))
 * 
 * Capped at 10.
 */
export function calculateWeight(holder: EligibleHolder): number {
    const ageFactor = Math.sqrt(holder.walletAgeDays);
    const streakFactor = Math.min(3, 1 + holder.streakRounds / 10);
    const twbFactor = Math.min(5, 1 + Math.log10(1 + holder.twbScore));

    const weight = ageFactor * streakFactor * twbFactor;

    return Math.min(10, weight);
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility Filtering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all eligible holders with computed weights.
 * 
 * Eligibility requires:
 * 1. wallet_age >= 90 days
 * 2. continuity >= 2 hours  
 * 3. cumulative_buy_sol >= 0.1 (high confidence only)
 * 4. token_balance > 0
 * 5. not blacklisted
 */
export function getEligibleHoldersWithWeights(decimals: number): EligibleHolder[] {
    const config = getConfig();

    // Query DB for basic eligibility
    const holders = getEligibleHolders(
        config.walletMinAgeDays,
        config.minContinuitySeconds,
        config.minCumulativeBuySol
    );

    console.log(`[SCORING] Found ${holders.length} eligible holders from database`);

    // Compute weights
    const eligible: EligibleHolder[] = [];

    for (const holder of holders) {
        if (!holder.first_seen_ts) continue;
        if (!holder.last_balance_raw || holder.last_balance_raw === '0') continue;

        const walletAgeDays = getWalletAgeDays(holder.first_seen_ts);
        const tokenBalanceUi = rawToUi(holder.last_balance_raw, decimals);

        const eligibleHolder: EligibleHolder = {
            wallet: holder.wallet,
            walletAgeDays,
            streakRounds: holder.streak_rounds,
            twbScore: holder.twb_score,
            cumulativeBuySol: holder.cumulative_buy_sol,
            tokenBalanceUi,
            tokenBalanceRaw: holder.last_balance_raw,
            weight: 0,
        };

        eligibleHolder.weight = calculateWeight(eligibleHolder);
        eligible.push(eligibleHolder);
    }

    console.log(`[SCORING] ${eligible.length} holders with computed weights`);

    return eligible;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic Weighted Lottery Selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create lottery context with deterministic seed.
 * The seed is derived from: timestamp + tokenMint + blockhash
 * This allows anyone to reproduce the winner selection from logs.
 */
export async function createLotteryContext(
    connection: Connection,
    roundId: string,
    timestamp: number
): Promise<LotteryContext> {
    const config = getConfig();

    // Fetch latest blockhash for deterministic seed
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tokenMint = config.tokenMint.toBase58();

    const seed = createSeed(timestamp, tokenMint, blockhash);

    const context: LotteryContext = {
        seed,
        seedInputs: {
            timestamp,
            tokenMint,
            blockhash,
        },
        roundId,
    };

    console.log(`[SCORING] Lottery context created:`);
    console.log(`[SCORING]   Round ID: ${roundId}`);
    console.log(`[SCORING]   Seed: ${seed}`);
    console.log(`[SCORING]   Blockhash: ${blockhash}`);
    console.log(`[SCORING]   Timestamp: ${timestamp}`);

    return context;
}

/**
 * Select winners using deterministic weighted lottery without replacement.
 * Uses seeded PRNG for reproducible results.
 */
export function selectWinners(
    eligible: EligibleHolder[],
    count: number,
    context: LotteryContext
): EligibleHolder[] {
    if (eligible.length === 0) {
        return [];
    }

    // Initialize seeded PRNG
    const random = mulberry32(context.seed);

    const winnersCount = Math.min(count, eligible.length);
    const winners: EligibleHolder[] = [];
    const remaining = [...eligible];

    for (let i = 0; i < winnersCount; i++) {
        // Calculate total weight of remaining holders
        const totalWeight = remaining.reduce((sum, h) => sum + h.weight, 0);

        if (totalWeight <= 0) {
            break;
        }

        // Pick seeded random value in [0, totalWeight)
        const randomValue = random() * totalWeight;

        // Find winner
        let cumulative = 0;
        let winnerIndex = 0;

        for (let j = 0; j < remaining.length; j++) {
            cumulative += remaining[j].weight;
            if (randomValue < cumulative) {
                winnerIndex = j;
                break;
            }
        }

        // Add winner and remove from remaining
        winners.push(remaining[winnerIndex]);
        remaining.splice(winnerIndex, 1);
    }

    console.log(`[SCORING] Selected ${winners.length} winners (seed: ${context.seed})`);

    return winners;
}

/**
 * Legacy function for when context is not available (e.g., testing)
 * Uses Math.random() - NOT deterministic
 */
export function selectWinnersLegacy(
    eligible: EligibleHolder[],
    count: number
): EligibleHolder[] {
    if (eligible.length === 0) {
        return [];
    }

    console.log(`[SCORING] WARNING: Using non-deterministic legacy selection`);

    const winnersCount = Math.min(count, eligible.length);
    const winners: EligibleHolder[] = [];
    const remaining = [...eligible];

    for (let i = 0; i < winnersCount; i++) {
        const totalWeight = remaining.reduce((sum, h) => sum + h.weight, 0);

        if (totalWeight <= 0) {
            break;
        }

        const random = Math.random() * totalWeight;

        let cumulative = 0;
        let winnerIndex = 0;

        for (let j = 0; j < remaining.length; j++) {
            cumulative += remaining[j].weight;
            if (random < cumulative) {
                winnerIndex = j;
                break;
            }
        }

        winners.push(remaining[winnerIndex]);
        remaining.splice(winnerIndex, 1);
    }

    console.log(`[SCORING] Selected ${winners.length} winners (non-deterministic)`);

    return winners;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streak and TWB Update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update streak and TWB for eligible holders after a reward round.
 */
export function updateEligibleHoldersStreakAndTwb(
    eligible: EligibleHolder[],
    rewardIntervalSeconds: number
): void {
    console.log(`[SCORING] Updating streak and TWB for ${eligible.length} eligible holders`);

    for (const holder of eligible) {
        updateStreakAndTwb(holder.wallet, holder.tokenBalanceUi, rewardIntervalSeconds);
    }
}
