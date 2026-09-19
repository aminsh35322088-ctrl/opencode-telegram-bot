/**
 * Build a Telegram Rich HTML payload from plain source text without allowing
 * the source to inject markup. Used as a resilience layer when native rich
 * blocks are rejected by Telegram.
 */
export function buildSourcePreservingRichHtml(
  text: string,
  options: { preformatted?: boolean } = {},
): string {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

  return options.preformatted ? `<pre>${escaped}</pre>` : `<p>${escaped}</p>`;
}
