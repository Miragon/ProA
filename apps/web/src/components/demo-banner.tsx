import { EyeIcon, ExternalLinkIcon } from 'lucide-react';
import { useEffect } from 'react';

import { PROA_REPOSITORY_URL, useServerMode } from '@/lib/server-mode';

/**
 * The read-only demo's banner (issue #3), above every page while `/health`
 * reports `demo: "readonly"`: what the visitor can do (look, not change),
 * where the proposals come from, and the repository. It marks the document
 * (`<html data-proa-demo="readonly">`), so the full-height layouts make room
 * for it (`--proa-banner-h` in index.css). Nothing outside the demo.
 */
export function DemoBanner() {
  const { demo } = useServerMode();

  useEffect(() => {
    if (!demo) return;
    const root = document.documentElement;
    root.dataset['proaDemo'] = 'readonly';
    return () => {
      delete root.dataset['proaDemo'];
    };
  }, [demo]);

  if (!demo) return null;
  return (
    <div
      role="region"
      aria-label="Demo-Hinweis"
      data-testid="demo-banner"
      className="flex h-10 w-full items-center gap-3 overflow-hidden border-b border-info/30 bg-info-soft px-4 text-sm text-foreground"
    >
      <EyeIcon className="size-4 shrink-0 text-info" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-semibold">Demo – nur lesen.</span>
        <span className="hidden md:inline">
          {' '}
          Du kannst dir alles ansehen, aber nichts ändern. Die Vorschläge stammen vom
          Simulationsagenten (ohne LLM).
        </span>
      </p>
      <a
        href={PROA_REPOSITORY_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex shrink-0 items-center gap-1 font-medium text-link hover:underline"
      >
        ProA auf GitHub
        <ExternalLinkIcon className="size-3.5" aria-hidden />
      </a>
    </div>
  );
}
