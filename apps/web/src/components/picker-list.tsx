import { cn } from 'cn';
import { SearchIcon } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useId, type ReactNode } from 'react';

import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { nameWords } from '@/lib/generic-names';

/** How many options the list shows at once; the search narrows the rest. */
const SHOWN = 60;

export interface PickerListProps<T> {
  items: readonly T[];
  /** The value of an item (unique). */
  valueOf: (item: T) => string;
  /** Text the search matches (lowercased words, umlauts folded like the names). */
  searchText: (item: T) => string;
  render: (item: T) => ReactNode;
  value: string | null;
  onChange: (value: string) => void;
  search: string;
  onSearch: (search: string) => void;
  searchLabel: string;
  placeholder: string;
  /** Accessible name of the list. */
  label: string;
  /** Shown when there is nothing to pick at all. */
  emptyText: string;
  testId?: string;
  /** Data attribute that carries an option's value (`data-<name>`). */
  valueAttribute?: string;
  /** Focus the search field on mount (a form that replaced the button that opened it). */
  autoFocus?: boolean;
  className?: string;
}

/**
 * A search field and one radio group (a single tab stop; the arrow keys move
 * the choice, Radix roving focus): the correction candidates of the review
 * screen, and the step and process pickers of the value chain page.
 */
export function PickerList<T>({
  items,
  valueOf,
  searchText,
  render,
  value,
  onChange,
  search,
  onSearch,
  searchLabel,
  placeholder,
  label,
  emptyText,
  testId = 'picker-option',
  valueAttribute = 'value',
  autoFocus = false,
  className,
}: PickerListProps<T>) {
  const id = useId();
  const words = nameWords(search);
  const visible =
    words.length === 0
      ? items
      : items.filter((item) => {
          const hay = nameWords(searchText(item)).join(' ');
          return words.every((w) => hay.includes(w));
        });
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Field>
        <FieldLabel htmlFor={`${id}-search`}>{searchLabel}</FieldLabel>
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            id={`${id}-search`}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={placeholder}
            className="pl-8"
            autoComplete="off"
            autoFocus={autoFocus}
          />
        </div>
      </Field>
      {visible.length === 0 ? (
        <p className="rounded-lg border p-3 text-sm text-muted-foreground">
          {items.length === 0 ? emptyText : 'Nichts passt zur Suche.'}
        </p>
      ) : (
        <RadioGroup.Root
          value={value ?? ''}
          onValueChange={onChange}
          aria-label={label}
          className="max-h-64 overflow-y-auto rounded-lg border"
        >
          {visible.slice(0, SHOWN).map((item) => {
            const v = valueOf(item);
            const checked = value === v;
            return (
              <RadioGroup.Item
                key={v}
                value={v}
                data-testid={testId}
                {...{ [`data-${valueAttribute}`]: v }}
                className={cn(
                  'flex w-full items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                  checked ? 'bg-accent' : 'hover:bg-muted',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-3.5 shrink-0 rounded-full border',
                    checked ? 'border-4 border-primary' : 'border-contour',
                  )}
                />
                {render(item)}
              </RadioGroup.Item>
            );
          })}
        </RadioGroup.Root>
      )}
      {visible.length > SHOWN ? (
        <p className="text-xs text-muted-foreground">
          {SHOWN} von {visible.length} gezeigt; die Suche grenzt weiter ein.
        </p>
      ) : null}
    </div>
  );
}
