import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  build: {
    // Browsers that support ES modules support <link rel=modulepreload>
    // natively; disabling the polyfill prevents Vite from hoisting the
    // __vitePreload helper into unrelated chunks (it would otherwise pull
    // the 208 kB @supabase/supabase-js chunk into the entry's preload set).
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite's injected dynamic-import preload helper must live in its own
          // tiny chunk. If it lands inside a heavy async chunk (e.g. the
          // @supabase/supabase-js chunk), the entry statically imports it from
          // there, which forces that whole chunk into the eager preload set.
          if (id.includes('\0vite/preload-helper')) return 'runtime';
          if (id.includes('node_modules')) {
            if (id.includes('@supabase')) return 'supabase';
            if (id.includes('react') || id.includes('react-dom')) return 'react-vendor';
            if (id.includes('lucide-react')) return 'icons';
            return 'vendor';
          }
        },
      },
    },
  },
});
