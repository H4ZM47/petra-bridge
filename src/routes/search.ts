import { App, TFile } from "obsidian";
import { PetraServer } from "../server";
import type { SearchResult, SearchMatch, NoteInfo } from "../shared";
import { fileToNoteInfo, processBatch } from "../utils";

/** Register search routes */
export function registerSearchRoutes(server: PetraServer, app: App): void {

  // POST /search - Full-text search with parallel reads
  server.route("POST", "/search", async (_req, res, _params, body) => {
    const { query, folder, limit = 20, caseSensitive = false } = body as {
      query: string;
      folder?: string;
      limit?: number;
      caseSensitive?: boolean;
    };

    if (!query) {
      server.sendError(res, 400, "INVALID_PATH", "Query is required");
      return;
    }

    const searchQuery = caseSensitive ? query : query.toLowerCase();
    let files = app.vault.getMarkdownFiles();

    // Filter by folder first (no I/O needed)
    if (folder) {
      files = files.filter(f => f.path.startsWith(folder));
    }

    const results: SearchResult[] = [];

    // Process files in parallel batches
    await processBatch(files, async (file): Promise<null> => {
      // Early exit if we have enough results
      if (results.length >= limit) return null;

      try {
        const content = await app.vault.read(file);
        const matches: SearchMatch[] = [];

        // Search in content (skip frontmatter section)
        const bodyStart = content.indexOf("---\n", 4);
        const body = bodyStart > 0 ? content.slice(bodyStart + 4) : content;

        const lines = body.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const searchLine = caseSensitive ? line : line.toLowerCase();
          if (searchLine.includes(searchQuery)) {
            matches.push({ line: i + 1, text: line.trim() });
          }
        }

        // Search in frontmatter via metadataCache
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.frontmatter) {
          const fmStr = JSON.stringify(cache.frontmatter);
          const searchFm = caseSensitive ? fmStr : fmStr.toLowerCase();
          if (searchFm.includes(searchQuery)) {
            matches.push({ line: 0, text: `[frontmatter] ${fmStr.slice(0, 100)}` });
          }
        }

        if (matches.length > 0 && results.length < limit) {
          results.push({
            note: fileToNoteInfo(app, file, cache),
            matches,
          });
        }
      } catch (err) {
        console.warn(`Search failed for ${file.path}:`, err);
      }

      return null;
    }, 50);

    // Sort by match count
    results.sort((a, b) => b.matches.length - a.matches.length);

    server.sendJson(res, { ok: true, data: results.slice(0, limit) });
  });
}
