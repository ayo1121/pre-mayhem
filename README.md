# Pre-Mayhem

An open-source Solana rewards bot with automated buybacks and weighted lottery rewards for long-term token holders.

> ⚠️ **WARNING**: This bot handles real cryptocurrency. Test thoroughly with `DRY_RUN=true` before using real funds.

---

## ⚠️ Risk Disclosure

**READ THIS CAREFULLY BEFORE USING.**

This software:
- Executes **real transactions** with **real cryptocurrency**
- Operates **autonomously** without human oversight
- Can **lose funds** due to bugs, network issues, or market conditions
- Provides **no guarantees** of any kind

### What This Bot Does NOT Protect Against

| Risk | Description |
|------|-------------|
| **RPC Downtime** | If your RPC is unavailable, transactions may fail |
| **Network Congestion** | Transactions may time out during high load |
| **Slippage** | Market swaps may receive worse rates than expected |
| **Key Compromise** | If your treasury key is stolen, funds are gone |
| **Bot Bugs** | Software defects could cause incorrect behavior |
| **Oracle Failures** | External API issues can affect operation |

### What Users Should NOT Expect

- ❌ Guaranteed returns
- ❌ Perfect uptime
- ❌ Recovery of lost funds
- ❌ Customer support
- ❌ Refunds for any reason

### Why Timers May Pause

- Bot enters **safe mode** after repeated RPC errors
- Treasury balance falls below safety reserve
- Manual intervention is required
- Bot process is stopped or crashed

---

## How to Verify On-Chain

**Don't trust, verify.** All transactions are publicly visible.

### 1. Find the Treasury Address

Check the bot logs or status API for the treasury public key.

### 2. View on Solscan

```
https://solscan.io/account/YOUR_TREASURY_ADDRESS
```

### 3. Verify Transaction Signatures

The status API returns `lastBuyTx` and `lastRewardTxs`. Check each signature on Solscan to confirm:
- Transaction was successful
- Correct amounts were transferred
- Recipients match expected wallets

---

## What It Does

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            HOURLY BUY JOB                                   │
│  Treasury SOL → Jupiter Swap → Token                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BI-HOURLY REWARD JOB                                │
│  Eligible Holders → Weighted Lottery → Winners → Token Distribution        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Eligibility Requirements

| Requirement | Default | Why |
|-------------|---------|-----|
| Wallet Age | 90 days | Prevents new wallet farming |
| Holding Continuity | 2 hours | Excludes quick flippers |
| Cumulative Buys | 0.1 SOL | Excludes airdrop recipients |
| Non-zero Balance | Required | Must hold tokens |

---

## Safety Features

### Execution Safety

- **DB-backed locks**: Prevents double execution
- **Timeouts**: Buy (120s), Reward (180s) max execution
- **Guaranteed cleanup**: Locks always released in `finally` block
- **Finality verification**: Rounds only recorded after tx confirmed

### Treasury Rails

- **MIN_SOL_RESERVE**: Skip buy if balance too low
- **MIN_REWARD_TOKENS**: Skip reward if balance too low
- **Safe Mode**: Auto-pause after repeated RPC errors
- **Manual Exit Required**: Run `--exit-safe-mode` to resume

### Status API

- **Rate limited**: 30 requests/minute per IP
- **Strict CORS**: Exact origin match only
- **Checksum**: SHA256 hash of critical fields
- **Read-only**: No write operations, no secrets

---

## Quick Start

### Prerequisites

- Node.js 20+
- Helius API key ([helius.dev](https://helius.dev))
- Funded Solana wallet

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/pre-mayhem.git
cd pre-mayhem
npm install
```

### 2. Create Treasury Wallet

```bash
solana-keygen new -o treasury.json
chmod 600 treasury.json
```

### 3. Configure

```bash
cp .env.example .env
nano .env
```

**Required variables:**
```env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_KEY
TOKEN_MINT=YOUR_TOKEN_MINT_ADDRESS
TREASURY_KEYPAIR_PATH=/absolute/path/to/treasury.json
DRY_RUN=true
```

### 4. Build & Test

```bash
npm run build
npm run bootstrap    # Fetch historical data
npm run once:buy     # Test buy (dry run)
npm run once:reward  # Test reward (dry run)
```

### 5. Production (PM2)

```bash
npm install -g pm2
npm run pm2:start
pm2 save && pm2 startup
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run start` | Run bot (production) |
| `npm run bootstrap` | Fetch historical data |
| `npm run once:buy` | Single buy job |
| `npm run once:reward` | Single reward job |
| `npm run start -- --exit-safe-mode` | Exit safe mode |
| `npm run pm2:start` | Start with PM2 |
| `npm run pm2:logs` | View logs |

---

## Frontend Deployment

### Vercel

1. Fork/clone this repo
2. Import to Vercel dashboard
3. Set environment variable:
   ```
   NEXT_PUBLIC_STATUS_API_URL=https://api.yourdomain.com/status
   ```
4. Deploy

### Timer Accuracy

Timers use **server time**, not client time:

```typescript
estimatedServerNow = serverTimeAtFetch + elapsedSinceFetch
countdown = max(0, nextTs - estimatedServerNow)
```

Even if a user's clock is wrong, the timer is accurate.

---

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | ✅ | - | Solana RPC endpoint |
| `HELIUS_API_KEY` | ✅ | - | Helius API key |
| `TOKEN_MINT` | ✅ | - | Token mint address |
| `TREASURY_KEYPAIR_PATH` | ✅ | - | Path to wallet |
| `DRY_RUN` | - | `true` | Test mode |
| `MIN_SOL_RESERVE` | - | `0.05` | Safety reserve |
| `MIN_REWARD_TOKENS` | - | `1000` | Minimum tokens |
| `MAX_RPC_ERRORS_BEFORE_PAUSE` | - | `5` | Error threshold |
| `BUY_JOB_TIMEOUT_MS` | - | `120000` | Buy timeout |
| `REWARD_JOB_TIMEOUT_MS` | - | `180000` | Reward timeout |

See `.env.example` for all options.

---

## Security

### NEVER Commit

- `.env` (API keys, config)
- `treasury.json` (private key)
- `data/` (database)
- `logs/` (runtime logs)

### Secure Your Keypair

```bash
chmod 600 treasury.json
```

---

## License

MIT - See [LICENSE](LICENSE)

---

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. USE AT YOUR OWN RISK. THE AUTHORS ARE NOT RESPONSIBLE FOR ANY LOSSES.
