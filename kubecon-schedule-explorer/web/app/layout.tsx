import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'KubeCon China 2026 Schedule Explorer',
  description: 'Search and filter KubeCon China 2026 sessions and community events.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
