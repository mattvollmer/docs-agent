import {
  convertToModelMessages,
  streamText,
  tool,
  isToolUIPart,
  smoothStream,
} from "ai";
import * as blink from "blink";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import { parse } from "node-html-parser";
import * as github from "@blink-sdk/github";
import * as websearch from "@blink-sdk/web-search";
import * as slackbot from "@blink-sdk/slackbot";
import withModelIntent from "@blink-sdk/model-intent";

// Types
type SitemapEntry = {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
};

async function fetchXml(url: string) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to fetch XML: ${url} (${res.status})`);
  return await res.text();
}

async function parseSitemap(
  url: string,
  seen = new Set<string>(),
): Promise<SitemapEntry[]> {
  if (seen.has(url)) return [] as SitemapEntry[];
  seen.add(url);

  const parser = new XMLParser({ ignoreAttributes: false });
  const xml = await fetchXml(url);
  const doc = parser.parse(xml);

  if (doc.sitemapindex?.sitemap) {
    const items = Array.isArray(doc.sitemapindex.sitemap)
      ? doc.sitemapindex.sitemap
      : [doc.sitemapindex.sitemap];
    const nested = await Promise.all(
      items.map((s: any) => parseSitemap(s.loc, seen)),
    );
    return nested.flat();
  }

  if (doc.urlset?.url) {
    const urls = Array.isArray(doc.urlset.url)
      ? doc.urlset.url
      : [doc.urlset.url];
    return urls.map((u: any) => ({
      loc: u.loc,
      lastmod: u.lastmod,
      changefreq: u.changefreq,
      priority: u.priority ? Number(u.priority) : undefined,
    }));
  }

  return [] as SitemapEntry[];
}

function isDocsUrl(url: string) {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "coder.com" || u.hostname.endsWith(".coder.com")) &&
      (u.pathname === "/docs" || u.pathname.startsWith("/docs/"))
    );
  } catch {
    return false;
  }
}

function stripHtml(input: string | undefined, max = 220): string | undefined {
  if (!input) return undefined;
  const s = input
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function hierarchyTitle(h: any): string | undefined {
  if (!h) return undefined;
  const levels = ["lvl1", "lvl2", "lvl0", "lvl3", "lvl4", "lvl5", "lvl6"];
  for (const k of levels) if (h[k]) return String(h[k]);
  return undefined;
}

export default blink.agent({
  async sendMessages({ messages, abortSignal }) {
    messages = messages.map((m) => {
      for (const part of m.parts) {
        if (isToolUIPart(part) && part.state === "output-error") {
          if (part.errorText.length > 2_000) {
            part.errorText = `Error: ${part.errorText.slice(0, 2_000)}... this error was too long to display.`;
          }
        }
      }
      return m;
    });
    const baseSystem = `You are Blink for Docs — an agent for answering questions about Coder using the official documentation at coder.com/docs.

Tools and usage
- search_docs (Algolia): Use targeted queries first. Start specific ("<topic> coder"), then broaden if needed. Prefer mode=light with hitsPerPage 2–3 for discovery; only use mode=full for complex procedures. Use page_outline only when section structure is unclear.
- sitemap_list: Enumerate coder.com/docs URLs from the sitemap for coverage or discovery.
- page_outline: After selecting a page, get title and headings (h1–h3), anchors, and internal links.
- page_section: When citing or extracting exact content, fetch the specific section by anchor or heading.

Guidelines
- Prefer Docs-first answers. Only search GitHub code if the docs are insufficient or the user asks for code-level details.
- Optimize for speed: return concise, sourced answers quickly. Then ask if the user wants to continue by searching the code.
- If confidence is low or docs are missing, say so explicitly, provide any partial findings, and ask: "Should I continue by searching the code repositories?"
- When using web_search, constrain queries to site:coder.com/docs unless explicitly asked to search the broader web.
- "Docs" means coder.com/docs exclusively; do not search or cite non-coder docs sites.
- GitHub repos: when a repository is referenced without an owner, assume the owner is the coder org (e.g., "vscode-coder" → "coder/vscode-coder").
- If a repository isn’t specified at all, assume coder/coder by default.
- Always cite sources with links to the exact coder.com/docs page(s) you used. Prefer placing the link next to the relevant statement.
- Prefer precise quotes from page_section when giving authoritative answers.
- If a user asks for a list/TOC/versions, use sitemap_list and page_outline.
- Keep responses concise and ask for clarification when the query is ambiguous.
- Avoid speculation; only answer using surfaced docs content.

