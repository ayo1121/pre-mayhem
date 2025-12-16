import { Connection, PublicKey } from '@solana/web3.js';
import { getHolder, upsertHolder } from './db';

// ─────────────────────────────────────────────────────────────────────────────
// Wallet Age Calculation
// ─────────────────────────────────────────────────────────────────────────────

const MAX_AGE_PAGES = 20;
const SIGNATURES_PER_PAGE = 1000;

/**
 * Compute wallet age by finding the oldest transaction.
 * Paginates up to 20 pages (20,000 transactions) to find the earliest tx.
 * Result is cached permanently in the database.
 */
export async function computeWalletAge(
    connection: Connection,
    wallet: string
): Promise<number | null> {
    // Check if already cached
    const holder = getHolder(wallet);
    if (holder?.first_seen_ts) {
        return holder.first_seen_ts;
    }

    const walletPubkey = new PublicKey(wallet);
    let oldestBlockTime: number | null = null;
    let beforeSignature: string | undefined = undefined;

    try {
        for (let page = 0; page < MAX_AGE_PAGES; page++) {
            const signatures = await connection.getSignaturesForAddress(
                walletPubkey,
                {
                    limit: SIGNATURES_PER_PAGE,
                    before: beforeSignature,
                }
            );

            if (signatures.length === 0) {
                break;
            }

            // Get the oldest in this batch
            for (const sig of signatures) {
                if (sig.blockTime) {
                    if (!oldestBlockTime || sig.blockTime < oldestBlockTime) {
                        oldestBlockTime = sig.blockTime;
                    }
                }
            }

            // Set up for next page
            beforeSignature = signatures[signatures.length - 1].signature;

            // If we got fewer than limit, we've reached the end
            if (signatures.length < SIGNATURES_PER_PAGE) {
                break;
            }

            // Rate limiting - small delay between pages
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Cache the result
        if (oldestBlockTime) {
            upsertHolder(wallet, {
                first_seen_ts: oldestBlockTime,
            });
            console.log(`[AGE] Wallet ${wallet.slice(0, 8)}... age: ${new Date(oldestBlockTime * 1000).toISOString()}`);
        }

        return oldestBlockTime;
    } catch (err) {
        console.error(`[AGE] Error computing age for ${wallet}:`, err);
        return null;
    }
}

/**
 * Get wallet age in days from the current time.
 */
export function getWalletAgeDays(firstSeenTs: number): number {
    const now = Math.floor(Date.now() / 1000);
    const ageSeconds = now - firstSeenTs;
    return ageSeconds / (24 * 60 * 60);
}

/**
 * Check if wallet meets minimum age requirement.
 */
export function isWalletAgeEligible(firstSeenTs: number | null, minAgeDays: number): boolean {
    if (!firstSeenTs) return false;
    return getWalletAgeDays(firstSeenTs) >= minAgeDays;
}
