Blink for Docs (Coder)

An agent specialized for answering questions about Coder using the official documentation at https://coder.com/docs.

Scope

- "Docs" means coder.com/docs exclusively. The agent does not search or cite non-coder documentation sites.
- Tools enforce this: Algolia hits are filtered to coder.com/docs; page tools reject non-docs URLs.
- GitHub org default: when a repository is referenced without an owner, the agent assumes the owner is the coder organization (e.g., vscode-coder → coder/vscode-coder).
- Default repository: when no repository is specified, the agent assumes coder/coder.

Citations

- Include links to the exact coder.com/docs page(s) used whenever possible.
- Prefer placing the link next to the relevant statement or quote.
- Use page_section to extract precise content to quote.

Capabilities

- Search: Uses Algolia DocSearch to retrieve relevant docs content.
- Coverage: Traverses the coder.com sitemap and filters to coder.com/docs pages.
- Structure: Extracts page outlines (title, headings, anchors, internal links).
- Precision: Returns exact section content (including code blocks) for citations.

Tools

- search_docs: Algolia search across Coder Docs.
  - Inputs: query, page?, hitsPerPage? (default 3, max 5), facetFilters?, filters?, mode? ('light'|'full', default 'light')
  - Returns: mode 'light' → url, title, snippet; mode 'full' → url, hierarchy, content, snippet
  - Env: ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY, ALGOLIA_INDEX_NAME (default: docs)
- sitemap_list: Flatten sitemap (default https://coder.com/sitemap.xml), filtered to /docs.
  - Inputs: sitemapUrl?, include[]?, exclude[]?, limit?
- page_outline: Fetch title + h1–h3 headings, anchors, and internal links for a page.
  - Inputs: url (must be coder.com/docs/\*)
- page_section: Extract the content for a specific section by anchor or heading text.
  - Inputs: url (must be coder.com/docs/\*), anchorId?, headingText?, maxChars?
- GitHub tools (curated subset, keys start with github\_): read-only operations via @blink-sdk/github.
  - Enabled examples: github_get_repository, github_repository_read_file, github_repository_list_directory, github_repository_grep_file, github_search_repositories, github_search_issues, github_get_pull_request, github_list_pull_request_files, github_get_issue.
  - Env: GITHUB_TOKEN (a token with appropriate repo scopes)

Usage guidance

- Start with search_docs using mode=light and hitsPerPage ≤ 3 to keep context small; drill in with page_outline and page_section for detail.
- If search results are weak or empty, use sitemap_list to enumerate pages, then page_outline and page_section.
- For TOC or navigation-style questions, use sitemap_list and page_outline.
- When giving authoritative answers, prefer quoting from page_section to ensure accuracy.

Environment

- ALGOLIA_APP_ID=HFB7GDLFQ5
- ALGOLIA_SEARCH_KEY=<your search-only key>
- ALGOLIA_INDEX_NAME=docs
- GITHUB_TOKEN=<token with repo permissions>

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
- Add citations guidance
- search_docs: add mode=light (default) and small hitsPerPage defaults to reduce context size
- Add GitHub tools (prefixed github\_) via @blink-sdk/github
- Default GitHub owner: assume coder org when owner is omitted
- GitHub tools: enable a curated read-only subset by default
- Default repository: assume coder/coder when repo is not specified