Search Strategy for Speed
- Start with targeted queries combining the main topic + "coder" (e.g., "terraform coder", "docker coder").
- Use search_docs mode=light and hitsPerPage=2–3 initially; only switch to mode=full for complex procedures.
- If the top hit looks promising, go directly to page_section rather than page_outline.

Quick Decision Tree
- Technology/integration questions → search "[tech] coder" or "[tech] provider".
- How-to questions → search the specific action/outcome (e.g., "oidc workspace login").
- Architecture questions → include keywords like "architecture" or "infrastructure".
- If the first search gives clear direction, skip outline and go directly to page_section.

Issues/PRs Investigation (consented)
- Not default. If the user asks "is this broken?", "is this being changed?", "is there a fix?", or mentions a bug/feature/PR/issue, ask: "Do you want me to check recent GitHub issues and pull requests to confirm status?"

GitHub Issues Investigation Strategy
1) Landscape Search First (broad)
   - Run one broad issues search to understand the domain and patterns
   - Query shape: repo:<owner>/<repo> <main-topic> is:issue (sort by updated desc)
   - Scan 3–5 results for recurring error terms, related components, or likely labels
2) Targeted Problem Search (specific)
   - Search the user's exact words/phrases with systematic variations
   - Examples: "<problem> not working", "<feature> missing", "<component> not appearing"
   - Use OR groups when helpful: ("X not showing" OR "X missing" OR "X empty" OR "Y not working")
   - Try 3–4 specific variations before concluding no exact match
3) Synthesis
   - If specific search finds an exact match, lead with it and reference the broad context
   - If only broad results exist, summarize what's related and state no exact match found
   - If neither yields signals, state clearly that no directly related issues were found

Quick GitHub Search Decision Tree
- Bug/broken feature → Landscape first, then targeted
- How-to/usage → Start targeted; broaden only if needed
- Architecture/design → Start broad for comprehensive view

- On consent, scan issues/PRs (limit 3–5) using curated tools (defaults: owner=coder, repo=coder/coder):
  - Issues: keywords from question + labels [bug, regression, deprecation, feature, enhancement], prefer updated:recent
  - PRs: keywords + is:pr, prefer open first, then recently merged/closed
  - Fetch details with github_get_issue / github_get_pull_request; cite links and summarize status (open/closed, merged, last update)
- Respect repo hints from the user; otherwise assume coder/coder. Ask to confirm before expanding scope.
- After summarizing, ask if the user wants deeper code investigation.

