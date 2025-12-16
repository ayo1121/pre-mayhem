'use client';

import { useBotStatus, SystemState } from '@/hooks/useBotStatus';
import { CountdownTimer } from '@/components/CountdownTimer';

// ─────────────────────────────────────────────────────────────────────────────
// System State Banner
// ─────────────────────────────────────────────────────────────────────────────

function SystemStateBanner({ state, reason }: { state: SystemState; reason?: string | null }) {
    if (state === 'online') {
        return (
            <div className="flex items-center justify-center gap-2 text-primary-400">
                <div className="w-3 h-3 bg-primary-500 rounded-full status-dot" />
                <span className="font-medium">Online</span>
            </div>
        );
    }

    if (state === 'safe-mode') {
        return (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-center">
                <div className="flex items-center justify-center gap-2 text-yellow-400 mb-2">
                    <span className="text-xl">⚠️</span>
                    <span className="font-bold">Safe Mode Active</span>
                </div>
                {reason && (
                    <p className="text-xs text-yellow-500/80">{reason}</p>
                )}
                <p className="text-xs text-yellow-500/60 mt-2">
                    Jobs are paused. Manual intervention required.
                </p>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center gap-2 text-red-400">
            <div className="w-3 h-3 bg-red-500 rounded-full" />
            <span className="font-medium">Offline</span>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

export default function HomePage() {
    const {
        status,
        isLoading,
        systemState,
        formattedTimeToNextBuy,
        formattedTimeToNextReward,
        lastBuyFormatted,
        lastRewardFormatted,
    } = useBotStatus();

    // Format interval for display
    const formatInterval = (seconds: number): string => {
        const hours = seconds / 3600;
        if (hours >= 1) {
            return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
        }
        const minutes = seconds / 60;
        return `Every ${minutes} minutes`;
    };

    const isOperational = systemState === 'online';

    return (
        <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-8">
            <div className="w-full max-w-lg space-y-6">
                {/* Header */}
                <div className="text-center space-y-2">
                    <h1 className="text-3xl sm:text-4xl font-bold text-white">
                        Pre-Mayhem
                    </h1>
                    <p className="text-gray-400 text-sm">
                        Automated token buybacks & holder rewards
                    </p>
                </div>

                {/* System State Banner */}
                <div className="py-2">
                    {isLoading ? (
                        <div className="flex items-center justify-center gap-2 text-gray-400">
                            <div className="w-3 h-3 bg-gray-500 rounded-full animate-pulse" />
                            <span>Connecting...</span>
                        </div>
                    ) : (
                        <SystemStateBanner
                            state={systemState}
                            reason={status?.safeModeReason}
                        />
                    )}
                </div>

                {/* Dry Run Badge */}
                {status?.dryRun && (
                    <div className="flex justify-center">
                        <span className="bg-yellow-500/20 text-yellow-400 text-xs px-3 py-1 rounded-full">
                            🧪 DRY RUN MODE
                        </span>
                    </div>
                )}

                {/* Countdown Timers */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <CountdownTimer
                        label="Next Buy"
                        emoji="💰"
                        formattedTime={isLoading ? '--:--' : formattedTimeToNextBuy}
                        inProgress={status?.buyInProgress ?? false}
                        intervalLabel={status ? formatInterval(status.buyIntervalSeconds) : '--'}
                        lastAction={lastBuyFormatted}
                        disabled={!isOperational}
                    />
                    <CountdownTimer
                        label="Next Reward"
                        emoji="🎁"
                        formattedTime={isLoading ? '--:--' : formattedTimeToNextReward}
                        inProgress={status?.rewardInProgress ?? false}
                        intervalLabel={status ? formatInterval(status.rewardIntervalSeconds) : '--'}
                        lastAction={lastRewardFormatted}
                        disabled={!isOperational}
                    />
                </div>

                {/* Trust Notice */}
                <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-center text-sm text-gray-300">
                        ✅ All actions are <strong>on-chain</strong> and independently verifiable.
                    </p>
                </div>

                {/* Info Cards */}
                <div className="space-y-2 text-center">
                    <p className="text-xs text-gray-500">
                        🔁 Buys treasury SOL → token via Jupiter
                    </p>
                    <p className="text-xs text-gray-500">
                        🎁 Rewards distributed to eligible long-term holders
                    </p>
                </div>

                {/* Server Time Debug (subtle) */}
                {status && (
                    <div className="text-center">
                        <p className="text-[10px] text-gray-600 font-mono">
                            Server: {new Date(status.now * 1000).toISOString().slice(11, 19)} UTC
                            {' • '}
                            Heartbeat: {status.heartbeatAgeSeconds >= 0 ? `${status.heartbeatAgeSeconds}s` : 'N/A'}
                            {' • '}
                            <span className="opacity-60">#{status.checksum.slice(0, 8)}</span>
                        </p>
                    </div>
                )}

                {/* Disclaimer */}
                <div className="text-center pt-4 border-t border-white/5">
                    <p className="text-[10px] text-gray-600 leading-relaxed">
                        ⚠️ This bot operates autonomously. No guarantees are made.
                        <br />
                        Always verify transactions on-chain. Past performance ≠ future results.
                    </p>
                </div>
            </div>
        </main>
    );
}
