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
| **RPC Downtime** | Transactions may fail if RPC unavailable |
| **Network Congestion** | Transactions may time out |
| **Slippage** | Market swaps may receive worse rates |
| **Key Compromise** | If treasury key is stolen, funds are gone |
| **Bot Bugs** | Software defects could cause incorrect behavior |

### Why Timers May Pause

- Bot enters **safe mode** after repeated RPC errors
- Treasury balance falls below safety reserve
- Manual intervention required
- Bot process stopped or crashed

---

## 🚀 Launch Checklist

**Follow this exact order. Do not skip steps.**

| Step | Action | Verify |
|------|--------|--------|
| 1 | Deploy bot (Railway or VPS) | Bot logs show "BOT IS RUNNING" |
| 2 | Verify `/status` endpoint live | `curl https://your-api-domain/status` returns JSON |
| 3 | Deploy frontend to Vercel | Frontend shows "Connecting..." → "Online" |
| 4 | Verify timers move | Countdown decreases each second |
| 5 | Fund treasury (SMALL amount) | 0.1 SOL + 10,000 tokens max |
| 6 | Run dry-run test jobs | `npm run once:buy` and `npm run once:reward` |
| 7 | Flip `DRY_RUN=false` | Update env in Railway/VPS |
| 8 | Restart service | Railway: redeploy. VPS: `pm2 restart` |
| 9 | Watch first real buy | Check Solscan for tx |
| 10 | Announce publicly | Only after step 9 succeeds |

> ⚠️ **NEVER** flip `DRY_RUN=false` before frontend timers work  
> ⚠️ **NEVER** fund treasury heavily before first live buy succeeds

---

## Deployment Options

### Option 1: Railway (Recommended)

Railway provides managed hosting with automatic restarts, built-in logs, and stable public domains.

#### Step 1: Create Railway Project

1. Go to [railway.app](https://railway.app) and create account
2. New Project → Deploy from GitHub repo
3. Select `ayo1121/pre-mayhem`

#### Step 2: Add Volume for Treasury Key

1. In Railway dashboard → Add Volume
2. Mount path: `/app/treasury.json`
3. Open shell and upload your keypair:
   ```bash
   cat > /app/treasury.json << 'EOF'
   [your 64-byte array here]
   EOF
   chmod 600 /app/treasury.json
   ```

#### Step 3: Set Environment Variables

In Railway dashboard → Variables:

```env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_KEY
TOKEN_MINT=YOUR_TOKEN_MINT_ADDRESS
TREASURY_KEYPAIR_PATH=/app/treasury.json
DRY_RUN=true
STATUS_SERVER_PORT=3001
STATUS_ALLOWED_ORIGIN=https://your-frontend.vercel.app
MIN_SOL_RESERVE=0.05
MIN_REWARD_TOKENS=1000
MAX_BUY_SOL_PER_HOUR=0.2
```

#### Step 4: Deploy & Get Status URL

1. Railway will build and deploy automatically
2. Go to Settings → Networking → Generate Domain
3. Your status API will be at: `https://your-app.railway.app/status`

---

### Option 2: VPS (Fallback)

For self-managed servers with PM2.

```bash
# Clone and install
git clone https://github.com/ayo1121/pre-mayhem.git
cd pre-mayhem
npm install

# Create keypair
solana-keygen new -o treasury.json
chmod 600 treasury.json

# Configure
cp .env.example .env
nano .env  # Fill in values

# Build and run
npm run build
npm run bootstrap
npm run pm2:start
pm2 save && pm2 startup
```

Expose status API via Nginx:
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;
    location /status {
        proxy_pass http://127.0.0.1:3001/status;
    }
}
```

---

## Frontend Deployment

### Deploy Your Own Frontend

1. Fork this repo
2. Import `frontend/` to Vercel
3. Set environment variable:
   ```
   NEXT_PUBLIC_STATUS_API_URL=https://your-api-domain.railway.app/status
   ```
4. Deploy

The frontend:
- Reads **only** `NEXT_PUBLIC_STATUS_API_URL`
- Has **no build-time coupling** to the bot
- Shows **"Offline"** if API unreachable
- Shows **"Safe Mode"** if bot paused

---

## How to Verify On-Chain

**Don't trust, verify.** All transactions are publicly visible.

1. Find treasury address in bot logs or `/status` response
2. View on Solscan: `https://solscan.io/account/TREASURY_ADDRESS`
3. Check `lastBuyTx` and `lastRewardTxs` from status API
4. Verify each transaction succeeded

---

## Status API

The status API is the **only integration point** for the frontend.

**Endpoint:** `GET /status`

**Response:**
```json
{
  "now": 1702654321,
  "sourceOfTruth": "server",
  "checksum": "a1b2c3d4e5f6...",
  "botOnline": true,
  "heartbeatAgeSeconds": 15,
  "safeMode": false,
  "safeModeReason": null,
  "dryRun": true,
  "lastBuyTs": 1702650721,
  "lastRewardTs": 1702647121,
  "nextBuyTs": 1702654321,
  "nextRewardTs": 1702654321,
  "buyIntervalSeconds": 3600,
  "rewardIntervalSeconds": 7200,
  "buyInProgress": false,
  "rewardInProgress": false,
  "lastBuyTx": "5abc...",
  "lastRewardTxs": ["5xyz..."]
}
```

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
| `STATUS_ALLOWED_ORIGIN` | - | `*` | CORS origin |

See `.env.example` for all options.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run start` | Run bot |
| `npm run bootstrap` | Fetch historical data |
| `npm run once:buy` | Single buy job |
| `npm run once:reward` | Single reward job |
| `npm run start -- --exit-safe-mode` | Exit safe mode |

---

## Security

### NEVER Commit
- `.env`
- `treasury.json`
- `data/`
- `logs/`

### Treasury Key on Railway
- Must be mounted as volume at `/app/treasury.json`
- Never store in env variables
- Never commit to repo

---

## License

MIT - See [LICENSE](LICENSE)

---

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. USE AT YOUR OWN RISK. THE AUTHORS ARE NOT RESPONSIBLE FOR ANY LOSSES.
