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
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfParse from "pdf-parse";

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
    return streamText({
      //model: "openai/gpt-5-mini",
      model: "anthropic/claude-4-sonnet",
      system: `You are Blink for Docs — an agent for answering questions about Coder using the official documentation at coder.com/docs.

Tools and usage
- search_docs (Algolia): Use first for topical queries. Start with mode=light and hitsPerPage ≤ 3; use page_outline/page_section for details. If results are weak or empty, fall back to sitemap.
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
`,
      messages: convertToModelMessages(messages),
      tools: withModelIntent(
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
              const apiKey = process.env.ALGOLIA_SEARCH_KEY as
                | string
                | undefined;
              const indexName =
                (process.env.ALGOLIA_INDEX_NAME as string | undefined) ??
                "docs";
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
              if (!isDocsUrl(url)) {
                throw new Error("Only coder.com/docs URLs are supported");
              }
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
                  (headingText &&
                    txt.toLowerCase() === headingText.toLowerCase())
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
          pdf_get_info: tool({
            description: "Get basic info for a PDF (numPages, fingerprint).",
            inputSchema: z.object({ url: z.string().url() }),
            execute: async ({ url }: { url: string }) => {
              const res = await fetch(url, { redirect: "follow" });
              if (!res.ok)
                throw new Error(`Failed to fetch PDF: ${url} (${res.status})`);
              const buffer = await res.arrayBuffer();
              const pdf = await pdfjsLib.getDocument({
                data: new Uint8Array(buffer),
              }).promise;
              return {
                url,
                numPages: pdf.numPages,
                fingerprint: pdf.fingerprints?.[0],
              };
            },
          }),
          pdf_read_chunk: tool({
            description:
              "Read a chunk of pages from a PDF by URL. Returns concatenated text for the range.",
            inputSchema: z.object({
              url: z.string().url(),
              startPage: z.number().int().min(1),
              pageCount: z.number().int().min(1).max(20),
              maxChars: z.number().int().min(100).max(20000).optional(),
            }),
            execute: async ({
              url,
              startPage,
              pageCount,
              maxChars,
            }: {
              url: string;
              startPage: number;
              pageCount: number;
              maxChars?: number;
            }) => {
              const res = await fetch(url, { redirect: "follow" });
              if (!res.ok)
                throw new Error(`Failed to fetch PDF: ${url} (${res.status})`);
              const buffer = await res.arrayBuffer();
              const pdf = await pdfjsLib.getDocument({
                data: new Uint8Array(buffer),
              }).promise;
              const numPages = pdf.numPages;
              const from = Math.max(1, startPage);
              const to = Math.min(numPages, from + pageCount - 1);
              let text = "";
              for (let p = from; p <= to; p++) {
                const page = await pdf.getPage(p);
                const content = await page.getTextContent();
                const pageText = content.items
                  .map((it: any) => it.str ?? "")
                  .join(" ");
                text += (text ? "\n\n" : "") + `\n[Page ${p}]\n` + pageText;
              }
              const limit = Math.min(maxChars ?? 20000, text.length);
              return {
                url,
                startPage: from,
                endPage: to,
                numPages,
                chars: limit,
                text: text.slice(0, limit),
              };
            },
          }),
          pdf_read_pdf: tool({
            description: "Read a PDF and return its text content.",
            inputSchema: z.object({ url: z.string().url() }),
            execute: async ({ url }: { url: string }) => {
              const res = await fetch(url, { redirect: "follow" });
              if (!res.ok)
                throw new Error(`Failed to fetch PDF: ${url} (${res.status})`);
              const buffer = await res.arrayBuffer();
              const data = await pdfParse(buffer);
              return {
                url,
                text: data.text,
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
      ),
      experimental_transform: smoothStream(),
    });
  },
  async webhook(request) {
    if (slackbot.isOAuthRequest(request)) {
      return slackbot.handleOAuthRequest(request);
    }
    if (slackbot.isWebhook(request)) {
      return slackbot.handleWebhook(request);
    }
  },
});
