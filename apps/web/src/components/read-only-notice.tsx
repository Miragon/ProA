import { EyeIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PROA_REPOSITORY_URL } from '@/lib/server-mode';

/**
 * In place of a write panel (upload, connect an agent, rules) for a caller
 * who may not use it: no form that ends in a refusal, and no request. On the
 * read-only demo it says so and points to running ProA yourself.
 */
export function ReadOnlyNotice({
  demo,
  title,
  demoText,
  roleText,
}: {
  demo: boolean;
  title: string;
  /** What the demo does not offer here. */
  demoText: ReactNode;
  /** Which role it takes outside the demo. */
  roleText: ReactNode;
}) {
  return (
    <Alert data-testid="read-only-notice">
      <EyeIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {demo ? (
          <p>
            {demoText} Probier es mit einem eigenen ProA aus:{' '}
            <a
              href={PROA_REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="text-link underline"
            >
              ProA auf GitHub
            </a>
            .
          </p>
        ) : (
          <p>{roleText}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
