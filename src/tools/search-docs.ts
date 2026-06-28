import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { INFRASTRUCTURE } from "../utils/config.js";

// Thin proxy to the LIVE documentation. The package ships no embedded doc corpus.
// content is fetched from docs.varity.so at runtime (cached for the process), so the
// docs are always current and nothing goes stale inside the published package.

interface DocSection {
  title: string;
  body: string;
}

let sectionsCache: DocSection[] | null = null;

/** Fetch the live llms docs (full content, falling back to the index) and split into sections. */
async function getDocSections(): Promise<DocSection[]> {
  if (sectionsCache) return sectionsCache;
  const sources = [
    `${INFRASTRUCTURE.DOCS}/llms-full.txt`,
    `${INFRASTRUCTURE.DOCS}/llms.txt`,
  ];
  for (const url of sources) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const text = await res.text();
      const sections = splitIntoSections(text);
      if (sections.length) {
        sectionsCache = sections;
        return sections;
      }
    } catch {
      // try the next source
    }
  }
  return [];
}

/** Split a markdown doc into (heading, body) sections on `#`/`##` headers. */
function splitIntoSections(markdown: string): DocSection[] {
  const lines = markdown.split("\n");
  const sections: DocSection[] = [];
  let title = "Documentation";
  let body: string[] = [];
  const flush = () => {
    const text = body.join("\n").trim();
    if (text) sections.push({ title, body: text });
    body = [];
  };
  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) {
      flush();
      title = h[1]!.trim();
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/** Simple relevance score: query words weighted in the heading, then the body. */
function scoreSection(section: DocSection, queryWords: string[]): number {
  const title = section.title.toLowerCase();
  const body = section.body.toLowerCase();
  let score = 0;
  for (const w of queryWords) {
    if (w.length < 3) continue;
    if (title.includes(w)) score += 8;
    if (body.includes(w)) score += 2;
  }
  return score;
}

export function registerSearchDocsTool(server: McpServer): void {
  server.registerTool(
    "varity_search_docs",
    {
      title: "Search Varity Docs",
      description:
        "Search the live Varity documentation for how-to guides, getting-started tutorials, " +
        "deployment, supported stacks, pricing, and troubleshooting. Always reflects the current docs.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Search query (e.g., 'deploy a FastAPI app', 'custom domain', 'pricing')"
          ),
        maxResults: z
          .number()
          .optional()
          .default(3)
          .describe("Maximum number of results to return (default: 3)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ query, maxResults }) => {
      try {
        const sections = await getDocSections();
        if (!sections.length) {
          return successResponse(
            { results: [], docsUrl: INFRASTRUCTURE.DOCS },
            `Couldn't reach the live docs right now. Browse them at ${INFRASTRUCTURE.DOCS}`
          );
        }

        const queryWords = query.toLowerCase().split(/\s+/);
        const scored = sections
          .map((s) => ({ ...s, score: scoreSection(s, queryWords) }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);

        if (!scored.length) {
          return successResponse(
            { results: [], query, docsUrl: INFRASTRUCTURE.DOCS },
            `No matches for "${query}". Browse the full docs at ${INFRASTRUCTURE.DOCS}`
          );
        }

        const results = scored.map((s) => ({
          title: s.title,
          url: INFRASTRUCTURE.DOCS,
          content: s.body.slice(0, 1200),
        }));

        return successResponse(
          { results, query, totalResults: results.length, docsUrl: INFRASTRUCTURE.DOCS },
          `Found ${results.length} result(s) for "${query}"`
        );
      } catch (error) {
        return errorResponse(
          "SEARCH_FAILED",
          `Failed to search documentation: ${error}`,
          `Browse the docs directly at ${INFRASTRUCTURE.DOCS}`
        );
      }
    }
  );
}
