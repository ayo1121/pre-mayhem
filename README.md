# Pump.fun Age Streak Bot

An open-source Solana rewards bot for pump.fun tokens (or any SPL token) with automated buys and weighted lottery rewards for long-term holders.

> ⚠️ **WARNING**: This bot handles real cryptocurrency. Test thoroughly with `DRY_RUN=true` before using real funds. No guarantees are provided.

## What It Does

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            HOURLY BUY JOB                                   │
│  Treasury SOL → Jupiter Swap → Token                                       │
│  (Automatically buys token every hour using available SOL)                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BI-HOURLY REWARD JOB                                │
│  Eligible Holders → Weighted Lottery → 10 Winners → Token Distribution     │
│  (Distributes treasury tokens to qualified long-term holders)              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Features

- **Automated Token Buys**: Swaps treasury SOL to your token via Jupiter every hour
- **Holder Rewards**: Distributes tokens to 10 weighted-random eligible winners every 2 hours
- **Anti-Sybil Protection**: Requires 90-day wallet age + 0.1 SOL buy history + 2hr holding
- **Crash-Safe**: DB-persisted execution locks prevent double execution
- **Public Status API**: Read-only endpoint for frontend timers
- **Vercel Frontend**: Mobile-first UI with exact server-synced countdowns

### Works With Any Token

This bot is **generic** — configure it for any SPL or pump.fun token by setting `TOKEN_MINT` in your `.env`.

---

## ⚠️ Safety Disclaimer

**This software involves real cryptocurrency transactions.**

- Always test with `DRY_RUN=true` first
- Start with small amounts
- Verify all transactions on-chain
- No guarantees or warranties provided
- You are responsible for your funds

---

## Quick Start

### Prerequisites

