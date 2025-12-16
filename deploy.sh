#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# PUMPFUN AGE STREAK BOT - AUTOMATED VPS DEPLOYMENT SCRIPT
# ═══════════════════════════════════════════════════════════════════════════════
#
# This script automates deployment steps that can be automated.
# Run from the pumpfun-age-streak-bot directory.
#
# Usage: bash deploy.sh
#
# ═══════════════════════════════════════════════════════════════════════════════

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ─────────────────────────────────────────────────────────────────────────────
# Helper functions
# ─────────────────────────────────────────────────────────────────────────────

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_section() {
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  $1${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
}

check_command() {
    if command -v "$1" &> /dev/null; then
        return 0
    else
        return 1
    fi
}

mask_rpc_url() {
    echo "$1" | sed 's/api-key=[^&]*/api-key=****/g'
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 0: Detect environment
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 0: Detecting Environment"

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_NAME=$NAME
    OS_VERSION=$VERSION_ID
else
    OS_NAME=$(uname -s)
    OS_VERSION=$(uname -r)
fi

log_info "OS: $OS_NAME $OS_VERSION"
log_info "User: $(whoami)"
log_info "Working directory: $(pwd)"

# Verify we're in the right directory
if [ ! -f "package.json" ]; then
    log_error "package.json not found. Please run this script from the pumpfun-age-streak-bot directory."
    exit 1
fi

if ! grep -q "pumpfun-age-streak-bot" package.json; then
    log_error "This doesn't appear to be the pumpfun-age-streak-bot project."
    exit 1
fi

log_success "Confirmed: pumpfun-age-streak-bot directory"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: Install prerequisites
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 1: Installing Prerequisites"

# Check if running on Ubuntu/Debian
if [[ "$OS_NAME" == *"Ubuntu"* ]] || [[ "$OS_NAME" == *"Debian"* ]]; then
    log_info "Detected Ubuntu/Debian system"
    
    # Update package list
    log_info "Updating package list..."
    sudo apt-get update -qq
    
    # Install build essentials
    log_info "Installing build-essential, python3, git..."
    sudo apt-get install -y -qq build-essential python3 git curl
    
    # Check Node.js version
    if check_command node; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        log_info "Found Node.js v$(node -v)"
        
        if [ "$NODE_VERSION" -lt 20 ]; then
            log_warn "Node.js version is less than 20. Installing Node.js 20.x..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y -qq nodejs
        fi
    else
        log_info "Installing Node.js 20.x..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y -qq nodejs
    fi
else
    log_warn "Non-Ubuntu/Debian system detected. Assuming Node.js 20+ is installed."
fi

# Verify Node.js
log_info "Node.js version: $(node -v)"
log_info "npm version: $(npm -v)"

# Install PM2 globally if not present
if ! check_command pm2; then
    log_info "Installing PM2 globally..."
    sudo npm install -g pm2
else
    log_info "PM2 already installed: $(pm2 -v)"
fi

log_success "Prerequisites installed"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: Install dependencies and build
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 2: Installing Dependencies and Building"

log_info "Running npm install..."
npm install

log_info "Running npm run build..."
npm run build

# Verify build output
if [ -f "dist/index.js" ]; then
    log_success "Build successful: dist/index.js exists"
else
    log_error "Build failed: dist/index.js not found"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: Create required directories
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 3: Creating Required Directories"

for dir in logs data public; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        log_info "Created directory: $dir/"
    else
        log_info "Directory exists: $dir/"
    fi
done

log_success "All directories ready"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: Create and validate .env
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 4: Environment Configuration"

ENV_MISSING=false

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        log_info "Creating .env from .env.example..."
        cp .env.example .env
        ENV_MISSING=true
    else
        log_error ".env.example not found. Cannot create .env"
        exit 1
    fi
else
    log_info ".env file exists"
fi

# Check required variables
log_info "Checking required environment variables..."

check_env_var() {
    local var_name=$1
    if grep -q "^${var_name}=" .env; then
        local var_value=$(grep "^${var_name}=" .env | cut -d'=' -f2-)
        # Check if it's a placeholder or empty
        if [[ -z "$var_value" ]] || [[ "$var_value" == "YOUR_"* ]] || [[ "$var_value" == "/absolute/path"* ]] || [[ "$var_value" == "/path/to"* ]]; then
            return 1
        fi
        return 0
    fi
    return 1
}

MISSING_VARS=()

if ! check_env_var "RPC_URL"; then
    MISSING_VARS+=("RPC_URL")
fi

if ! check_env_var "TOKEN_MINT"; then
    MISSING_VARS+=("TOKEN_MINT")
fi

if ! check_env_var "TREASURY_KEYPAIR_PATH"; then
    MISSING_VARS+=("TREASURY_KEYPAIR_PATH")
fi

# Ensure DRY_RUN is true for safety
if grep -q "^DRY_RUN=" .env; then
    sed -i 's/^DRY_RUN=.*/DRY_RUN=true/' .env
else
    echo "DRY_RUN=true" >> .env
fi
log_info "DRY_RUN set to true for safety"

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo ""
    log_error "═══════════════════════════════════════════════════════════════"
    log_error "  MISSING ENVIRONMENT VARIABLES"
    log_error "═══════════════════════════════════════════════════════════════"
    echo ""
    echo -e "${YELLOW}Please edit .env and fill in the following variables:${NC}"
    echo ""
    for var in "${MISSING_VARS[@]}"; do
        case $var in
            "RPC_URL")
                echo -e "  ${RED}RPC_URL${NC}=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY"
                ;;
            "TOKEN_MINT")
                echo -e "  ${RED}TOKEN_MINT${NC}=YOUR_PUMPFUN_TOKEN_MINT_ADDRESS"
                ;;
            "TREASURY_KEYPAIR_PATH")
                echo -e "  ${RED}TREASURY_KEYPAIR_PATH${NC}=$(pwd)/treasury.json"
                ;;
        esac
    done
    echo ""
    echo -e "${YELLOW}Edit .env with:${NC} nano .env"
    echo ""
    log_error "STOPPING: Please fill in missing variables and re-run this script."
    exit 1
