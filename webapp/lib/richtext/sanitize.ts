import 'server-only'
import sanitizeHtml from 'sanitize-html'

// Allowlist for the task-description rich text (Tiptap output). Tight on
// purpose — the primary XSS defense is HERE, at write time. Only the formatting
// the toolbar can produce: bold/italic/underline/strike, highlight (<mark>),
// font-size + color (<span style>), text-align (on block elems), lists.
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'mark', 'span', 'ul', 'ol', 'li', 'h1', 'h2', 'h3'],
  allowedAttributes: {
    '*': ['style'],
  },
  allowedStyles: {
    '*': {
      'text-align':       [/^(left|right|center|justify)$/],
      // Only the sizes the toolbar produces (13/18/24px) — blocks a hand-crafted
      // 999px payload that would blow up the layout for staff.
      'font-size':        [/^(13|18|24)px$/],
      'color':            [/^#(0x)?[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/],
      'background-color': [/^#(0x)?[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/],
    },
  },
  // Drop everything else (script, on* handlers, href, img, iframe...) entirely.
  disallowedTagsMode: 'discard',
}

// Sanitize Tiptap HTML before persisting. Empty/whitespace-only → ''.
export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return ''
  const clean = sanitizeHtml(html, OPTIONS).trim()
  // Tiptap emits "<p></p>" for an empty doc — treat as empty.
  if (clean === '<p></p>' || clean === '<p><br /></p>' || clean === '<p><br></p>') return ''
  return clean
}

// Strip all tags → plain text (Excel export, notifications, previews).
export function richTextToPlain(html: string | null | undefined): string {
  if (!html) return ''
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim()
}
