import { App, TFile } from "obsidian";
import { PetraServer } from "../server";

interface GraphNode {
  id: string;
  title: string;
  group?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  type: "wiki" | "markdown";
}

interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Register graph routes */
export function registerGraphRoutes(server: PetraServer, app: App): void {

  // POST /graph/query - Query the link graph (uses metadataCache)
  server.route("POST", "/graph/query", async (_req, res, _params, body) => {
    const {
      from,
      depth = 1,
      direction = "both"
    } = body as {
      from?: string;
      depth?: number;
      direction?: "in" | "out" | "both";
    };

    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<string>();
    const files = app.vault.getMarkdownFiles();

    // Build file lookup
    const fileMap = new Map<string, TFile>();
    for (const file of files) {
      fileMap.set(file.path, file);
      fileMap.set(file.basename, file);
      fileMap.set(file.path.replace(/\.md$/, ""), file);
    }

    // Add a node
    function addNode(file: TFile) {
      const id = file.path.replace(/\.md$/, "");
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          title: file.basename,
          group: file.parent?.path || "",
        });
      }
    }

    // Get outgoing links using metadataCache
    function getOutlinks(file: TFile): Array<{ target: TFile; type: "wiki" | "markdown" }> {
      const results: Array<{ target: TFile; type: "wiki" | "markdown" }> = [];
      const cache = app.metadataCache.getFileCache(file);

      if (cache?.links) {
        for (const link of cache.links) {
          const resolved = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
          if (resolved instanceof TFile) {
            results.push({ target: resolved, type: "wiki" });
          }
        }
      }

      return results;
    }

    // BFS traversal
    async function traverse(startPath: string, currentDepth: number) {
      if (currentDepth > depth) return;
      if (visited.has(startPath)) return;
      visited.add(startPath);

      const file = fileMap.get(startPath) || fileMap.get(startPath + ".md");
      if (!file) return;

      addNode(file);
      const fileId = file.path.replace(/\.md$/, "");

      // Outgoing links
      if (direction === "out" || direction === "both") {
        const outlinks = getOutlinks(file);
        for (const { target, type } of outlinks) {
          addNode(target);
          const targetId = target.path.replace(/\.md$/, "");
          edges.push({ source: fileId, target: targetId, type });
          await traverse(target.path, currentDepth + 1);
        }
      }

      // Incoming links (backlinks)
      if (direction === "in" || direction === "both") {
        for (const otherFile of files) {
          if (otherFile.path === file.path) continue;

          try {
            const cache = app.metadataCache.getFileCache(otherFile);
            if (!cache?.links) continue;

            for (const link of cache.links) {
              const resolved = app.metadataCache.getFirstLinkpathDest(link.link, otherFile.path);
              if (resolved?.path === file.path) {
                addNode(otherFile);
                const sourceId = otherFile.path.replace(/\.md$/, "");
                edges.push({ source: sourceId, target: fileId, type: "wiki" });
                await traverse(otherFile.path, currentDepth + 1);
                break;
              }
            }
          } catch (err) {
            console.warn(`Failed to check links in ${otherFile.path}:`, err);
          }
        }
      }
    }

    // Start traversal
    if (from) {
      await traverse(from, 0);
    } else {
      // No starting point - return entire graph (limited)
      for (const file of files.slice(0, 100)) {
        try {
          addNode(file);
          const fileId = file.path.replace(/\.md$/, "");
          const outlinks = getOutlinks(file);

          for (const { target, type } of outlinks) {
            addNode(target);
            const targetId = target.path.replace(/\.md$/, "");
            edges.push({ source: fileId, target: targetId, type });
          }
        } catch (err) {
          console.warn(`Failed to process ${file.path}:`, err);
        }
      }
    }

    const result: GraphResult = {
      nodes: Array.from(nodes.values()),
      edges,
    };

    server.sendJson(res, { ok: true, data: result });
  });

  // GET /graph/neighbors/:path - Get immediate neighbors (uses metadataCache)
  server.route("GET", "/graph/neighbors/:path", async (req, res, params, _body) => {
    const url = new URL(req.url || "/", "http://localhost");
    const direction = (url.searchParams.get("direction") || "both") as "in" | "out" | "both";

    const normalizedPath = params.path.endsWith(".md") ? params.path : params.path + ".md";
    const centerFile = app.vault.getAbstractFileByPath(normalizedPath);

    if (!(centerFile instanceof TFile)) {
      server.sendError(res, 404, "NOT_FOUND", `Note not found: ${params.path}`);
      return;
    }

    const neighbors: Array<{ path: string; title: string; direction: "in" | "out" }> = [];
    const seen = new Set<string>();

    // Outgoing links using metadataCache
    if (direction === "out" || direction === "both") {
      const cache = app.metadataCache.getFileCache(centerFile);
      if (cache?.links) {
        for (const link of cache.links) {
          const resolved = app.metadataCache.getFirstLinkpathDest(link.link, centerFile.path);
          if (resolved instanceof TFile && !seen.has(resolved.path)) {
            seen.add(resolved.path);
            neighbors.push({
              path: resolved.path.replace(/\.md$/, ""),
              title: resolved.basename,
              direction: "out",
            });
          }
        }
      }
    }

    // Incoming links (backlinks)
    if (direction === "in" || direction === "both") {
      const files = app.vault.getMarkdownFiles();
      for (const file of files) {
        if (file.path === centerFile.path || seen.has(file.path)) continue;

        try {
          const cache = app.metadataCache.getFileCache(file);
          if (!cache?.links) continue;

          for (const link of cache.links) {
            const resolved = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
            if (resolved?.path === centerFile.path) {
              seen.add(file.path);
              neighbors.push({
                path: file.path.replace(/\.md$/, ""),
                title: file.basename,
                direction: "in",
              });
              break;
            }
          }
        } catch (err) {
          console.warn(`Failed to check links in ${file.path}:`, err);
        }
      }
    }

    server.sendJson(res, { ok: true, data: neighbors });
  });
}
