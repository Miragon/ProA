import type { ApiProblem } from '@proa/contracts';

/** A failure with a message for the user and an exit code (default 1). */
export class CliError extends Error {
  override readonly name: string = 'CliError';
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** The server answered with an RFC 9457 problem (or another non-2xx status). */
export class ApiError extends CliError {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly problem: Partial<ApiProblem> | null;

  constructor(what: string, status: number, problem: Partial<ApiProblem> | null) {
    const title = problem?.title ?? `HTTP ${status}`;
    const detail = problem?.detail ? `: ${problem.detail}` : '';
    super(`${what} failed (${status} ${title})${detail}`);
    this.status = status;
    this.problem = problem;
  }
}
