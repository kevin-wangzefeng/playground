import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'KubeCon Schedule Explorer',
  description: 'Explore KubeCon schedules, co-located events, speakers, rooms, and tracks.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
