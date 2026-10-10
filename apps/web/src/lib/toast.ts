/**
 * Toast store (modeler-tool-design §9): feedback is never silent. Rendered by
 * `components/toaster.tsx`; call {@link toast} from anywhere.
 */
export type ToastTone = 'success' | 'info' | 'warning' | 'danger';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function toast(input: Omit<ToastItem, 'id'>): void {
  items = [...items, { ...input, id: nextId++ }].slice(-4);
  emit();
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getToasts = (): readonly ToastItem[] => items;
