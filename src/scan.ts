import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'cross-fetch';
import { getConfig } from './config';
import { getHolder, upsertHolder, getScanState, setScanState, incrementBuySol } from './db';
import { computeWalletAge } from './age';

// ─────────────────────────────────────────────────────────────────────────────
// Helius Enhanced API Types
// ─────────────────────────────────────────────────────────────────────────────

interface HeliusTokenTransfer {
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
}

interface HeliusNativeTransfer {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number; // lamports
}

interface HeliusSwapEvent {
    nativeInput?: {
        account: string;
        amount: string;
    };
    nativeOutput?: {
        account: string;
        amount: string;
    };
    tokenInputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        mint: string;
        rawTokenAmount: {
            tokenAmount: string;
            decimals: number;
        };
    }>;
    tokenOutputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        mint: string;
        rawTokenAmount: {
            tokenAmount: string;
            decimals: number;
        };
    }>;
}

interface HeliusEnrichedTransaction {
    signature: string;
    timestamp: number;
    type: string;
    source: string;
    fee: number;
    feePayer: string;
    tokenTransfers: HeliusTokenTransfer[];
    nativeTransfers: HeliusNativeTransfer[];
    events?: {
        swap?: HeliusSwapEvent;
    };
    accountData: Array<{
        account: string;
        nativeBalanceChange: number;
        tokenBalanceChanges: Array<{
            userAccount: string;
            tokenAccount: string;
            mint: string;
            rawTokenAmount: {
                tokenAmount: string;
                decimals: number;
            };
        }>;
    }>;
}

