import { GUIDE_MARKDOWN } from './docsGuide.generated.js'

// The written guide shown above the endpoint reference at /docs. The text lives
// in docs/developers/guide.md. Blocks wrapped in <!-- listings --> … <!-- /listings -->
// only show while the listing platform is on, and <!-- tours-only --> blocks only
// while it is off. The markers are always removed, because a line that starts
// with an HTML comment would otherwise swallow the Markdown after it.
export function guideMarkdown(listings: boolean, source = GUIDE_MARKDOWN): string {
  const drop = listings ? 'tours-only' : 'listings'
  return source
    .replace(new RegExp(String.raw`<!-- ${drop} -->[\s\S]*?<!-- /${drop} -->\n?`, 'g'), '')
    .replace(/<!-- \/?(listings|tours-only) -->\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
