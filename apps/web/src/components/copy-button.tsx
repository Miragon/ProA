import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState, type ComponentProps } from 'react';

import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';

/** Copies `value` to the clipboard and confirms with a toast. */
export function CopyButton({
  value,
  label = 'Kopieren',
  copiedMessage = 'In die Zwischenablage kopiert',
  ...props
}: { value: string; label?: string; copiedMessage?: string } & Omit<
  ComponentProps<typeof Button>,
  'onClick' | 'value'
>) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ tone: 'success', title: copiedMessage });
    } catch {
      toast({
        tone: 'danger',
        title: 'Kopieren hat nicht geklappt',
        description:
          'Der Browser erlaubt keinen Zugriff auf die Zwischenablage. Markiere den Text und kopiere ihn von Hand.',
      });
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void copy()} {...props}>
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      {copied ? 'Kopiert' : label}
    </Button>
  );
}

/** A preformatted snippet in Geist Mono with a copy button. */
export function CodeBlock({
  code,
  label,
  copyLabel,
}: {
  code: string;
  /** Accessible name of the snippet, e.g. "Befehl für Claude Code". */
  label: string;
  copyLabel?: string;
}) {
  return (
    <figure className="overflow-hidden rounded-lg border bg-card" aria-label={label}>
      <figcaption className="flex items-center justify-between gap-2 border-b bg-muted px-3 py-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <CopyButton value={code} label={copyLabel ?? 'Kopieren'} />
      </figcaption>
      <pre
        className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap"
        data-testid="code-block"
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}
