import DOMPurify from 'dompurify'
import { marked } from 'marked'

// Links leave the app for the browser.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/**
 * Claude's text, written in Markdown, as HTML: headings, lists, code, tables, links. Cleaned by DOMPurify (no script,
 * no event attribute) before it is drawn. A line break in the text stays one, as in a chat.
 */
export function md(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }))
}