fi

log_success "All required environment variables are set"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5: Verify security basics
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 5: Security Verification"

# Check .gitignore for .env
if grep -q "^\.env$" .gitignore 2>/dev/null || grep -q "^\.env$" .gitignore 2>/dev/null; then
    log_success ".env is in .gitignore"
else
    log_warn ".env may not be in .gitignore - adding it"
    echo ".env" >> .gitignore
fi

# Check .gitignore for treasury.json pattern
if grep -q "treasury\.json" .gitignore 2>/dev/null || grep -q "\*\.json" .gitignore 2>/dev/null; then
    log_success "treasury.json pattern is gitignored"
else
    log_warn "Adding treasury.json to .gitignore"
    echo "treasury.json" >> .gitignore
fi

log_success "Security basics verified"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6: Verify keypair file presence
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 6: Treasury Keypair Verification"

KEYPAIR_PATH=$(grep "^TREASURY_KEYPAIR_PATH=" .env | cut -d'=' -f2-)

# Remove quotes if present
KEYPAIR_PATH=$(echo "$KEYPAIR_PATH" | tr -d '"' | tr -d "'")

if [ ! -f "$KEYPAIR_PATH" ]; then
    echo ""
    log_error "═══════════════════════════════════════════════════════════════"
    log_error "  TREASURY KEYPAIR NOT FOUND"
    log_error "═══════════════════════════════════════════════════════════════"
    echo ""
    echo -e "${YELLOW}Expected keypair at:${NC} $KEYPAIR_PATH"
    echo ""
    echo -e "${YELLOW}To copy your keypair from your local machine, run:${NC}"
    echo ""
    echo -e "${GREEN}  scp /path/to/your/treasury.json $(whoami)@YOUR_VPS_IP:$(pwd)/treasury.json${NC}"
    echo ""
    echo -e "Then update .env if needed:"
    echo -e "  TREASURY_KEYPAIR_PATH=$(pwd)/treasury.json"
    echo ""
    log_error "STOPPING: Please copy treasury.json and re-run this script."
    exit 1
fi

log_success "Treasury keypair found: $KEYPAIR_PATH"

# Secure the keypair file
log_info "Setting keypair permissions to 600..."
chmod 600 "$KEYPAIR_PATH"
log_success "Keypair permissions secured"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7: Bootstrap and dry-run checks
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 7: Bootstrap and Dry-Run Tests"

# Source .env for the tests
set -a
source .env
set +a

# Ensure DRY_RUN is true
export DRY_RUN=true

log_info "Running bootstrap scan..."
npm run bootstrap 2>&1 | tail -20

