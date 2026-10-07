import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { resetSessionState } from '../src/lib/api';

// jsdom lacks a few browser APIs that Radix primitives touch.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
const elementProto = Element.prototype as unknown as Record<string, unknown>;
const elementStubs: Record<string, () => unknown> = {
  hasPointerCapture: () => false,
  releasePointerCapture: () => undefined,
  scrollIntoView: () => undefined,
};
for (const [name, stub] of Object.entries(elementStubs)) {
  if (typeof elementProto[name] !== 'function') elementProto[name] = stub;
}
if (typeof window.matchMedia !== 'function')
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetSessionState();
});
