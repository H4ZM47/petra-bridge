import { App } from "obsidian";
import { PetraServer } from "../server";
import { fileToNoteInfo } from "../utils";

/** Register tag routes */
export function registerTagRoutes(server: PetraServer, app: App): void {

  // GET /tags - List all tags with counts (uses metadataCache)
  server.route("GET", "/tags", async (_req, res, _params, _body) => {
    const tagCounts = new Map<string, number>();
    const files = app.vault.getMarkdownFiles();

    for (const file of files) {
      try {
        const cache = app.metadataCache.getFileCache(file);

        // Frontmatter tags
        if (cache?.frontmatter?.tags) {
          const fmTags = cache.frontmatter.tags;
          if (Array.isArray(fmTags)) {
            for (const tag of fmTags) {
              const tagStr = String(tag);
              tagCounts.set(tagStr, (tagCounts.get(tagStr) || 0) + 1);
            }
          }
        }

        // Inline tags from cache
        if (cache?.tags) {
          for (const tagRef of cache.tags) {
            const tag = tagRef.tag.startsWith("#") ? tagRef.tag.slice(1) : tagRef.tag;
            tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
          }
        }
      } catch (err) {
        console.warn(`Failed to get tags for ${file.path}:`, err);
        continue;
      }
    }

    // Convert to sorted array
    const result = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    server.sendJson(res, { ok: true, data: result });
  });

  // GET /tags/:tag/notes - Get notes with specific tag (uses metadataCache)
  server.route("GET", "/tags/:tag/notes", async (req, res, params, _body) => {
    const searchTag = params.tag.toLowerCase();
    const url = new URL(req.url || "/", "http://localhost");
    const exact = url.searchParams.get("exact") === "true";
    const limit = parseInt(url.searchParams.get("limit") || "50");

    const files = app.vault.getMarkdownFiles();
    const notes: ReturnType<typeof fileToNoteInfo>[] = [];

    for (const file of files) {
      if (notes.length >= limit) break;

      try {
        const cache = app.metadataCache.getFileCache(file);
        const tags: string[] = [];

        // Collect tags from frontmatter
        if (cache?.frontmatter?.tags && Array.isArray(cache.frontmatter.tags)) {
          tags.push(...cache.frontmatter.tags.map(String));
        }

        // Collect inline tags
        if (cache?.tags) {
          for (const tagRef of cache.tags) {
            const tag = tagRef.tag.startsWith("#") ? tagRef.tag.slice(1) : tagRef.tag;
            if (!tags.includes(tag)) {
              tags.push(tag);
            }
          }
        }

        const hasMatch = tags.some(t => {
          const normalized = t.toLowerCase();
          return exact ? normalized === searchTag : normalized.includes(searchTag);
        });

        if (hasMatch) {
          notes.push(fileToNoteInfo(app, file, cache));
        }
      } catch (err) {
        console.warn(`Failed to check tags for ${file.path}:`, err);
        continue;
      }
    }

    server.sendJson(res, { ok: true, data: notes });
  });
}
