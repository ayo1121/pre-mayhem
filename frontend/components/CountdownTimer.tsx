'use client';

interface CountdownTimerProps {
    label: string;
    emoji: string;
    formattedTime: string;
    inProgress: boolean;
    intervalLabel: string;
    lastAction?: string;
    disabled?: boolean;
}

export function CountdownTimer({
    label,
    emoji,
    formattedTime,
    inProgress,
    intervalLabel,
    lastAction,
    disabled = false,
}: CountdownTimerProps) {
    return (
        <div className={`bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-5 flex flex-col items-center gap-3 ${disabled ? 'opacity-50' : ''}`}>
            <div className="text-3xl">{emoji}</div>

            <div className="text-center">
                <h2 className="text-base font-medium text-gray-300">{label}</h2>
                <p className="text-xs text-gray-500">{intervalLabel}</p>
            </div>

            {inProgress ? (
                <div className="flex items-center gap-2 text-primary-400">
                    <div className="w-2.5 h-2.5 bg-primary-400 rounded-full animate-pulse" />
                    <span className="text-lg font-bold">In Progress</span>
                </div>
            ) : disabled ? (
                <div className="text-2xl font-mono font-bold text-gray-500 tabular-nums">
                    {formattedTime}
                </div>
            ) : (
                <div className="text-3xl font-mono font-bold text-white tabular-nums">
                    {formattedTime}
                </div>
            )}

            {lastAction && (
                <p className="text-[10px] text-gray-600">
                    Last: {lastAction}
                </p>
            )}
        </div>
    );
}
