/** Thrown for a procedure file without valid frontmatter, or text a wrapper cannot carry. */
export class ProcedureFormatError extends Error {
  override readonly name = 'ProcedureFormatError';
}
