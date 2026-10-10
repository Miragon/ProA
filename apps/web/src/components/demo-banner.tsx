import { EyeIcon, ExternalLinkIcon } from 'lucide-react';
import { useEffect } from 'react';

import { PROA_REPOSITORY_URL, useServerMode } from '@/lib/server-mode';

/**
 * The read-only demo's banner (issue #3), above every page while `/health`
 * reports `demo: "readonly"`: what the visitor can do (look, not change),
 * where the proposals come from, the repository, and the operator's
 * „Impressum“ and „Datenschutz“ when `/health` reports them. It marks the
 * document (`<html data-proa-demo="readonly">`), so the full-height layouts
 * make room for it (`--proa-banner-h` in index.css). Nothing outside the demo.
 *
 * One line of fixed height at every width (`h-10`, the 2.5rem of
 * `--proa-banner-h`): the legal links never shrink and stay visible down to
 * 320 px (smaller text below 360 px), the repository link from 480 px, the
 * two sentences from `lg` and `xl`, where each fits whole.
 */
export function DemoBanner() {
  const { demo, imprintUrl, privacyUrl } = useServerMode();

  useEffect(() => {
    if (!demo) return;
    const root = document.documentElement;
    root.dataset['proaDemo'] = 'readonly';
    return () => {
      delete root.dataset['proaDemo'];
    };
  }, [demo]);

  if (!demo) return null;
  const legal = [
    { label: 'Impressum', href: imprintUrl },
    { label: 'Datenschutz', href: privacyUrl },
  ].filter((l): l is { label: string; href: string } => l.href !== null);
  return (
    <div
      role="region"
      aria-label="Demo-Hinweis"
      data-testid="demo-banner"
      className="flex h-10 w-full items-center gap-2 overflow-hidden border-b border-info/30 bg-info-soft px-3 text-xs text-foreground min-[360px]:text-sm sm:gap-3 sm:px-4"
    >
      <EyeIcon className="size-4 shrink-0 text-info" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-semibold">Demo – nur lesen.</span>
        {/* Whole sentences only: each shows from the width it fits in next to the links. */}
        <span className="hidden lg:inline"> Du kannst dir alles ansehen, aber nichts ändern.</span>
        <span className="hidden xl:inline">
          {' '}
          Die Vorschläge stammen vom Simulationsagenten (ohne LLM).
        </span>
      </p>
      <a
        href={PROA_REPOSITORY_URL}
        target="_blank"
        rel="noreferrer"
        className="hidden shrink-0 items-center gap-1 font-medium whitespace-nowrap text-link hover:underline min-[480px]:inline-flex"
      >
        ProA auf GitHub
        <ExternalLinkIcon className="size-3.5" aria-hidden />
      </a>
      {legal.length > 0 ? (
        <nav
          aria-label="Rechtliches"
          data-testid="demo-legal"
          className="flex shrink-0 items-center gap-2 sm:gap-3"
        >
          {legal.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="font-medium whitespace-nowrap text-link hover:underline"
            >
              {l.label}
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
