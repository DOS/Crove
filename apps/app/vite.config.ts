import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.CROVE_API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/auth': api },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Fonts always ship as files: the kernel's CSP (default-src 'self') would block a font inlined as a data: URI,
    // which Vite does by default for assets under 4 KB.
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
});
