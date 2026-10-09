// First: zod must not probe `new Function` under the CSP (M4 §5); see zod-csp.ts.
import './lib/zod-csp';

import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import { ApiError } from './lib/api';
import { createAppRouter } from './router';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // Problems (4xx) are answers, not glitches: do not retry them.
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2,
    },
  },
});
const router = createAppRouter({ queryClient });

const root = document.getElementById('root');
if (!root) throw new Error('#root missing in index.html');
createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} router={router} />
  </StrictMode>,
);