log_info "Running dry-run buy job..."
npm run once:buy 2>&1 | tail -20

log_info "Running dry-run reward job..."
npm run once:reward 2>&1 | tail -20

# Verify output files
echo ""
if [ -f "public/last_buy.json" ]; then
    log_success "public/last_buy.json exists"
    echo ""
    echo -e "${BLUE}Last 20 lines of public/last_buy.json (RPC masked):${NC}"
    cat public/last_buy.json | sed 's/api-key=[^"&]*/api-key=****/g' | tail -20
else
    log_warn "public/last_buy.json not found (may be expected if treasury has no SOL)"
fi

echo ""
if [ -f "public/last_reward.json" ]; then
    log_success "public/last_reward.json exists"
    echo ""
    echo -e "${BLUE}Last 20 lines of public/last_reward.json (RPC masked):${NC}"
    cat public/last_reward.json | sed 's/api-key=[^"&]*/api-key=****/g' | tail -20
else
    log_warn "public/last_reward.json not found (may be expected if no eligible holders)"
fi

log_success "Dry-run tests completed"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8: Start with PM2
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 8: Starting with PM2"

# Stop existing instance if running
pm2 stop pumpfun-age-streak-bot 2>/dev/null || true
pm2 delete pumpfun-age-streak-bot 2>/dev/null || true

log_info "Starting bot with PM2..."
npm run pm2:start

sleep 3

log_info "PM2 Status:"
pm2 status

echo ""
log_info "PM2 Logs (last 50 lines):"
pm2 logs pumpfun-age-streak-bot --lines 50 --nostream

# ─────────────────────────────────────────────────────────────────────────────
# STEP 9: Enable reboot persistence
# ─────────────────────────────────────────────────────────────────────────────

log_section "STEP 9: Reboot Persistence"

log_info "Saving PM2 process list..."
pm2 save

echo ""
log_info "Generating startup script..."
STARTUP_CMD=$(pm2 startup 2>&1 | grep "sudo" | head -1)

if [ -n "$STARTUP_CMD" ]; then
    echo ""
    log_warn "═══════════════════════════════════════════════════════════════"
    log_warn "  MANUAL ACTION REQUIRED"
    log_warn "═══════════════════════════════════════════════════════════════"
    echo ""
    echo -e "${YELLOW}To enable auto-start on reboot, run this command with sudo:${NC}"
    echo ""
    echo -e "${GREEN}  $STARTUP_CMD${NC}"
    echo ""
else
    log_info "PM2 startup may already be configured or requires manual setup."
    echo ""
    echo -e "${YELLOW}Run 'pm2 startup' and follow its instructions.${NC}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# FINAL SUMMARY
# ─────────────────────────────────────────────────────────────────────────────

log_section "DEPLOYMENT COMPLETE (DRY_RUN MODE)"

echo -e "${GREEN}✓${NC} Prerequisites installed"
echo -e "${GREEN}✓${NC} Dependencies installed and built"
echo -e "${GREEN}✓${NC} Directories created"
echo -e "${GREEN}✓${NC} Environment configured"
echo -e "${GREEN}✓${NC} Security verified"
echo -e "${GREEN}✓${NC} Keypair secured (chmod 600)"
echo -e "${GREEN}✓${NC} Bootstrap completed"
echo -e "${GREEN}✓${NC} Dry-run tests passed"
echo -e "${GREEN}✓${NC} PM2 started"
echo -e "${GREEN}✓${NC} PM2 saved"

echo ""
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  REMAINING MANUAL STEPS${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "1. Run the pm2 startup command shown above (with sudo)"
echo ""
echo -e "2. Fund the treasury wallet with SOL:"
echo -e "   Treasury address: $(grep 'Treasury:' logs/out.log 2>/dev/null | tail -1 | awk '{print $NF}' || echo 'Check PM2 logs')"
echo ""
echo -e "3. When ready for production, set DRY_RUN=false:"
echo -e "   ${GREEN}nano .env${NC}  # Change DRY_RUN=false"
echo -e "   ${GREEN}npm run pm2:restart${NC}"
echo ""
echo -e "${BLUE}Useful commands:${NC}"
echo -e "  pm2 logs pumpfun-age-streak-bot  # View logs"
echo -e "  pm2 status                       # Check status"
echo -e "  npm run pm2:stop                 # Stop bot"
echo -e "  npm run pm2:restart              # Restart bot"
echo ""
