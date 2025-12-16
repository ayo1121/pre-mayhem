import {
    Connection,
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createTransferInstruction,
    getAccount,
} from '@solana/spl-token';
import { v4 as uuidv4 } from 'uuid';
import { getConfig } from './config';
import { insertRound } from './db';
import { getTokenDecimals, rawToUi } from './token';
import { getTreasuryTokenBalance, refreshAllBalances } from './balances';
import { incrementalScan } from './scan';
import {
    getEligibleHoldersWithWeights,
    selectWinners,
    createLotteryContext,
    updateEligibleHoldersStreakAndTwb,
    LotteryContext,
} from './scoring';
import { writeRewardLog, appendHistoryLog } from './log';

// ─────────────────────────────────────────────────────────────────────────────
// Reward Distribution Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RewardWinner {
    wallet: string;
    weight: number;
    tokenBalanceUi: number;
    rewardAmountRaw: bigint;
    rewardAmountUi: number;
    ataCreated: boolean;
}

export interface RewardRoundResult {
    roundId: string;
    timestamp: number;
    treasuryBalanceBefore: bigint;
    totalDistributed: bigint;
    perWinnerAmount: bigint;
    winners: RewardWinner[];
    transactions: string[];
    success: boolean;
    error?: string;
    lotteryContext?: LotteryContext;  // NEW: For reproducibility
}