Multi-repo GitHub Expansion (consented)
- Default to repo=coder/coder unless the user specifies otherwise.
- If signals indicate a dependency/library/component (e.g., CLI subcommands, module names, error paths like cgroup/clistat), ask: "Should I expand to related repos in the coder org?"
- On consent:
  - Run a broad org scan first: repo:coder/* <main-topic> is:issue|is:pr (sort: updated desc) and scan 3–5 items
  - Then run targeted searches in candidate repos (e.g., coder/clistat for cgroup stats)
  - Consider timeframe breadth (recent and historical) before concluding
- Treat closed in one repo ≠ resolved globally; check for related open items in adjacent repos

Tool-calling
- IMPORTANT: Leverage parallel tool calls to maximize efficiency. When tasks are independent, send multiple tool calls in one step.
- IMPORTANT: Provide "model_intent" in EVERY tool call as a short present-participle phrase (<100 chars), no underscores (e.g., "searching docs for terraform setup").
- Use GitHub tools for read-only repo work; use Workspace tools for writes or execution.
`;

    let systemPrompt = baseSystem;
    const metadata = slackbot.findLastMessageMetadata(messages);
    if (metadata) {
      systemPrompt += `\n<formatting-rules>\n${slackbot.systemPrompt}\n</formatting-rules>\n`;
    }

    const tools = withModelIntent(
      {
        ...slackbot.tools({ messages }),
        search_web: websearch.tools.web_search,
        search_docs: tool({
          description:
            "Search Coder Docs via Algolia DocSearch. Mode 'light' returns url/title/snippet only; 'full' returns hierarchy/content/snippet.",
          inputSchema: z.object({
            query: z.string(),
            page: z.number().int().min(0).optional(),
            hitsPerPage: z.number().int().min(1).max(10).optional(),
            facetFilters: z
              .array(z.union([z.string(), z.array(z.string())]))
              .optional(),
            filters: z.string().optional(),
            mode: z.enum(["light", "full"]).optional(),
          }),
          execute: async (input: {
            query: string;
            page?: number;
            hitsPerPage?: number;
            facetFilters?: (string | string[])[];
            filters?: string;
            mode?: "light" | "full";
          }) => {
            const appId = process.env.ALGOLIA_APP_ID as string | undefined;
            const apiKey = process.env.ALGOLIA_SEARCH_KEY as string | undefined;
            const indexName =
              (process.env.ALGOLIA_INDEX_NAME as string | undefined) ?? "docs";
            if (!appId || !apiKey || !indexName) {
              return {
                available: false as const,
                reason:
                  "Missing Algolia env: ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY, ALGOLIA_INDEX_NAME",
              };
            }
            const mode = input.mode ?? "light";
            const hitsPerPage = Math.min(input.hitsPerPage ?? 3, 5);

            // Ensure we only search v2-tagged docs by default
            const baseFacetFilters: (string | string[])[] = [];
            if (input.facetFilters && Array.isArray(input.facetFilters)) {
              for (const ff of input.facetFilters) baseFacetFilters.push(ff);
            }
            // Add an AND filter for tags:v2 if not already present
            const hasV2 = baseFacetFilters.some((ff) => {
              if (typeof ff === "string") return ff === "tags:v2";
              return ff.includes("tags:v2");
            });
            if (!hasV2) baseFacetFilters.push("tags:v2");
            // Add an AND filter for version:main if not already present
            const hasMain = baseFacetFilters.some((ff) => {
              if (typeof ff === "string") return ff === "version:main";
              return ff.includes("version:main");
            });
            if (!hasMain) baseFacetFilters.push("version:main");

            const body: any = {
              query: input.query,
              page: input.page ?? 0,
              hitsPerPage,
              attributesToRetrieve:
                mode === "light"
                  ? ["url", "hierarchy", "type"]
                  : ["url", "hierarchy", "content", "type"],
              facetFilters: baseFacetFilters,
              filters: input.filters,
            };
            if (mode === "full") body.attributesToSnippet = ["content:40"];

            const res = await fetch(
              `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Algolia-Application-Id": appId,
                  "X-Algolia-API-Key": apiKey,
                },
                body: JSON.stringify(body),
              },
            );
            if (!res.ok) throw new Error(`Algolia error ${res.status}`);
            const data = await res.json();
            const rawHits = (data.hits ?? []) as any[];
            const filtered = rawHits.filter(
              (h) => typeof h.url === "string" && isDocsUrl(h.url),
            );

            const hits =
              mode === "light"
                ? filtered.map((h: any) => ({
                    url: h.url as string,
                    title: hierarchyTitle(h.hierarchy),
                    snippet: stripHtml(
                      h._snippetResult?.content?.value as string | undefined,
                      200,
                    ),
                    objectID: h.objectID as string,
                  }))
                : filtered.map((h: any) => ({
                    url: h.url as string,
                    hierarchy: h.hierarchy,
                    content: h.content as string | undefined,
                    snippet: stripHtml(
                      h._snippetResult?.content?.value as string | undefined,
                      300,
                    ),
                    type: h.type as string | undefined,
                    objectID: h.objectID as string,
                  }));

            return {
              available: true as const,
              hits,
              page: data.page as number,
              nbPages: data.nbPages as number,
              nbHits: data.nbHits as number,
            };
          },
        }),
        sitemap_list: tool({
          description:
            "Fetch and flatten sitemap URLs (default https://coder.com/sitemap.xml), filtered to coder.com/docs.*",
          inputSchema: z.object({
            sitemapUrl: z.string().url().optional(),
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
            limit: z.number().int().min(1).max(10000).optional(),
          }),
          execute: async (input: {
            sitemapUrl?: string;
            include?: string[];
            exclude?: string[];
            limit?: number;
          }) => {
            const sitemapUrl =
              input.sitemapUrl ?? "https://coder.com/sitemap.xml";
            let entries: SitemapEntry[] = await parseSitemap(sitemapUrl);
            entries = entries.filter((e: SitemapEntry) => isDocsUrl(e.loc));
            if (input.include?.length) {
              entries = entries.filter((e: SitemapEntry) =>
                input.include!.some((p: string) => e.loc.includes(p)),
              );
            }
            if (input.exclude?.length) {
              entries = entries.filter(
                (e: SitemapEntry) =>
                  !input.exclude!.some((p: string) => e.loc.includes(p)),
              );
            }
            if (input.limit) entries = entries.slice(0, input.limit);
            return { count: entries.length, entries };
          },
        }),
        page_outline: tool({
          description:
            "Fetch a Docs page and return title and outline (h1–h3 + anchors + internal links).",
          inputSchema: z.object({ url: z.string().url() }),
          execute: async ({ url }: { url: string }) => {
            const res = await fetch(url, { redirect: "follow" });
            if (!res.ok)
              throw new Error(`Failed to fetch page: ${url} (${res.status})`);
            const html = await res.text();
            const root = parse(html);

            const title = root.querySelector("title")?.text?.trim() ?? null;

            const headings: Array<{
              level: number;
              id: string | null;
              text: string;
            }> = [];
            for (const level of [1, 2, 3]) {
              root.querySelectorAll(`h${level}`).forEach((h) => {
                const id =
                  h.getAttribute("id") ??
                  h.querySelector("a[id]")?.getAttribute("id") ??
                  null;
                const text = h.text.trim();
                headings.push({ level, id, text });
              });
            }

            const anchors = root
              .querySelectorAll('a[href^="#"]')
              .map((a) => a.getAttribute("href"))
              .filter((href): href is string => typeof href === "string");

            const internalLinks = root
              .querySelectorAll('a[href^="/"]')
              .map((a) => a.getAttribute("href"))
              .filter((u): u is string => !!u)
              .filter((u) => {
                try {
                  const full = new URL(u, url).toString();
                  return isDocsUrl(full);
                } catch {
                  return false;
                }
              });

            return { url, title, headings, anchors, internalLinks };
          },
        }),
        page_section: tool({
          description:
            "Return the exact content for a specific Docs page section by anchor or heading text.",
          inputSchema: z.object({
            url: z.string().url(),
            anchorId: z.string().optional(),
            headingText: z.string().optional(),
            maxChars: z.number().int().min(100).max(20000).optional(),
          }),
          execute: async ({
            url,
            anchorId,
            headingText,
            maxChars,
          }: {
            url: string;
            anchorId?: string;
            headingText?: string;
            maxChars?: number;
          }) => {
            if (!isDocsUrl(url)) {
              throw new Error("Only coder.com/docs URLs are supported");
            }
            const res = await fetch(url, { redirect: "follow" });
            if (!res.ok)
              throw new Error(`Failed to fetch page: ${url} (${res.status})`);
            const html = await res.text();
            const root = parse(html);

            const headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6");

            function levelOf(tagName: string) {
              const m = tagName?.match(/^h([1-6])$/i);
              return m ? parseInt(m[1], 10) : 6;
            }

            let targetIndex = -1;
            let targetLevel = 6;

            for (let i = 0; i < headings.length; i++) {
              const h = headings[i];
              const id =
                h.getAttribute("id") ??
                h.querySelector("a[id]")?.getAttribute("id") ??
                null;
              const txt = h.text.trim();
              if (
                (anchorId && id === anchorId) ||
                (headingText && txt.toLowerCase() === headingText.toLowerCase())
              ) {
                targetIndex = i;
                targetLevel = levelOf(h.tagName.toLowerCase());
                break;
              }
            }

            if (targetIndex < 0) {
              return {
                found: false as const,
                reason: "Section not found by anchorId or headingText.",
              };
            }

            const start = headings[targetIndex];
            let htmlOut = "";
            const codeBlocks: string[] = [];
            const textChunks: string[] = [];

            let node: any = (start as any).nextElementSibling;
            const maxLen = maxChars ?? 5000;

            while (node) {
              const tag = node.tagName?.toLowerCase?.();
              if (tag && tag.match(/^h[1-6]$/)) {
                const nextLevel = levelOf(tag);
                if (nextLevel <= targetLevel) break;
              }

              const snippet = node.toString();
              if (htmlOut.length + snippet.length > maxLen) break;
              htmlOut += snippet;

              if (tag === "pre" || tag === "code") {
                codeBlocks.push(node.text.trim());
              }
              const maybeText = node.text?.trim?.();
              if (maybeText) textChunks.push(maybeText);

              node = node.nextElementSibling;
            }

            return {
              found: true as const,
              url,
              anchorId:
                anchorId ??
                start.getAttribute("id") ??
                start.querySelector("a[id]")?.getAttribute("id") ??
                null,
              heading: start.text.trim(),
              html: htmlOut,
              text: textChunks.join("\n\n"),
              codeBlocks,
            };
          },
        }),
        ...blink.tools.with(
          {
            github_get_repository: github.tools.get_repository,
            github_repository_read_file: github.tools.repository_read_file,
            github_repository_list_directory:
              github.tools.repository_list_directory,
            github_repository_grep_file: github.tools.repository_grep_file,
            github_search_repositories: github.tools.search_repositories,
            github_search_issues: github.tools.search_issues,
            github_get_pull_request: github.tools.get_pull_request,
            github_list_pull_request_files:
              github.tools.list_pull_request_files,
            github_get_issue: github.tools.get_issue,
            github_list_commits: github.tools.list_commits,
            github_get_commit: github.tools.get_commit,
            github_get_commit_diff: github.tools.get_commit_diff,
            github_search_code: github.tools.search_code,
          },
          { accessToken: process.env.GITHUB_TOKEN },
        ),
      },
      {
        async onModelIntents(modelIntents) {
          if (abortSignal?.aborted) return;
          const metadata = slackbot.findLastMessageMetadata(messages);
          if (!metadata) return;
          let statuses = modelIntents.map((i) => {
            let s = i.modelIntent;
            if (s.length > 0) s = s.charAt(0).toLowerCase() + s.slice(1);
            return s;
          });
          statuses = [...new Set(statuses)];
          const client = await slackbot.createClient(metadata);
          try {
            await client.assistant.threads.setStatus({
              channel_id: metadata.channel,
              thread_ts: metadata.threadTs ?? metadata.ts,
              status: `is ${statuses.join(", ")}...`,
            });
          } catch {}
        },
      },
    );

    return streamText({
      //model: "openai/gpt-5-mini",
      model: "anthropic/claude-4-sonnet",
      system: systemPrompt,
      messages: convertToModelMessages(messages, {
        ignoreIncompleteToolCalls: true,
        tools,
      }),
      tools,
      experimental_transform: smoothStream(),
    });
  },
  async onRequest(request) {
    if (slackbot.isOAuthRequest(request)) {
      return slackbot.handleOAuthRequest(request);
    }
    if (slackbot.isWebhook(request)) {
      return slackbot.handleWebhook(request);
    }
  },
});
