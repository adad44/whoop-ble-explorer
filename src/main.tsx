import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import { ConvexReactClient } from 'convex/react';
import App from './App';
import './styles.css';

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {convex ? (
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    ) : (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Configuration</p>
          <h1>Convex is not configured</h1>
          <p>
            Set <code>VITE_CONVEX_URL</code> before launching the signed-in public app. Local packet data is not changed.
          </p>
        </section>
      </main>
    )}
  </React.StrictMode>,
);
