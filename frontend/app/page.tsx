'use client';

import { useBotStatus } from '@/hooks/useBotStatus';
import { CountdownTimer } from '@/components/CountdownTimer';

export default function HomePage() {
    const {
        status,
        isLoading,
        isOffline,
        formattedTimeToNextBuy,
        formattedTimeToNextReward,
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

    return (
        <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-8">
            <div className="w-full max-w-lg space-y-8">
                {/* Header */}
                <div className="text-center space-y-2">
                    <h1 className="text-3xl sm:text-4xl font-bold text-white">
                        Pump.fun Rewards Bot
                    </h1>
                    <p className="text-gray-400">
                        Automated token buybacks & holder rewards
                    </p>
                </div>

                {/* Status Indicator */}
                <div className="flex justify-center">
                    {isLoading ? (
                        <div className="flex items-center gap-2 text-gray-400">
                            <div className="w-3 h-3 bg-gray-500 rounded-full animate-pulse" />
                            <span>Connecting...</span>
                        </div>
                    ) : isOffline ? (
                        <div className="flex items-center gap-2 text-red-400">
                            <div className="w-3 h-3 bg-red-500 rounded-full" />
                            <span>Bot Offline</span>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 text-primary-400">
                            <div className="w-3 h-3 bg-primary-500 rounded-full status-dot" />
                            <span>
                                Bot Online
                                {status?.dryRun && (
                                    <span className="ml-2 text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded">
                                        DRY RUN
                                    </span>
                                )}
                            </span>
                        </div>
                    )}
                </div>

                {/* Countdown Timers */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <CountdownTimer
                        label="Next Buy"
                        emoji="⏱️"
                        formattedTime={isLoading ? '--:--' : formattedTimeToNextBuy}
                        inProgress={status?.buyInProgress ?? false}
                        intervalLabel={status ? formatInterval(status.buyIntervalSeconds) : 'Every hour'}
                    />
                    <CountdownTimer
                        label="Next Reward"
                        emoji="🎁"
                        formattedTime={isLoading ? '--:--' : formattedTimeToNextReward}
                        inProgress={status?.rewardInProgress ?? false}
                        intervalLabel={status ? formatInterval(status.rewardIntervalSeconds) : 'Every 2 hours'}
                    />
                </div>

                {/* Info Cards */}
                <div className="space-y-3">
                    <div className="bg-white/5 rounded-xl p-4 text-center">
                        <p className="text-sm text-gray-300">
                            🔁 <strong>Buys</strong> are executed automatically every hour.
                        </p>
                    </div>
                    <div className="bg-white/5 rounded-xl p-4 text-center">
                        <p className="text-sm text-gray-300">
                            🎁 <strong>Rewards</strong> are distributed every 2 hours to eligible wallets.
                        </p>
                    </div>
                    <div className="bg-white/5 rounded-xl p-4 text-center">
                        <p className="text-sm text-gray-300">
                            ✅ All actions are <strong>on-chain</strong> and verifiable.
                        </p>
                    </div>
                </div>

                {/* Disclaimer */}
                <div className="text-center">
                    <p className="text-xs text-gray-500 leading-relaxed">
                        ⚠️ This bot operates autonomously. No guarantees are made.
                        <br />
                        Always verify transactions on-chain.
                    </p>
                </div>
            </div>
        </main>
    );
}
