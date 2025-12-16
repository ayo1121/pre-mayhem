'use client';

interface CountdownTimerProps {
    label: string;
    emoji: string;
    formattedTime: string;
    inProgress: boolean;
    intervalLabel: string;
}

export function CountdownTimer({
    label,
    emoji,
    formattedTime,
    inProgress,
    intervalLabel,
}: CountdownTimerProps) {
    return (
        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 flex flex-col items-center gap-4">
            <div className="text-4xl">{emoji}</div>

            <div className="text-center">
                <h2 className="text-lg font-medium text-gray-300 mb-1">{label}</h2>
                <p className="text-xs text-gray-500">{intervalLabel}</p>
            </div>

            {inProgress ? (
                <div className="flex items-center gap-2 text-primary-400">
                    <div className="w-3 h-3 bg-primary-400 rounded-full animate-pulse" />
                    <span className="text-xl font-bold">In Progress</span>
                </div>
            ) : (
                <div className="text-4xl font-mono font-bold text-white tabular-nums">
                    {formattedTime}
                </div>
            )}
        </div>
    );
}
