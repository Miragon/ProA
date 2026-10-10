import { useState } from 'react';

import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export interface CommitFieldProps {
  id: string;
  label: string;
  /** The value on the canvas. */
  value: string;
  maxLength: number;
  /** Applies the edited value (one undoable command on the canvas). */
  onCommit: (value: string) => void;
  /** An empty value is not applied (the chain's name). */
  required?: boolean;
  testId?: string;
}

/**
 * A text field that edits a name on the canvas in edit mode: applied on Enter
 * or when leaving the field, Escape restores the canvas value. It stays
 * mounted (and focused) when the value changes on the canvas, and takes over
 * a change that did not come from it, such as an undo.
 */
export function CommitField({
  id,
  label,
  value,
  maxLength,
  onCommit,
  required = false,
  testId,
}: CommitFieldProps) {
  const [draft, setDraft] = useState(value);
  // The canvas value of the last render, and the value this field applied and still waits for:
  // the canvas reports a change late, and its own echo must not reset what the user types.
  const [prev, setPrev] = useState(value);
  const [applied, setApplied] = useState<string | null>(null);
  if (value !== prev) {
    setPrev(value);
    if (value !== applied) setDraft(value);
    setApplied(null);
  }

  function commit() {
    const next = draft.replace(/\r\n?/g, '\n').trim();
    // Applied already (Enter, then leaving the field before the canvas answered): one command.
    if (next === applied) return;
    if ((required && next === '') || next === value) {
      setDraft(value);
      return;
    }
    setApplied(next);
    setDraft(next);
    onCommit(next);
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={draft}
        maxLength={maxLength}
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            // Only the field: the panel's Escape (back to the overview) must not fire.
            e.preventDefault();
            e.stopPropagation();
            setDraft(value);
          }
        }}
      />
    </Field>
  );
}
