import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Connectome Lab',
  description:
    'An explorable digital zebrafish nervous system. Whole-brain connectome viewer built on the Fish1 resource.',
};

export const viewport: Viewport = {
  themeColor: '#07080a',
  width: 'device-width',
  initialScale: 1,
  // The viewport is a 3D canvas; browser zoom fights the camera controls.
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
