import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ABC Auctions',
    short_name: 'ABC Auctions',
    description: 'Timed online auctions in Harare and Bulawayo. The price you see is the price you pay.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0927',
    theme_color: '#0a0927',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
