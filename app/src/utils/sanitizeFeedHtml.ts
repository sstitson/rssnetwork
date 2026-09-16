import DOMPurify from 'dompurify';
import { normalizeFeedHtml } from './normalizeFeedHtml';

/**
 * Feed content is untrusted third-party HTML, so it must be sanitized before
 * it goes anywhere near dangerouslySetInnerHTML. DOMPurify strips scripts,
 * event handlers, javascript: URLs, iframes, etc.
 *
 * We also rewrite anchors so they open in a new tab without leaking the
 * referrer or exposing window.opener.
 */

// Registered once: force safe link behaviour on every sanitize() call.
let hookInstalled = false;
function installHook() {
  if (hookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A' && node instanceof Element) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    // Don't let feed images hijack layout or leak referrers.
    if (node.nodeName === 'IMG' && node instanceof Element) {
      node.setAttribute('loading', 'lazy');
      node.setAttribute('referrerpolicy', 'no-referrer');

      // Upgrade http:// images to https://.
      //
      // The app is served over HTTPS, so an http:// image is mixed content: the
      // browser upgrades it anyway and logs a console warning for each one, and
      // if the upgrade fails it blocks the image rather than falling back. Doing
      // the rewrite here makes that explicit and quiet, and costs nothing — a
      // host that can't serve the image over HTTPS was already failing.
      //
      // Only `src`. `href` on a link is a navigation, not a subresource: it is
      // not mixed content, and rewriting it would break links to sites that
      // genuinely have no HTTPS.
      const src = node.getAttribute('src');
      if (src && src.slice(0, 7).toLowerCase() === 'http://') {
        node.setAttribute('src', `https://${src.slice(7)}`);
      }
    }
  });
  hookInstalled = true;
}

/**
 * Normalize then sanitize feed HTML into something safe to render.
 *
 * Normalization runs FIRST because it targets markup the sanitizer would strip
 * (e.g. the `class` attribute identifying Slashdot's share widget).
 */
export function sanitizeFeedHtml(html: string): string {
  installHook();
  return DOMPurify.sanitize(normalizeFeedHtml(html), {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'div', 'span',
      'a', 'img', 'figure', 'figcaption',
      'strong', 'b', 'em', 'i', 'u', 's', 'sup', 'sub', 'small', 'mark',
      'blockquote', 'q', 'cite',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'pre', 'code', 'kbd', 'samp',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan'],
    // Block anything that isn't a normal web/image link.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/)/i,
  });
}
