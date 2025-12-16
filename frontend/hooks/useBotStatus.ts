'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BotStatus {
    // Meta
    now: number;
    sourceOfTruth: 'server';
    checksum: string;

    // Bot state
    botOnline: boolean;
    heartbeatAgeSeconds: number;
    safeMode: boolean;
    safeModeReason: string | null;
    dryRun: boolean;

    // Timestamps
    lastBuyTs: number | null;
    lastRewardTs: number | null;
    nextBuyTs: number | null;
    nextRewardTs: number | null;

    // Intervals
    buyIntervalSeconds: number;
    rewardIntervalSeconds: number;

    // In-progress flags
    buyInProgress: boolean;
    rewardInProgress: boolean;

    // Transaction references
    lastBuyTx: string | null;
    lastRewardTxs: string[];
}

export type SystemState = 'online' | 'offline' | 'paused' | 'safe-mode';

export interface UseBotStatusResult {
    status: BotStatus | null;
    isLoading: boolean;
    systemState: SystemState;
    error: string | null;

    // Countdown values (in seconds)
    timeToNextBuy: number;
    timeToNextReward: number;

    // Formatted countdown strings
    formattedTimeToNextBuy: string;
    formattedTimeToNextReward: string;

    // Last action timestamps (formatted)
    lastBuyFormatted: string;
    lastRewardFormatted: string;

    // Refresh function
    refresh: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
    if (seconds <= 0) return '00:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatTimestamp(ts: number | null): string {
    if (!ts) return 'Never';

    const date = new Date(ts * 1000);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    // Less than 1 minute ago
    if (diff < 60000) return 'Just now';

    // Less than 1 hour ago
    if (diff < 3600000) {
        const mins = Math.floor(diff / 60000);
        return `${mins}m ago`;
    }

    // Less than 24 hours ago
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours}h ago`;
    }

    // More than 24 hours ago
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_API_URL = process.env.NEXT_PUBLIC_STATUS_API_URL || '/api/status';
const REFETCH_INTERVAL = 30000; // 30 seconds
const TICK_INTERVAL = 1000; // 1 second

export function useBotStatus(): UseBotStatusResult {
    const [status, setStatus] = useState<BotStatus | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Track when we last fetched and the server time at that moment
    const lastFetchRef = useRef<number>(0);
    const serverTimeAtFetchRef = useRef<number>(0);

    // Countdown state (updated every second)
    const [timeToNextBuy, setTimeToNextBuy] = useState(0);
    const [timeToNextReward, setTimeToNextReward] = useState(0);

    // Fetch status from API
    const fetchStatus = useCallback(async () => {
        try {
            const response = await fetch(STATUS_API_URL, {
                cache: 'no-store',
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data: BotStatus = await response.json();

            setStatus(data);
            setError(null);

            // Record fetch time and server time
            lastFetchRef.current = Date.now();
            serverTimeAtFetchRef.current = data.now;

            setIsLoading(false);
        } catch (err) {
            console.error('Failed to fetch bot status:', err);
            setError(err instanceof Error ? err.message : 'Failed to fetch status');
            setIsLoading(false);
        }
    }, []);

    // Calculate countdowns based on server time (not local clock)
    const updateCountdowns = useCallback(() => {
        if (!status) return;

        // Calculate elapsed time since last fetch
        const elapsedSinceFetch = (Date.now() - lastFetchRef.current) / 1000;

        // Estimate current server time
        const estimatedServerNow = serverTimeAtFetchRef.current + elapsedSinceFetch;

        // Calculate countdowns
        const buyCountdown = status.nextBuyTs
            ? Math.max(0, status.nextBuyTs - estimatedServerNow)
            : 0;

        const rewardCountdown = status.nextRewardTs
            ? Math.max(0, status.nextRewardTs - estimatedServerNow)
            : 0;

        setTimeToNextBuy(buyCountdown);
        setTimeToNextReward(rewardCountdown);
    }, [status]);

    // Initial fetch
    useEffect(() => {
        fetchStatus();
    }, [fetchStatus]);

    // Refetch periodically
    useEffect(() => {
        const interval = setInterval(fetchStatus, REFETCH_INTERVAL);
        return () => clearInterval(interval);
    }, [fetchStatus]);

    // Tick every second to update countdowns
    useEffect(() => {
        const interval = setInterval(updateCountdowns, TICK_INTERVAL);
        return () => clearInterval(interval);
    }, [updateCountdowns]);

    // Update countdowns immediately when status changes
    useEffect(() => {
        updateCountdowns();
    }, [status, updateCountdowns]);

    // Handle visibility change (tab sleep recovery)
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                // Refetch when tab becomes visible
                fetchStatus();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [fetchStatus]);

    // Handle network reconnect
    useEffect(() => {
        const handleOnline = () => {
            fetchStatus();
        };

        window.addEventListener('online', handleOnline);
        return () => window.removeEventListener('online', handleOnline);
    }, [fetchStatus]);

    // Determine system state
    let systemState: SystemState = 'offline';
    if (status) {
        if (status.safeMode) {
            systemState = 'safe-mode';
        } else if (!status.botOnline) {
            systemState = 'offline';
        } else if (status.buyInProgress || status.rewardInProgress) {
            systemState = 'online';
        } else {
            systemState = 'online';
        }
    } else if (error) {
        systemState = 'offline';
    }

    return {
        status,
        isLoading,
        systemState,
        error,
        timeToNextBuy,
        timeToNextReward,
        formattedTimeToNextBuy: systemState === 'offline' ? '--:--' : formatTime(timeToNextBuy),
        formattedTimeToNextReward: systemState === 'offline' ? '--:--' : formatTime(timeToNextReward),
        lastBuyFormatted: formatTimestamp(status?.lastBuyTs ?? null),
        lastRewardFormatted: formatTimestamp(status?.lastRewardTs ?? null),
        refresh: fetchStatus,
    };
}
