import { convertToModelMessages, streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import { parse } from "node-html-parser";

async function fetchXml(url: string) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to fetch XML: ${url} (${res.status})`);
  return await res.text();
}

async function parseSitemap(url: string, seen = new Set<string>()) {
  if (seen.has(url))
    return [] as Array<{
      loc: string;
      lastmod?: string;
      changefreq?: string;
      priority?: number;
    }>;
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

  return [] as Array<{
    loc: string;
    lastmod?: string;
    changefreq?: string;
    priority?: number;
  }>;
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

export default blink.agent({
  async sendMessages({ messages }) {
    return streamText({
      model: "openai/gpt-5-mini",
      system: `You are a basic agent the user will customize.

Suggest the user adds tools to the agent. Demonstrate your capabilities with the IP tool.`,
      messages: convertToModelMessages(messages),
      tools: {
        get_ip_info: tool({
          description: "Get IP address information of the computer.",
          inputSchema: z.object({}),
          execute: async () => {
            const response = await fetch("https://ipinfo.io/json");
            return response.json();
          },
        }),
        search_docs: tool({
          description:
            "Search Coder Docs via Algolia DocSearch. Use for topical queries across docs.",
          inputSchema: z.object({
            query: z.string(),
            page: z.number().int().min(0).optional(),
            hitsPerPage: z.number().int().min(1).max(100).optional(),
            facetFilters: z
              .array(z.union([z.string(), z.array(z.string())]))
              .optional(),
            filters: z.string().optional(),
          }),
          execute: async (input) => {
            const appId = process.env.ALGOLIA_APP_ID;
            const apiKey = process.env.ALGOLIA_SEARCH_KEY;
            const indexName = process.env.ALGOLIA_INDEX_NAME ?? "docs";
            if (!appId || !apiKey || !indexName) {
              return {
                available: false,
                reason:
                  "Missing Algolia env: ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY, ALGOLIA_INDEX_NAME",
              };
            }
            const res = await fetch(
              `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Algolia-Application-Id": appId,
                  "X-Algolia-API-Key": apiKey,
                },
                body: JSON.stringify({
                  query: input.query,
                  page: input.page ?? 0,
                  hitsPerPage: input.hitsPerPage ?? 10,
                  attributesToRetrieve: ["url", "hierarchy", "content", "type"],
                  attributesToSnippet: ["content:40"],
                  facetFilters: input.facetFilters,
                  filters: input.filters,
                }),
              },
            );
            if (!res.ok) throw new Error(`Algolia error ${res.status}`);
            const data = await res.json();
            return {
              available: true,
              hits: (data.hits ?? []).map((h: any) => ({
                url: h.url,
                hierarchy: h.hierarchy,
                content: h.content,
                type: h.type,
                snippet: h._snippetResult?.content?.value,
                objectID: h.objectID,
              })),
              page: data.page,
              nbPages: data.nbPages,
              nbHits: data.nbHits,
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
          execute: async (input) => {
            const sitemapUrl =
              input.sitemapUrl ?? "https://coder.com/sitemap.xml";
            let entries = await parseSitemap(sitemapUrl);
            entries = entries.filter((e) => isDocsUrl(e.loc));
            if (input.include?.length) {
              entries = entries.filter((e) =>
                input.include!.some((p) => e.loc.includes(p)),
              );
            }
            if (input.exclude?.length) {
              entries = entries.filter(
                (e) => !input.exclude!.some((p) => e.loc.includes(p)),
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
          execute: async ({ url }) => {
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
              .filter(Boolean);

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
          execute: async ({ url, anchorId, headingText, maxChars }) => {
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
                found: false,
                reason: "Section not found by anchorId or headingText.",
              };
            }

            const start = headings[targetIndex];
            let htmlOut = "";
            const codeBlocks: string[] = [];
            const textChunks: string[] = [];

            let node = start.nextElementSibling;
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
              found: true,
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
      },
    });
  },
});
