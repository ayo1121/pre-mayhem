'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BotStatus {
    now: number;
    botOnline: boolean;
    dryRun: boolean;

    lastBuyTs: number | null;
    lastRewardTs: number | null;

    nextBuyTs: number | null;
    nextRewardTs: number | null;

    buyIntervalSeconds: number;
    rewardIntervalSeconds: number;

    buyInProgress: boolean;
    rewardInProgress: boolean;

    lastBuyTx: string | null;
    lastRewardTxs: string[];
}

export interface UseBotStatusResult {
    status: BotStatus | null;
    isLoading: boolean;
    isOffline: boolean;
    error: string | null;

    // Countdown values (in seconds)
    timeToNextBuy: number;
    timeToNextReward: number;

    // Formatted countdown strings
    formattedTimeToNextBuy: string;
    formattedTimeToNextReward: string;

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

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_API_URL = process.env.NEXT_PUBLIC_STATUS_API_URL || '/api/status';
const REFETCH_INTERVAL = 30000; // 30 seconds
const TICK_INTERVAL = 1000; // 1 second

export function useBotStatus(): UseBotStatusResult {
    const [status, setStatus] = useState<BotStatus | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isOffline, setIsOffline] = useState(false);
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
            setIsOffline(!data.botOnline);
            setError(null);

            // Record fetch time and server time
            lastFetchRef.current = Date.now();
            serverTimeAtFetchRef.current = data.now;

            setIsLoading(false);
        } catch (err) {
            console.error('Failed to fetch bot status:', err);
            setError(err instanceof Error ? err.message : 'Failed to fetch status');
            setIsOffline(true);
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

    return {
        status,
        isLoading,
        isOffline,
        error,
        timeToNextBuy,
        timeToNextReward,
        formattedTimeToNextBuy: formatTime(timeToNextBuy),
        formattedTimeToNextReward: formatTime(timeToNextReward),
        refresh: fetchStatus,
    };
}
