import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { getConfig } from './config';
import { getAllHolders, updateHolderBalance, HolderRow } from './db';
import { getTokenDecimals, rawToUi } from './token';

// ─────────────────────────────────────────────────────────────────────────────
// Balance Refresh
// ─────────────────────────────────────────────────────────────────────────────

export interface BalanceUpdate {
    wallet: string;
    balanceRaw: string;
    balanceUi: number;
    previousBalanceRaw: string | null;
    decreased: boolean;
}

/**
 * Refresh token balances for all known holders.
 * Returns list of balance updates with decrease detection.
 */
export async function refreshAllBalances(connection: Connection): Promise<BalanceUpdate[]> {
    const config = getConfig();
    const holders = getAllHolders();
    const decimals = await getTokenDecimals(connection);
    const now = Math.floor(Date.now() / 1000);

    const updates: BalanceUpdate[] = [];
    const BATCH_SIZE = 50;

    console.log(`[BALANCES] Refreshing balances for ${holders.length} holders`);

    for (let i = 0; i < holders.length; i += BATCH_SIZE) {
        const batch = holders.slice(i, i + BATCH_SIZE);

        const batchUpdates = await Promise.all(
            batch.map(async (holder) => {
                return await refreshHolderBalance(connection, holder, decimals, now);
            })
        );

        for (const update of batchUpdates) {
            if (update) {
                updates.push(update);
            }
        }

        // Rate limiting
        if (i + BATCH_SIZE < holders.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    const decreasedCount = updates.filter(u => u.decreased).length;
    console.log(`[BALANCES] Updated ${updates.length} balances, ${decreasedCount} decreased (continuity broken)`);

    return updates;
}

/**
 * Refresh balance for a single holder.
 */
async function refreshHolderBalance(
    connection: Connection,
    holder: HolderRow,
    decimals: number,
    now: number
): Promise<BalanceUpdate | null> {
    const config = getConfig();

    try {
        const walletPubkey = new PublicKey(holder.wallet);
        const ata = await getAssociatedTokenAddress(config.tokenMint, walletPubkey);

        let balanceRaw = '0';

        try {
            const account = await getAccount(connection, ata);
            balanceRaw = account.amount.toString();
        } catch {
            // Account doesn't exist - balance is 0
        }

        const previousBalanceRaw = holder.last_balance_raw;
        const currentBalance = BigInt(balanceRaw);
        const prevBalance = previousBalanceRaw ? BigInt(previousBalanceRaw) : BigInt(0);
        const decreased = currentBalance < prevBalance;

        // Update database
        updateHolderBalance(holder.wallet, balanceRaw, now, previousBalanceRaw);

        return {
            wallet: holder.wallet,
            balanceRaw,
            balanceUi: rawToUi(balanceRaw, decimals),
            previousBalanceRaw,
            decreased,
        };
    } catch (err) {
        console.error(`[BALANCES] Error refreshing ${holder.wallet}:`, err);
        return null;
    }
}

/**
 * Get current token balance for a specific wallet.
 */
export async function getWalletTokenBalance(
    connection: Connection,
    wallet: string
): Promise<{ raw: string; ui: number }> {
    const config = getConfig();
    const decimals = await getTokenDecimals(connection);
    const walletPubkey = new PublicKey(wallet);
    const ata = await getAssociatedTokenAddress(config.tokenMint, walletPubkey);

    try {
        const account = await getAccount(connection, ata);
        const raw = account.amount.toString();
        return {
            raw,
            ui: rawToUi(raw, decimals),
        };
    } catch {
        return { raw: '0', ui: 0 };
    }
}

/**
 * Get treasury token balance.
 */
export async function getTreasuryTokenBalance(connection: Connection): Promise<{
    raw: bigint;
    ui: number;
}> {
    const config = getConfig();
    const decimals = await getTokenDecimals(connection);
    const ata = await getAssociatedTokenAddress(config.tokenMint, config.treasuryPubkey);

    try {
        const account = await getAccount(connection, ata);
        return {
            raw: account.amount,
            ui: rawToUi(account.amount, decimals),
        };
    } catch {
        return { raw: BigInt(0), ui: 0 };
    }
}
