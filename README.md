Blink for Docs (Coder)

An agent specialized for answering questions about Coder using the official documentation at https://coder.com/docs.

Scope

- "Docs" means coder.com/docs exclusively. The agent does not search or cite non-coder documentation sites.
- Tools enforce this: Algolia hits are filtered to coder.com/docs; page tools reject non-docs URLs.

Capabilities

- Search: Uses Algolia DocSearch to retrieve relevant docs content.
- Coverage: Traverses the coder.com sitemap and filters to coder.com/docs pages.
- Structure: Extracts page outlines (title, headings, anchors, internal links).
- Precision: Returns exact section content (including code blocks) for citations.

Tools

- search_docs: Algolia search across Coder Docs.
  - Inputs: query, page?, hitsPerPage?, facetFilters?, filters?
  - Env: ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY, ALGOLIA_INDEX_NAME (default: docs)
- sitemap_list: Flatten sitemap (default https://coder.com/sitemap.xml), filtered to /docs.
  - Inputs: sitemapUrl?, include[]?, exclude[]?, limit?
- page_outline: Fetch title + h1–h3 headings, anchors, and internal links for a page.
  - Inputs: url (must be coder.com/docs/\*)
- page_section: Extract the content for a specific section by anchor or heading text.
  - Inputs: url (must be coder.com/docs/\*), anchorId?, headingText?, maxChars?

Usage guidance

- Use search_docs first for topical queries (features, how-tos). If results are weak or empty, fall back to sitemap_list to discover relevant pages, then page_outline and page_section for grounding.
- For TOC or navigation-style questions, use sitemap_list and page_outline.
- When giving authoritative answers, prefer quoting from page_section to ensure accuracy.

Environment

- ALGOLIA_APP_ID=HFB7GDLFQ5
- ALGOLIA_SEARCH_KEY=<your search-only key>
- ALGOLIA_INDEX_NAME=docs

Local development

- bun install
- blink dev

Deploy

- blink deploy (staging)
- blink deploy --prod (production)

Conventions

- Run Prettier before committing.
- Open PRs as drafts. Use branch names like blink/{feature}.
- Co-author commits with the initiating GitHub user.

Changelog

- Initial tools: search_docs, sitemap_list, page_outline, page_section
- Removed demo IP address tool
- Updated system prompt to define agent identity and tool usage
- Enforce coder.com/docs scope in tools and prompt