// ─────────────────────────────────────────────────────────────────────────────
// ATA Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function ensureAta(
    connection: Connection,
    wallet: PublicKey,
    mint: PublicKey,
    payer: PublicKey
): Promise<{ ata: PublicKey; created: boolean }> {
    const ata = await getAssociatedTokenAddress(mint, wallet);

    try {
        await getAccount(connection, ata);
        return { ata, created: false };
    } catch {
        // ATA doesn't exist, will need to create
        return { ata, created: true };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reward Distribution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a reward distribution round.
 */
export async function executeRewardRound(connection: Connection): Promise<RewardRoundResult> {
    const config = getConfig();
    const roundId = uuidv4();
    const timestamp = Math.floor(Date.now() / 1000);

    console.log(`[REWARDS] Starting reward round ${roundId}`);

    const result: RewardRoundResult = {
        roundId,
        timestamp,
        treasuryBalanceBefore: BigInt(0),
        totalDistributed: BigInt(0),
        perWinnerAmount: BigInt(0),
        winners: [],
        transactions: [],
        success: false,
    };

    try {
        // Step 1: Refresh data
        console.log('[REWARDS] Step 1: Refreshing holder data');
        await incrementalScan(connection);
        await refreshAllBalances(connection);

        // Step 2: Get token decimals
        const decimals = await getTokenDecimals(connection);

        // Step 3: Get treasury balance
        const treasuryBalance = await getTreasuryTokenBalance(connection);
        result.treasuryBalanceBefore = treasuryBalance.raw;

        console.log(`[REWARDS] Treasury token balance: ${treasuryBalance.ui}`);

        if (treasuryBalance.raw === BigInt(0)) {
            console.log('[REWARDS] Treasury has no tokens, skipping round');
            result.error = 'Treasury has no tokens';
            return result;
        }

        // Step 4: Calculate distribution amount with safety cap applied
        // config.rewardTokenPercentBps is already capped by min(REWARD_TOKEN_PERCENT_BPS, MAX_REWARD_TOKEN_PERCENT_PER_ROUND)
        const distributePercent = config.rewardTokenPercentBps / 10000;
        const distributeRaw = (treasuryBalance.raw * BigInt(config.rewardTokenPercentBps)) / BigInt(10000);

        console.log(`[REWARDS] Distributing ${distributePercent * 100}% = ${rawToUi(distributeRaw, decimals)} tokens`);
        console.log(`[REWARDS] (Safety cap: ${config.maxRewardTokenPercentPerRound / 100}% max)`);

        // Step 5: Get eligible holders with weights
        const eligible = getEligibleHoldersWithWeights(decimals);

        if (eligible.length === 0) {
            console.log('[REWARDS] No eligible holders found');
            result.error = 'No eligible holders';
            return result;
        }

        // Step 6: Create lottery context for deterministic selection
        const lotteryContext = await createLotteryContext(connection, roundId, timestamp);
        result.lotteryContext = lotteryContext;

        // Step 7: Select winners using deterministic lottery
        const winners = selectWinners(eligible, config.winnersPerRound, lotteryContext);

        if (winners.length === 0) {
            console.log('[REWARDS] No winners selected');
            result.error = 'No winners selected';
            return result;
        }

        // Step 8: Calculate per-winner amount
        const perWinnerRaw = distributeRaw / BigInt(winners.length);
        result.perWinnerAmount = perWinnerRaw;

        console.log(`[REWARDS] ${winners.length} winners, ${rawToUi(perWinnerRaw, decimals)} tokens each`);

        // Step 9: Prepare winner data
        for (const winner of winners) {
            const { ata, created } = await ensureAta(
                connection,
                new PublicKey(winner.wallet),
                config.tokenMint,
                config.treasuryPubkey
            );

            result.winners.push({
                wallet: winner.wallet,
                weight: winner.weight,
                tokenBalanceUi: winner.tokenBalanceUi,
                rewardAmountRaw: perWinnerRaw,
                rewardAmountUi: rawToUi(perWinnerRaw, decimals),
                ataCreated: created,
            });
        }

        // Step 10: Execute transfers
        if (config.dryRun) {
            console.log('[REWARDS] DRY RUN - skipping actual transfers');
            result.transactions = ['dry-run-tx-1', 'dry-run-tx-2'];
            result.totalDistributed = perWinnerRaw * BigInt(winners.length);
            result.success = true;
        } else {
            const txSignatures = await executeTransfers(
                connection,
                result.winners,
                perWinnerRaw,
                decimals
            );

            result.transactions = txSignatures;
            result.totalDistributed = perWinnerRaw * BigInt(txSignatures.length > 0 ? winners.length : 0);
            result.success = txSignatures.length > 0;
        }

        // Step 11: Update streak and TWB for all eligible holders
        updateEligibleHoldersStreakAndTwb(eligible, config.rewardIntervalSeconds);

        // Step 12: Log the round (include lottery context for reproducibility)
        insertRound({
            round_id: roundId,
            type: 'reward',
            ts: timestamp,
            txs_json: JSON.stringify(result.transactions),
            meta_json: JSON.stringify({
                winnersCount: result.winners.length,
                perWinnerUi: rawToUi(perWinnerRaw, decimals),
                totalDistributedUi: rawToUi(result.totalDistributed, decimals),
                lotterySeed: lotteryContext.seed,
                lotteryBlockhash: lotteryContext.seedInputs.blockhash,
                rewardPercentBps: config.rewardTokenPercentBps,
                maxRewardPercentBps: config.maxRewardTokenPercentPerRound,
            }),
        });

        // Step 13: Write transparency logs
        writeRewardLog(result);
        appendHistoryLog('reward', result);

        console.log(`[REWARDS] Round ${roundId} completed successfully`);

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('[REWARDS] Round failed:', errorMessage);
        result.error = errorMessage;
    }

    return result;
}

/**
 * Execute batched token transfers to winners.
 */
async function executeTransfers(
    connection: Connection,
    winners: RewardWinner[],
    amountRaw: bigint,
    decimals: number
): Promise<string[]> {
    const config = getConfig();
    const signatures: string[] = [];

    // Get treasury ATA
    const treasuryAta = await getAssociatedTokenAddress(
        config.tokenMint,
        config.treasuryPubkey
    );

    // Batch winners
    for (let i = 0; i < winners.length; i += config.maxSendsPerTx) {
        const batch = winners.slice(i, i + config.maxSendsPerTx);

        const transaction = new Transaction();

        for (const winner of batch) {
            const winnerPubkey = new PublicKey(winner.wallet);
            const winnerAta = await getAssociatedTokenAddress(config.tokenMint, winnerPubkey);

            // Create ATA if needed
            if (winner.ataCreated) {
                transaction.add(
                    createAssociatedTokenAccountInstruction(
                        config.treasuryPubkey, // payer
                        winnerAta,
                        winnerPubkey,
                        config.tokenMint
                    )
                );
            }

            // Transfer tokens
            transaction.add(
                createTransferInstruction(
                    treasuryAta,
                    winnerAta,
                    config.treasuryPubkey,
                    amountRaw
                )
            );
        }

        try {
            const signature = await sendAndConfirmTransaction(
                connection,
                transaction,
                [config.treasuryKeypair],
                { commitment: 'confirmed' }
            );

            signatures.push(signature);
            console.log(`[REWARDS] Batch ${Math.floor(i / config.maxSendsPerTx) + 1} confirmed: ${signature}`);

        } catch (err) {
            console.error(`[REWARDS] Batch transfer failed:`, err);
            // Continue with remaining batches
        }

        // Small delay between batches
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return signatures;
}
