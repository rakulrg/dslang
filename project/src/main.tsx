import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { AuthProvider } from '@/lib/auth.tsx';
import { D2cCartProvider } from '@/lib/d2cCart.tsx';
import { SiteSettingsProvider } from '@/lib/settings.tsx';
import { CartDrawerProvider } from '@/lib/cartDrawer.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SiteSettingsProvider>
      <AuthProvider>
        <D2cCartProvider>
          <CartDrawerProvider>
            <App />
          </CartDrawerProvider>
        </D2cCartProvider>
      </AuthProvider>
    </SiteSettingsProvider>
  </StrictMode>
);