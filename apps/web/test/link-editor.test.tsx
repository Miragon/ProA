import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LinkEditor } from '../src/components/value-chain/link-editor';
import type { ProcessOption } from '../src/lib/value-chain';

const processes: ProcessOption[] = [
  {
    ref: 'finanzen/mahnwesen#Process_Mahnwesen',
    name: 'Mahnwesen',
    modelKey: 'finanzen/mahnwesen',
  },
  { ref: 'vertrieb/order#Process_Order', name: 'Auftragsabwicklung', modelKey: 'vertrieb/order' },
];

function setup(link: string | null) {
  const onChange = vi.fn();
  const view = render(<LinkEditor link={link} processes={processes} onChange={onChange} />);
  /** The canvas answers (300 ms later in the page) with a new link. */
  const canvasSays = (next: string | null) =>
    view.rerender(<LinkEditor link={next} processes={processes} onChange={onChange} />);
  return { onChange, canvasSays, user: userEvent.setup() };
}

const mode = (name: string) => screen.getByRole('radio', { name });

describe('LinkEditor', () => {
  it('starts in the mode of the current link', () => {
    setup('proa:process/vertrieb/order#Process_Order');
    expect(mode('ProA-Prozess').dataset['state']).toBe('on');
    const picked = screen
      .getAllByTestId('link-process-option')
      .find((o) => o.dataset['state'] === 'checked');
    expect(picked?.dataset['ref']).toBe('vertrieb/order#Process_Order');
    expect(screen.getByText(/schlägt ProA „Auftragsabwicklung“/)).toBeTruthy();
  });

  it('writes proa:process/<ref> from the picker with „Übernehmen“; the search narrows it', async () => {
    const { onChange, user } = setup(null);
    expect(mode('Kein Link').dataset['state']).toBe('on');
    await user.click(mode('ProA-Prozess'));
    await user.type(screen.getByLabelText('Prozess suchen'), 'mahn');
    const options = screen.getAllByTestId('link-process-option');
    expect(options.map((o) => o.dataset['ref'])).toEqual(['finanzen/mahnwesen#Process_Mahnwesen']);
    const apply = screen.getByTestId<HTMLButtonElement>('apply-process-link');
    expect(apply.disabled).toBe(true);
    // a click only marks the process
    await user.click(options[0]!);
    expect(onChange).not.toHaveBeenCalled();
    await user.click(apply);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      'proa:process/finanzen/mahnwesen#Process_Mahnwesen',
    );
  });

  it('lets the keyboard browse the processes without writing; Enter applies; focus stays', async () => {
    const { onChange, canvasSays, user } = setup(null);
    await user.click(mode('ProA-Prozess'));
    screen.getByLabelText('Prozess suchen').focus();
    await user.tab();
    const first = screen.getAllByTestId('link-process-option')[0]!;
    expect(document.activeElement).toBe(first);
    // Held down like a real key press: Radix moves the focus and "clicks" the radio while the
    // arrow key is down, which used to write a link per key press.
    await user.keyboard('{ArrowDown>}');
    const second = screen.getAllByTestId('link-process-option')[1]!;
    await waitFor(() => expect(second.dataset['state']).toBe('checked'));
    await user.keyboard('{/ArrowDown}');
    expect(document.activeElement).toBe(second);
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('proa:process/vertrieb/order#Process_Order');
    // the canvas echoes the link: no remount, the focus stays on the process
    canvasSays('proa:process/vertrieb/order#Process_Order');
    expect(document.activeElement).toBe(second);
    expect(screen.getByText(/schlägt ProA „Auftragsabwicklung“/)).toBeTruthy();
  });

  it('takes over a link change it did not make (an undo on the canvas)', async () => {
    const { canvasSays, user } = setup('proa:process/vertrieb/order#Process_Order');
    await user.click(mode('Anderer Link'));
    canvasSays(null);
    expect(mode('Kein Link').dataset['state']).toBe('on');
    canvasSays('https://wiki.example/x');
    expect(mode('Anderer Link').dataset['state']).toBe('on');
    expect(screen.getByLabelText<HTMLInputElement>('Link (URL oder Text)').value).toBe(
      'https://wiki.example/x',
    );
  });

  it('clears the link with null', async () => {
    const { onChange, user } = setup('https://wiki.example/vertrieb');
    expect(mode('Anderer Link').dataset['state']).toBe('on');
    await user.click(mode('Kein Link'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('takes other text after validation (control characters refused)', async () => {
    const { onChange, user } = setup(null);
    await user.click(mode('Anderer Link'));
    const field = screen.getByLabelText('Link (URL oder Text)');
    await user.click(screen.getByRole('button', { name: /Übernehmen/ }));
    expect(screen.getByText('Gib einen Link ein oder wähle „Kein Link“.')).toBeTruthy();
    await user.type(field, 'operations-detail');
    await user.click(screen.getByRole('button', { name: /Übernehmen/ }));
    expect(onChange).toHaveBeenCalledWith('operations-detail');
    await user.clear(field);
    await user.type(field, 'a\tb');
    await user.click(screen.getByRole('button', { name: /Übernehmen/ }));
    expect(screen.getByText(/Keine Steuer- oder Richtungszeichen/)).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('link-editor')).queryByRole('alert')).toBeTruthy();
  });
});
