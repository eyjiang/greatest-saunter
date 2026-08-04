import './globals.css';
import { Barlow_Condensed, Inter } from 'next/font/google';

const barlow = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800', '900'],
  style: ['normal', 'italic'],
  variable: '--font-display',
});
const inter = Inter({ subsets: ['latin'], variable: '--font-body' });

export const metadata = {
  title: 'The Greatest Saunter — 24 Hour Walk',
  description: 'Live tracker for a 24-hour charity walk. Follow along, cheer us on, and donate!',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${barlow.variable} ${inter.variable}`}>{children}</body>
    </html>
  );
}
