import { App, TFile } from "obsidian";
import { PetraServer } from "../server";
import type { NoteInfo } from "../shared";
import { normalizePath, fileToNoteInfo, getContext } from "../utils";

interface LinkInfo {
  path: string;
  title: string;
  exists: boolean;
  context?: string;
}

interface BacklinkInfo extends NoteInfo {
  context: string;
}

/** Register link routes */
export function registerLinkRoutes(server: PetraServer, app: App): void {

  // GET /notes/:path/backlinks - Notes linking TO this note
  server.route("GET", "/notes/:path/backlinks", async (_req, res, params, _body) => {
    const targetPath = normalizePath(params.path);
    const targetFile = app.vault.getAbstractFileByPath(targetPath);

    if (!(targetFile instanceof TFile)) {
      server.sendError(res, 404, "NOT_FOUND", `Note not found: ${params.path}`);
      return;
    }

    const backlinks: BacklinkInfo[] = [];
    const files = app.vault.getMarkdownFiles();
    const targetBasename = targetFile.basename;

    for (const file of files) {
      if (file.path === targetPath) continue;

      try {
        // Use metadataCache to check for links first (fast)
        const cache = app.metadataCache.getFileCache(file);
        if (!cache?.links && !cache?.embeds) continue;

        // Check if any link points to our target
        const allLinks = [...(cache.links || []), ...(cache.embeds || [])];
        const hasLink = allLinks.some(link => {
          const resolved = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
          return resolved?.path === targetPath;
        });

        if (hasLink) {
          // Only read content if we found a link (for context)
          const content = await app.vault.read(file);
          const linkMatch = content.match(new RegExp(`\\[\\[${targetBasename}(\\|[^\\]]+)?\\]\\]`, "i"));

          const info = fileToNoteInfo(app, file, cache);
          backlinks.push({
            ...info,
            context: linkMatch ? getContext(content, linkMatch[0]) : "",
          });
        }
      } catch (err) {
        console.warn(`Failed to check backlinks in ${file.path}:`, err);
        continue;
      }
    }

    server.sendJson(res, { ok: true, data: backlinks });
  });

  // GET /notes/:path/outlinks - Notes this note links TO (uses resolvedLinks)
  server.route("GET", "/notes/:path/outlinks", async (_req, res, params, _body) => {
    const sourcePath = normalizePath(params.path);
    const sourceFile = app.vault.getAbstractFileByPath(sourcePath);

    if (!(sourceFile instanceof TFile)) {
      server.sendError(res, 404, "NOT_FOUND", `Note not found: ${params.path}`);
      return;
    }

    const outlinks: LinkInfo[] = [];
    const seen = new Set<string>();

    // Use metadataCache for links
    const cache = app.metadataCache.getFileCache(sourceFile);
    const content = await app.vault.read(sourceFile);

    if (cache?.links) {
      for (const link of cache.links) {
        if (seen.has(link.link)) continue;
        seen.add(link.link);

        const resolved = app.metadataCache.getFirstLinkpathDest(link.link, sourcePath);

        outlinks.push({
          path: resolved ? resolved.path.replace(/\.md$/, "") : link.link,
          title: resolved ? resolved.basename : link.link,
          exists: resolved !== null,
          context: getContext(content, link.original),
        });
      }
    }

    // Also check embeds
    if (cache?.embeds) {
      for (const embed of cache.embeds) {
        if (seen.has(embed.link)) continue;
        seen.add(embed.link);

        const resolved = app.metadataCache.getFirstLinkpathDest(embed.link, sourcePath);

        // Only include markdown files
        if (resolved && resolved.extension === "md") {
          outlinks.push({
            path: resolved.path.replace(/\.md$/, ""),
            title: resolved.basename,
            exists: true,
            context: getContext(content, embed.original),
          });
        }
      }
    }

    server.sendJson(res, { ok: true, data: outlinks });
  });
}
