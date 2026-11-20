import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/styles/globals.css';
import { DirectionProvider } from '@/components/foundations/direction/direction';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PublicHomePage } from './components/PublicHomePage';
import { parseRoute } from './router';

const Workspace = React.lazy(() => import('./App'));
const isHome = parseRoute(window.location.pathname, window.location.search).type === 'home';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isHome ? (
        <DirectionProvider locale="en-US">
          <PublicHomePage onOpenWorkspace={() => window.location.assign('/projects')} />
        </DirectionProvider>
      ) : (
        <React.Suspense fallback={<p role="status" className="p-6 text-body-regular text-text-secondary">Loading workspace…</p>}>
          <Workspace />
        </React.Suspense>
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
