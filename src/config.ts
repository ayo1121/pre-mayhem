import * as fs from 'fs';
import * as path from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Environment Validation
// ─────────────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value.trim();
}

function optionalEnv(name: string, defaultValue: string): string {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        return defaultValue;
    }
    return value.trim();
}

function parseIntEnv(name: string, defaultValue: number): number {
    const value = process.env[name];
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        throw new Error(`Invalid integer for ${name}: ${value}`);
    }
    return parsed;
}

function parseFloatEnv(name: string, defaultValue: number): number {
    const value = process.env[name];
    if (!value) return defaultValue;
    const parsed = parseFloat(value);
    if (isNaN(parsed)) {
        throw new Error(`Invalid float for ${name}: ${value}`);
    }
    return parsed;
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
    const value = process.env[name]?.toLowerCase();
    if (!value) return defaultValue;
    return value === 'true' || value === '1' || value === 'yes';
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Treasury Keypair
// ─────────────────────────────────────────────────────────────────────────────

function loadKeypair(filePath: string): Keypair {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Treasury keypair file not found: ${filePath}`);
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const secretKey = JSON.parse(raw);

        if (!Array.isArray(secretKey) || secretKey.length !== 64) {
            throw new Error('Invalid keypair format: expected 64-byte array');
        }

        return Keypair.fromSecretKey(Uint8Array.from(secretKey));
    } catch (err) {
        throw new Error(`Failed to load keypair from ${filePath}: ${err}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface Config {
    // RPC
    rpcUrl: string;

    // Helius API (explicit, separate from RPC)
    heliusApiKey: string;

    // Token
    tokenMint: PublicKey;

    // Treasury
    treasuryKeypair: Keypair;
    treasuryPubkey: PublicKey;

    // Scheduling
    buyIntervalSeconds: number;
    rewardIntervalSeconds: number;

    // Eligibility
    walletMinAgeDays: number;
    minContinuitySeconds: number;
    minCumulativeBuySol: number;
    winnersPerRound: number;

    // Treasury spend
    solFeeReserve: number;
    minBuySol: number;
    maxBuySolPerHour: number;
    jupiterSlippageBps: number;

    // Reward policy
    rewardTokenPercentBps: number;
    maxRewardTokenPercentPerRound: number;
    maxSendsPerTx: number;

    // Indexing
    bootstrapSignatureLimit: number;
    signatureScanLimitPerTick: number;

    // Operations
    dryRun: boolean;

    // Status server
    statusServerPort: number;
    statusAllowedOrigin: string;

    // Paths
    dbPath: string;
    publicDir: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Configuration
// ─────────────────────────────────────────────────────────────────────────────

function buildConfig(): Config {
    const rpcUrl = requireEnv('RPC_URL');
    const heliusApiKey = requireEnv('HELIUS_API_KEY');
    const tokenMintStr = requireEnv('TOKEN_MINT');
    const keypairPath = requireEnv('TREASURY_KEYPAIR_PATH');

    // Validate token mint
    let tokenMint: PublicKey;
    try {
        tokenMint = new PublicKey(tokenMintStr);
    } catch {
        throw new Error(`Invalid TOKEN_MINT address: ${tokenMintStr}`);
    }

    // Load treasury keypair
    const treasuryKeypair = loadKeypair(keypairPath);

    // Parse safety caps with sensible defaults
    const rewardTokenPercentBps = parseIntEnv('REWARD_TOKEN_PERCENT_BPS', 9000);
    const maxRewardTokenPercentPerRound = parseIntEnv('MAX_REWARD_TOKEN_PERCENT_PER_ROUND', 3000);

    return {
        rpcUrl,
        heliusApiKey,
        tokenMint,
        treasuryKeypair,
        treasuryPubkey: treasuryKeypair.publicKey,

        // Scheduling
        buyIntervalSeconds: parseIntEnv('BUY_INTERVAL_SECONDS', 3600),
        rewardIntervalSeconds: parseIntEnv('REWARD_INTERVAL_SECONDS', 7200),

        // Eligibility
        walletMinAgeDays: parseIntEnv('WALLET_MIN_AGE_DAYS', 90),
        minContinuitySeconds: parseIntEnv('MIN_CONTINUITY_SECONDS', 7200),
        minCumulativeBuySol: parseFloatEnv('MIN_CUMULATIVE_BUY_SOL', 0.1),
        winnersPerRound: parseIntEnv('WINNERS_PER_ROUND', 10),

        // Treasury spend
        solFeeReserve: parseFloatEnv('SOL_FEE_RESERVE', 0.03),
        minBuySol: parseFloatEnv('MIN_BUY_SOL', 0.01),
        maxBuySolPerHour: parseFloatEnv('MAX_BUY_SOL_PER_HOUR', 0.2),
        jupiterSlippageBps: parseIntEnv('JUPITER_SLIPPAGE_BPS', 300),

        // Reward policy - apply cap
        rewardTokenPercentBps: Math.min(rewardTokenPercentBps, maxRewardTokenPercentPerRound),
        maxRewardTokenPercentPerRound,
        maxSendsPerTx: parseIntEnv('MAX_SENDS_PER_TX', 6),

        // Indexing
        bootstrapSignatureLimit: parseIntEnv('BOOTSTRAP_SIGNATURE_LIMIT', 5000),
        signatureScanLimitPerTick: parseIntEnv('SIGNATURE_SCAN_LIMIT_PER_TICK', 1000),

        // Operations
        dryRun: parseBoolEnv('DRY_RUN', false),

        // Status server
        statusServerPort: parseIntEnv('STATUS_SERVER_PORT', 3001),
        statusAllowedOrigin: optionalEnv('STATUS_ALLOWED_ORIGIN', '*'),

        // Paths
        dbPath: path.join(process.cwd(), 'data', 'bot.db'),
        publicDir: path.join(process.cwd(), 'public'),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export Singleton
// ─────────────────────────────────────────────────────────────────────────────

let _config: Config | null = null;

export function getConfig(): Config {
    if (!_config) {
        _config = buildConfig();
    }
    return _config;
}

export function resetConfig(): void {
    _config = null;
}
