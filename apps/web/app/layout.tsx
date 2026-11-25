import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { LANDING_TRIAL } from '@/lib/pricing';

export const metadata: Metadata = {
  title: 'Brayz — Every call answered. Every guest a regular.',
  description: `Brayz answers every restaurant call with real-time voice AI, takes pickup and delivery orders, and remembers your guests. Start with ${LANDING_TRIAL.days} days of ${LANDING_TRIAL.planName} free — no credit card.`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
