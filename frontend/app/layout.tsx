import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Pump.fun Rewards Bot',
    description: 'Automated rewards distribution for pump.fun token holders',
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body className="min-h-screen bg-gradient-radial">
                {children}
            </body>
        </html>
    );
}
