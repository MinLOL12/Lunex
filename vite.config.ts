import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { lunexApiPlugin } from './electron/core/apiPlugin.js';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), lunexApiPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
});
