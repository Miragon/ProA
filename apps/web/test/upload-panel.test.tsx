import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UploadPanel } from '../src/components/upload-panel';
import { findToast, json, renderWithQuery, stubApi } from './support/render';

const IMPORT_PATH = '/api/v1/projects/demo/imports';

function withRelativePath(name: string, path: string, size = 20): File {
  const file = new File(['<bpmn/>'.padEnd(size, ' ')], name, { type: 'application/xml' });
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

// Requests go through Node's fetch (undici), which serializes only its own
// FormData, File and Blob; jsdom's versions would turn files into "{}".
const NodeFormData = (
  await new Response('x=1', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }).formData()
).constructor as typeof FormData;

beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('FormData', NodeFormData);
});

describe('UploadPanel', () => {
  it('imports a picked folder with paths below the folder and shows the outcome per file', async () => {
    const calls = stubApi({
      [`POST ${IMPORT_PATH}`]: (call) =>
        json({
          files: (call.body as string[]).map((path) =>
            path.endsWith('kaputt.bpmn')
              ? {
                  path,
                  modelKey: 'kaputt',
                  outcome: 'failed',
                  problem: {
                    type: 'urn:proa:problem:bpmn-invalid',
                    title: 'Invalid BPMN',
                    status: 422,
                    code: 'bpmn-invalid',
                    detail: 'DOCTYPE is not allowed',
                  },
                }
              : {
                  path,
                  modelKey: path.replace(/\.bpmn$/, ''),
                  outcome: path.startsWith('vertrieb') ? 'created' : 'unchanged',
                  problem: null,
                },
          ),
        }),
    });
    renderWithQuery(<UploadPanel project="demo" />);

    const input = screen.getByTestId('file-input');
    fireEvent.change(input, {
      target: {
        files: [
          withRelativePath('auftrag.bpmn', 'models/vertrieb/auftrag.bpmn'),
          withRelativePath('rechnung.bpmn', 'models/finanzen/rechnung.bpmn'),
          withRelativePath('kaputt.bpmn', 'models/kaputt.bpmn'),
          withRelativePath('README.md', 'models/README.md'),
        ],
      },
    });

    const table = await screen.findByRole('table', { name: 'Import je Datei' });
    await waitFor(() => expect(within(table).getAllByTestId('import-outcome')).toHaveLength(3));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual([
      'finanzen/rechnung.bpmn',
      'kaputt.bpmn',
      'vertrieb/auftrag.bpmn',
    ]);
    const outcomes = within(table).getAllByTestId('import-outcome');
    expect(outcomes.map((row) => row.dataset['outcome'])).toEqual([
      'unchanged',
      'failed',
      'created',
    ]);
    expect(within(outcomes[1]!).getByText('DOCTYPE is not allowed')).toBeTruthy();
    expect(within(outcomes[2]!).getByText('Neu')).toBeTruthy();
    expect(screen.getByText(/1 Dateien übersprungen/)).toBeTruthy();
    expect(await findToast('1 von 3 Dateien nicht importiert')).toBeTruthy();
  });

  it('says so when nothing is a BPMN file', async () => {
    const calls = stubApi({});
    renderWithQuery(<UploadPanel project="demo" />);
    fireEvent.change(screen.getByTestId('file-input'), {
      target: { files: [new File(['x'], 'notizen.txt')] },
    });
    expect(await findToast('Keine BPMN-Dateien gefunden')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('marks the drop zone while files are dragged over it', () => {
    stubApi({});
    renderWithQuery(<UploadPanel project="demo" />);
    const zone = screen.getByTestId('dropzone');
    fireEvent.dragOver(zone, { dataTransfer: { dropEffect: 'none' } });
    expect(screen.getByText('Dateien hier ablegen')).toBeTruthy();
    fireEvent.dragLeave(zone);
    expect(screen.getByText('BPMN-Dateien oder einen Ordner hierher ziehen')).toBeTruthy();
  });
});