- Node.js 20+
- A Helius API key (free at [helius.dev](https://helius.dev))
- A funded Solana wallet (treasury)

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/pumpfun-age-streak-bot.git
cd pumpfun-age-streak-bot
npm install
```

### 2. Create Treasury Wallet

```bash
solana-keygen new -o treasury.json
chmod 600 treasury.json  # Restrict permissions
```

> ⚠️ **NEVER commit `treasury.json` to git!**

### 3. Configure Environment

```bash
cp .env.example .env
nano .env
```

Fill in required values:
```env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_KEY
TOKEN_MINT=YOUR_TOKEN_MINT_ADDRESS
TREASURY_KEYPAIR_PATH=/absolute/path/to/treasury.json
DRY_RUN=true
```

### 4. Build & Bootstrap

```bash
npm run build
npm run bootstrap  # Fetches historical holder data
```

### 5. Test (DRY_RUN=true)

```bash
npm run once:buy
npm run once:reward
```

Check logs in `public/last_buy.json` and `public/last_reward.json`.

### 6. Start Bot

```bash
npm run start
```

For production, use PM2:
```bash
npm install -g pm2
npm run pm2:start
pm2 save
pm2 startup
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              VPS (Bot Server)                                │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  pumpfun-age-streak-bot (PM2)                                         │  │
│  │  ├── Cron Jobs: Buy (1h), Reward (2h), Scan (10min)                  │  │
│  │  ├── SQLite Database (holder data, rounds, locks)                    │  │
│  │  ├── Execution Locks (prevents double execution)                      │  │
│  │  ├── Heartbeat (bot online status)                                   │  │
│  │  └── Status API (port 3001) ───────────────────────────┐             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                  │          │
│                                          GET /status (read-only) │          │
│                                                                  ▼          │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Nginx (optional) - Reverse proxy to port 3001                        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼ HTTPS
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Vercel (Frontend)                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Next.js App                                                          │  │
│  │  ├── useBotStatus hook (fetches status every 30s)                    │  │
│  │  ├── Server-synced timers (no clock drift)                           │  │
│  │  └── Mobile-first design                                              │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Eligibility Requirements

Holders must meet **all** criteria to be reward-eligible:

| Requirement | Default | Why |
|-------------|---------|-----|
| Wallet Age | 90 days | Prevents new wallet farming |
| Holding Continuity | 2 hours | Excludes quick flippers |
| Cumulative Buys | 0.1 SOL | Excludes airdrop recipients |
| Non-zero Balance | Required | Must hold tokens |

### Weight Formula

```
weight = sqrt(wallet_age_days) 
       × min(3, 1 + streak_rounds/10) 
       × min(5, 1 + log10(1 + twb_score))
```

Longer holders have higher chances, but everyone eligible can win.

---

## Frontend Deployment (Vercel)

### 1. Prepare

```bash
cd frontend
npm install
cp .env.example .env.local
```

### 2. Configure

Set your VPS status API URL:
```env
NEXT_PUBLIC_STATUS_API_URL=https://api.yourdomain.com/status
```

### 3. Deploy

```bash
npm install -g vercel
vercel
```

Or connect your GitHub repo to Vercel dashboard.

### Timer Accuracy

The frontend uses **server-synced timers**:

```typescript
// Synced to server time, not local clock
estimatedServerNow = serverTimeAtFetch + timeSinceFetch
countdown = max(0, nextTs - estimatedServerNow)
```

Even if a user's clock is wrong, the timer is accurate.

---

## VPS Status API (Nginx)

### 1. Install Nginx

```bash
sudo apt install nginx
```

### 2. Configure

```bash
sudo nano /etc/nginx/sites-available/bot-status
```

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location /status {
        proxy_pass http://127.0.0.1:3001/status;
        proxy_set_header Host $host;
    }
}
```

### 3. Enable & SSL

```bash
sudo ln -s /etc/nginx/sites-available/bot-status /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

### 4. Update Bot Config

```env
STATUS_ALLOWED_ORIGIN=https://your-frontend.vercel.app
```

---

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | ✅ | - | Solana RPC endpoint |
| `HELIUS_API_KEY` | ✅ | - | Helius API key |
| `TOKEN_MINT` | ✅ | - | Token mint address |
| `TREASURY_KEYPAIR_PATH` | ✅ | - | Path to wallet keypair |
| `DRY_RUN` | - | `true` | Test mode (no real txs) |
| `BUY_INTERVAL_SECONDS` | - | `3600` | Buy job frequency |
| `REWARD_INTERVAL_SECONDS` | - | `7200` | Reward job frequency |
| `WINNERS_PER_ROUND` | - | `10` | Reward winners |
| `STATUS_SERVER_PORT` | - | `3001` | Status API port |
| `STATUS_ALLOWED_ORIGIN` | - | `*` | CORS origin |

See `.env.example` for all options.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run start` | Run bot (production) |
| `npm run dev` | Run with ts-node |
| `npm run bootstrap` | Fetch historical data |
| `npm run once:buy` | Single buy job |
| `npm run once:reward` | Single reward job |
| `npm run pm2:start` | Start with PM2 |
| `npm run pm2:stop` | Stop PM2 |
| `npm run pm2:logs` | View logs |

---

## Customizing for Your Token

1. Set `TOKEN_MINT` to your token's mint address
2. Adjust eligibility (`WALLET_MIN_AGE_DAYS`, `MIN_CUMULATIVE_BUY_SOL`)
3. Adjust rewards (`WINNERS_PER_ROUND`, `REWARD_TOKEN_PERCENT_BPS`)
4. Fund treasury with SOL (for buys + fees)
5. Test with `DRY_RUN=true`

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

### Test First

Always run with `DRY_RUN=true` before production.

---

## Crash Safety

The bot uses DB-persisted execution locks:

1. Jobs acquire lock before execution
2. Lock released in `finally` (success or failure)
3. Stale locks cleared on startup (2× interval)
4. Heartbeat indicates bot online status

**No double buys or rewards, even after crashes.**

---

## License

MIT - See [LICENSE](LICENSE)

---

## Contributing

Contributions welcome! Please:

1. Fork the repo
2. Create a feature branch
3. Test thoroughly
4. Submit a PR

---

## Support

This is open-source software provided as-is. For issues:

1. Check existing GitHub issues
2. Create a new issue with details
3. Include logs and configuration (redact secrets!)
