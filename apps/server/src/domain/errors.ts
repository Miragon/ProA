import type { ProblemCode } from '@proa/contracts';

/**
 * Error raised by domain use cases. The HTTP layer maps `code` to an RFC 9457
 * problem (status from `PROBLEMS[code]`), the MCP layer to a tool error.
 * The domain never imports HTTP, MCP, DB or auth code (dependency-cruiser).
 */
export class DomainError extends Error {
  override readonly name = 'DomainError';
  readonly code: ProblemCode;
  /** Extension members for the problem body, e.g. `{ reviewUrl }`. */
  readonly extras: Readonly<Record<string, unknown>>;

  constructor(code: ProblemCode, message: string, extras: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extras = extras;
  }
}