interface HeliusParseResponse {
    result: HeliusEnrichedTransaction[];
    paginationToken?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Buy Detection Result
// ─────────────────────────────────────────────────────────────────────────────

export interface DetectedBuy {
    wallet: string;
    solSpent: number;
    tokenReceived: number;
    signature: string;
    timestamp: number;
    confidence: 'high' | 'medium' | 'low';
    source: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helius API Client
// ─────────────────────────────────────────────────────────────────────────────

async function fetchHeliusParsedTransactions(
    address: string,
    limit: number,
    paginationToken?: string
): Promise<HeliusParseResponse> {
    const config = getConfig();

    // Use explicit HELIUS_API_KEY from config
    const apiKey = config.heliusApiKey;

    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions`;
    const params = new URLSearchParams({
        'api-key': apiKey,
        limit: limit.toString(),
    });

    if (paginationToken) {
        params.set('before', paginationToken);
    }

    const response = await fetch(`${url}?${params.toString()}`);

    if (!response.ok) {
        throw new Error(`Helius API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as HeliusEnrichedTransaction[];

    // Helius returns array directly, pagination token is last signature
    const lastSig = data.length > 0 ? data[data.length - 1].signature : undefined;

    return {
        result: data,
        paginationToken: data.length === limit ? lastSig : undefined,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Buy Detection Logic
// ─────────────────────────────────────────────────────────────────────────────

function detectBuysFromTransaction(
    tx: HeliusEnrichedTransaction,
    tokenMint: string
): DetectedBuy[] {
    const buys: DetectedBuy[] = [];

    // Method 1: High confidence - Helius parsed swap event
    if (tx.events?.swap) {
        const swap = tx.events.swap;

        // Check for SOL input + token output (buy)
        if (swap.nativeInput && swap.tokenOutputs) {
            for (const tokenOut of swap.tokenOutputs) {
                if (tokenOut.mint === tokenMint) {
                    const solSpent = parseInt(swap.nativeInput.amount) / 1e9;
                    const tokenReceived = parseInt(tokenOut.rawTokenAmount.tokenAmount) /
                        Math.pow(10, tokenOut.rawTokenAmount.decimals);

                    buys.push({
                        wallet: tokenOut.userAccount,
                        solSpent,
                        tokenReceived,
                        signature: tx.signature,
                        timestamp: tx.timestamp,
                        confidence: 'high',
                        source: tx.source || 'swap',
                    });
                }
            }
        }
    }

    // Method 2: Medium confidence - Balance change analysis
    if (buys.length === 0) {
        for (const account of tx.accountData) {
            // Look for accounts that spent SOL and received tokens
            const solChange = account.nativeBalanceChange;
            const tokenChange = account.tokenBalanceChanges.find(
                tc => tc.mint === tokenMint
            );

            if (solChange < 0 && tokenChange) {
                const tokenAmount = parseInt(tokenChange.rawTokenAmount.tokenAmount);

                // SOL decreased and token increased = likely a buy
                if (tokenAmount > 0) {
                    const solSpent = Math.abs(solChange) / 1e9;

                    // Skip if SOL spent is just fees (< 0.001 SOL)
                    if (solSpent < 0.001) continue;

                    buys.push({
                        wallet: account.account,
                        solSpent,
                        tokenReceived: tokenAmount / Math.pow(10, tokenChange.rawTokenAmount.decimals),
                        signature: tx.signature,
                        timestamp: tx.timestamp,
                        confidence: 'medium',
                        source: tx.source || 'balance_change',
                    });
                }
            }
        }
    }

    // Method 3: Low confidence - Token transfer + native transfer correlation
    if (buys.length === 0 && tx.tokenTransfers.length > 0 && tx.nativeTransfers.length > 0) {
        for (const tokenTx of tx.tokenTransfers) {
            if (tokenTx.mint !== tokenMint) continue;
            if (tokenTx.tokenAmount <= 0) continue;

            // Find corresponding SOL transfer from the same account
            const matchingNative = tx.nativeTransfers.find(
                nt => nt.fromUserAccount === tokenTx.toUserAccount && nt.amount > 0
            );

            if (matchingNative) {
                buys.push({
                    wallet: tokenTx.toUserAccount,
                    solSpent: matchingNative.amount / 1e9,
                    tokenReceived: tokenTx.tokenAmount,
                    signature: tx.signature,
                    timestamp: tx.timestamp,
                    confidence: 'low',
                    source: 'transfer_correlation',
                });
            }
        }
    }

    return buys;
}

// ─────────────────────────────────────────────────────────────────────────────
// Holder Discovery
// ─────────────────────────────────────────────────────────────────────────────

function extractHoldersFromTransaction(
    tx: HeliusEnrichedTransaction,
    tokenMint: string
): Set<string> {
    const holders = new Set<string>();

    // From token transfers
    for (const transfer of tx.tokenTransfers) {
        if (transfer.mint === tokenMint) {
            if (transfer.toUserAccount) holders.add(transfer.toUserAccount);
            if (transfer.fromUserAccount) holders.add(transfer.fromUserAccount);
        }
    }

    // From account data
    for (const account of tx.accountData) {
        for (const tokenChange of account.tokenBalanceChanges) {
            if (tokenChange.mint === tokenMint) {
                holders.add(account.account);
            }
        }
    }

    return holders;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Scan Functions
// ─────────────────────────────────────────────────────────────────────────────

const SCAN_STATE_KEY = 'last_processed_signature';
const SCAN_STATE_TIMESTAMP_KEY = 'last_processed_timestamp';

export interface ScanResult {
    newHolders: string[];
    buysDetected: DetectedBuy[];
    transactionsProcessed: number;
    lastSignature: string | null;
}

/**
 * Scan for new token activity using Helius parsed transactions.
 */
export async function scanTokenActivity(
    connection: Connection,
    limit: number,
    isBootstrap: boolean = false
): Promise<ScanResult> {
    const config = getConfig();
    const tokenMintStr = config.tokenMint.toBase58();

    // Get last processed signature for incremental scanning
    const lastProcessedSig = isBootstrap ? null : getScanState(SCAN_STATE_KEY);

    const result: ScanResult = {
        newHolders: [],
        buysDetected: [],
        transactionsProcessed: 0,
        lastSignature: null,
    };

    const seenHolders = new Set<string>();
    let paginationToken: string | undefined = undefined;
    let totalFetched = 0;

    // FIX: Flag to track if we reached the last processed signature
    let reachedLastProcessed = false;

    try {
        while (totalFetched < limit) {
            const batchSize = Math.min(100, limit - totalFetched);
            const response = await fetchHeliusParsedTransactions(
                tokenMintStr,
                batchSize,
                paginationToken
            );

            if (response.result.length === 0) {
                break;
            }

            for (const tx of response.result) {
                // Stop if we've reached previously processed transactions
                if (lastProcessedSig && tx.signature === lastProcessedSig) {
                    console.log(`[SCAN] Reached last processed signature, stopping`);
                    // FIX: Set flag and break inner loop
                    reachedLastProcessed = true;
                    break;
                }

                // Track first signature for state
                if (!result.lastSignature) {
                    result.lastSignature = tx.signature;
                }

                // Extract holders
                const txHolders = extractHoldersFromTransaction(tx, tokenMintStr);
                for (const holder of txHolders) {
                    if (!seenHolders.has(holder)) {
                        seenHolders.add(holder);

                        // Check if this is a new holder (not in DB)
                        const existing = getHolder(holder);
                        if (!existing) {
                            result.newHolders.push(holder);
                            upsertHolder(holder, {
                                last_seen_ts: tx.timestamp,
                            });
                        }
                    }
                }

                // Detect buys
                const buys = detectBuysFromTransaction(tx, tokenMintStr);
                for (const buy of buys) {
                    result.buysDetected.push(buy);

                    // Record buy in database
                    const isHighConfidence = buy.confidence === 'high';
                    incrementBuySol(buy.wallet, buy.solSpent, isHighConfidence);
                }

                result.transactionsProcessed++;
            }

            // FIX: Break outer loop if we reached last processed signature
            if (reachedLastProcessed) {
                break;
            }

            totalFetched += response.result.length;
            paginationToken = response.paginationToken;

            if (!paginationToken) {
                break;
            }

            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        // Save scan state
        if (result.lastSignature) {
            setScanState(SCAN_STATE_KEY, result.lastSignature);
            setScanState(SCAN_STATE_TIMESTAMP_KEY, Math.floor(Date.now() / 1000).toString());
        }

        console.log(`[SCAN] Processed ${result.transactionsProcessed} transactions, ` +
            `${result.newHolders.length} new holders, ${result.buysDetected.length} buys detected`);

        // Compute ages for new holders (in background, don't block)
        if (result.newHolders.length > 0) {
            computeAgesInBackground(connection, result.newHolders);
        }

    } catch (err) {
        console.error('[SCAN] Error scanning token activity:', err);
    }

    return result;
}

/**
 * Compute wallet ages in background with rate limiting.
 */
async function computeAgesInBackground(
    connection: Connection,
    wallets: string[]
): Promise<void> {
    console.log(`[SCAN] Computing ages for ${wallets.length} wallets in background`);

    // Process in small batches with delays
    const BATCH_SIZE = 5;
    const DELAY_MS = 500;

    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
        const batch = wallets.slice(i, i + BATCH_SIZE);

        await Promise.all(
            batch.map(wallet => computeWalletAge(connection, wallet).catch(err => {
                console.error(`[SCAN] Age computation error for ${wallet}:`, err);
            }))
        );

        if (i + BATCH_SIZE < wallets.length) {
            await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        }
    }
}

/**
 * Bootstrap scan - fetch historical data on first run.
 */
export async function bootstrapScan(connection: Connection): Promise<ScanResult> {
    const config = getConfig();
    console.log(`[SCAN] Starting bootstrap scan (limit: ${config.bootstrapSignatureLimit})`);

    return scanTokenActivity(connection, config.bootstrapSignatureLimit, true);
}

/**
 * Incremental scan - fetch new data since last scan.
 */
export async function incrementalScan(connection: Connection): Promise<ScanResult> {
    const config = getConfig();
    console.log(`[SCAN] Starting incremental scan (limit: ${config.signatureScanLimitPerTick})`);

    return scanTokenActivity(connection, config.signatureScanLimitPerTick, false);
}
