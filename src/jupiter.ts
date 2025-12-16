import {
    Connection,
    PublicKey,
    VersionedTransaction,
    TransactionMessage,
    AddressLookupTableAccount,
} from '@solana/web3.js';
import fetch from 'cross-fetch';
import { getConfig } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// Jupiter API Types
// ─────────────────────────────────────────────────────────────────────────────

interface JupiterQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    priceImpactPct: string;
    routePlan: Array<{
        swapInfo: {
            ammKey: string;
            label: string;
            inputMint: string;
            outputMint: string;
            inAmount: string;
            outAmount: string;
            feeAmount: string;
            feeMint: string;
        };
        percent: number;
    }>;
    contextSlot?: number;
    timeTaken?: number;
}

interface JupiterSwapResponse {
    swapTransaction: string;
    lastValidBlockHeight: number;
    prioritizationFeeLamports?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Jupiter API Constants
// ─────────────────────────────────────────────────────────────────────────────

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ─────────────────────────────────────────────────────────────────────────────
// Quote Functions
// ─────────────────────────────────────────────────────────────────────────────

export interface SwapQuote {
    inputMint: string;
    outputMint: string;
    inAmountLamports: bigint;
    outAmount: bigint;
    priceImpactPct: number;
    slippageBps: number;
    minOutAmount: bigint;
    rawQuote: JupiterQuoteResponse;
}

/**
 * Get a quote for swapping SOL to TOKEN.
 */
export async function getSwapQuote(
    solAmountLamports: bigint,
    slippageBps: number
): Promise<SwapQuote> {
    const config = getConfig();
    const tokenMint = config.tokenMint.toBase58();

    const params = new URLSearchParams({
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: solAmountLamports.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false',
    });

    const response = await fetch(`${JUPITER_QUOTE_API}?${params.toString()}`);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jupiter quote error: ${response.status} - ${text}`);
    }

    const quote = await response.json() as JupiterQuoteResponse;

    return {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmountLamports: BigInt(quote.inAmount),
        outAmount: BigInt(quote.outAmount),
        priceImpactPct: parseFloat(quote.priceImpactPct),
        slippageBps: quote.slippageBps,
        minOutAmount: BigInt(quote.otherAmountThreshold),
        rawQuote: quote,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Swap Execution
// ─────────────────────────────────────────────────────────────────────────────

export interface SwapResult {
    success: boolean;
    signature?: string;
    error?: string;
    inAmountSol: number;
    outAmountToken: number;
}

/**
 * Execute a swap from SOL to TOKEN via Jupiter.
 */
export async function executeSwap(
    connection: Connection,
    quote: SwapQuote
): Promise<SwapResult> {
    const config = getConfig();

    console.log(`[JUPITER] Executing swap: ${Number(quote.inAmountLamports) / 1e9} SOL → TOKEN`);
    console.log(`[JUPITER] Expected output: ${quote.outAmount.toString()} raw tokens`);
    console.log(`[JUPITER] Price impact: ${quote.priceImpactPct}%`);

    if (config.dryRun) {
        console.log('[JUPITER] DRY RUN - skipping actual swap');
        return {
            success: true,
            signature: 'dry-run-signature',
            inAmountSol: Number(quote.inAmountLamports) / 1e9,
            outAmountToken: Number(quote.outAmount),
        };
    }

    try {
        // Get swap transaction from Jupiter
        const swapResponse = await fetch(JUPITER_SWAP_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse: quote.rawQuote,
                userPublicKey: config.treasuryPubkey.toBase58(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 'auto',
            }),
        });

        if (!swapResponse.ok) {
            const text = await swapResponse.text();
            throw new Error(`Jupiter swap error: ${swapResponse.status} - ${text}`);
        }

        const swapData = await swapResponse.json() as JupiterSwapResponse;

        // Deserialize the transaction
        const swapTxBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTxBuf);

        // Sign with treasury keypair
        transaction.sign([config.treasuryKeypair]);

        // Send and confirm
        const signature = await connection.sendTransaction(transaction, {
            maxRetries: 3,
            skipPreflight: false,
        });

        console.log(`[JUPITER] Transaction sent: ${signature}`);

        // Wait for confirmation
        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash: transaction.message.recentBlockhash,
            lastValidBlockHeight: swapData.lastValidBlockHeight,
        }, 'confirmed');

        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        console.log(`[JUPITER] Swap confirmed: ${signature}`);

        return {
            success: true,
            signature,
            inAmountSol: Number(quote.inAmountLamports) / 1e9,
            outAmountToken: Number(quote.outAmount),
        };

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[JUPITER] Swap failed:`, errorMessage);

        return {
            success: false,
            error: errorMessage,
            inAmountSol: Number(quote.inAmountLamports) / 1e9,
            outAmountToken: 0,
        };
    }
}

/**
 * Get quote and execute swap in one call.
 */
export async function swapSolToToken(
    connection: Connection,
    solAmountLamports: bigint
): Promise<SwapResult> {
    const config = getConfig();

    try {
        const quote = await getSwapQuote(solAmountLamports, config.jupiterSlippageBps);
        return await executeSwap(connection, quote);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            error: errorMessage,
            inAmountSol: Number(solAmountLamports) / 1e9,
            outAmountToken: 0,
        };
    }
}
