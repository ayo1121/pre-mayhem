import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, getAccount, Account } from '@solana/spl-token';
import { getConfig } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// Token Metadata Cache
// ─────────────────────────────────────────────────────────────────────────────

let _tokenDecimals: number | null = null;

export async function getTokenDecimals(connection: Connection): Promise<number> {
    if (_tokenDecimals !== null) {
        return _tokenDecimals;
    }

    const config = getConfig();
    const mintInfo = await getMint(connection, config.tokenMint);
    _tokenDecimals = mintInfo.decimals;

    console.log(`[TOKEN] Token decimals: ${_tokenDecimals}`);
    return _tokenDecimals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Balance Utilities
// ─────────────────────────────────────────────────────────────────────────────

export function rawToUi(rawAmount: bigint | string, decimals: number): number {
    const raw = typeof rawAmount === 'string' ? BigInt(rawAmount) : rawAmount;
    return Number(raw) / Math.pow(10, decimals);
}

export function uiToRaw(uiAmount: number, decimals: number): bigint {
    return BigInt(Math.floor(uiAmount * Math.pow(10, decimals)));
}

export function lamportsToSol(lamports: number | bigint): number {
    return Number(lamports) / 1e9;
}

export function solToLamports(sol: number): number {
    return Math.floor(sol * 1e9);
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Account Helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function getTokenBalance(
    connection: Connection,
    tokenAccount: PublicKey
): Promise<bigint> {
    try {
        const account = await getAccount(connection, tokenAccount);
        return account.amount;
    } catch (err) {
        // Account doesn't exist or other error
        return BigInt(0);
    }
}

export async function getTokenAccountInfo(
    connection: Connection,
    tokenAccount: PublicKey
): Promise<Account | null> {
    try {
        return await getAccount(connection, tokenAccount);
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Native SOL Balance
// ─────────────────────────────────────────────────────────────────────────────

export async function getSolBalance(
    connection: Connection,
    wallet: PublicKey
): Promise<number> {
    const lamports = await connection.getBalance(wallet);
    return lamportsToSol(lamports);
}
