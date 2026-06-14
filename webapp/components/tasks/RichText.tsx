import { sanitizeRichText } from '@/lib/richtext/sanitize'
import { cn } from '@/lib/utils'

// Renders a task description. Sanitizes again at render (defense-in-depth; the
// value is already sanitized on save). Legacy descriptions are plain text with
// no tags — rendered with whitespace-pre-wrap so line breaks survive.
const HTML_RE = /<\/?(p|br|strong|b|em|i|u|s|mark|span|ul|ol|li|h[123])\b/i

export function RichText({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return null
  if (!HTML_RE.test(value)) {
    return <p className={cn('text-sm whitespace-pre-wrap leading-relaxed', className)}>{value}</p>
  }
  const clean = sanitizeRichText(value)
  return (
    <div
      className={cn(
        'text-sm leading-relaxed',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-medium',
        '[&_mark]:bg-yellow-200 [&_mark]:rounded-sm [&_mark]:px-0.5',
        className,
      )}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  )
}
