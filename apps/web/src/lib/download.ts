/**
 * Hands text to the browser as a file download (Blob plus `<a download>`,
 * which the CSP allows: `img-src … blob:` is not involved, the anchor only
 * navigates to the blob URL for the download).
 */
export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
