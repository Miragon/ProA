import { useEffect, useRef } from 'react';

/**
 * Single-key shortcuts of the review screen (A, R, H, C, J/K, arrows). A key
 * is ignored while the user types (input, textarea, select, contenteditable),
 * while a dialog is open, and with a modifier held, so it never fights the
 * browser or a form.
 */

/** True if a key event should not trigger a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/** Normalized key: letters lowercase (`A` and `a` alike), other keys as `KeyboardEvent.key`. */
export function shortcutKey(event: Pick<KeyboardEvent, 'key'>): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

export function useShortcuts(handlers: Readonly<Record<string, () => void>>, enabled = true): void {
  const current = useRef(handlers);
  useEffect(() => {
    current.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || dialogOpen()) return;
      const handler = current.current[shortcutKey(event)];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
