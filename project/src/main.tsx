import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { AuthProvider } from '@/lib/auth.tsx';
import { CartProvider } from '@/lib/cart.tsx';
import { SiteSettingsProvider } from '@/lib/settings.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SiteSettingsProvider>
      <AuthProvider>
        <CartProvider>
          <App />
        </CartProvider>
      </AuthProvider>
    </SiteSettingsProvider>
  </StrictMode>
);
