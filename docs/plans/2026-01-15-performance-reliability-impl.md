# Performance & Reliability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Optimize Petra Bridge for performance (metadataCache, parallel reads) and reliability (body limits, timeouts, error isolation).

**Architecture:** Extract shared utilities to `src/utils.ts`, update server.ts with reliability features, then update each route file to use utils and metadataCache.

**Tech Stack:** TypeScript, Node.js http, Obsidian API (App, Vault, MetadataCache)

---

## Task 1: Create Shared Utilities Module

**Files:**
- Create: `src/utils.ts`

**Step 1: Create utils.ts with shared utilities**

```typescript
import { App, TFile, CachedMetadata } from "obsidian";
import type { NoteInfo, NoteFrontmatter } from "./shared";

/** Parse YAML frontmatter from content (fallback when cache unavailable) */
export function parseFrontmatter(content: string): { frontmatter: NoteFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const frontmatter: NoteFrontmatter = {};

  for (const line of yamlStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value.slice(1, -1).split(",").map(s => s.trim());
    } else if (value) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/** Get frontmatter from metadataCache (fast) or parse from content (fallback) */
export function getFrontmatter(app: App, file: TFile, content?: string): NoteFrontmatter {
  const cache = app.metadataCache.getFileCache(file);
  if (cache?.frontmatter) {
    return cache.frontmatter as NoteFrontmatter;
  }
  // Fallback to parsing if cache miss
  if (content) {
    return parseFrontmatter(content).frontmatter;
  }
  return {};
}

/** Convert TFile to NoteInfo using metadataCache */
export function fileToNoteInfo(app: App, file: TFile, cache?: CachedMetadata | null): NoteInfo {
  const metadata = cache ?? app.metadataCache.getFileCache(file);
  const fm = (metadata?.frontmatter || {}) as NoteFrontmatter;

  // Get tags from both frontmatter and inline
  const tags: string[] = [];
  if (Array.isArray(fm.tags)) {
    tags.push(...fm.tags);
  }
  if (metadata?.tags) {
    for (const tag of metadata.tags) {
      const tagName = tag.tag.startsWith("#") ? tag.tag.slice(1) : tag.tag;
      if (!tags.includes(tagName)) {
        tags.push(tagName);
      }
    }
  }

  return {
    path: file.path.replace(/\.md$/, ""),
    title: (fm.title as string) || file.basename,
    tags,
    created: fm.created as string,
    modified: fm.modified as string,
  };
}

/** Normalize path - ensure .md extension */
export function normalizePath(path: string): string {
  if (path.startsWith("/")) path = path.slice(1);
  if (!path.endsWith(".md")) path += ".md";
  return path;
}

/** Extract context around text in content */
export function getContext(content: string, searchText: string, maxLen: number = 100): string {
  const idx = content.indexOf(searchText);
  if (idx === -1) return "";

  const start = Math.max(0, idx - 30);
  const end = Math.min(content.length, idx + searchText.length + 30);
  let context = content.slice(start, end).replace(/\n/g, " ").trim();

  if (start > 0) context = "..." + context;
  if (end < content.length) context = context + "...";

  return context;
}

/** Process files in parallel batches */
export async function processBatch<T, R>(
  items: T[],
  processor: (item: T) => Promise<R | null>,
  batchSize: number = 50
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        try {
          return await processor(item);
        } catch (err) {
          console.warn("Batch processing error:", err);
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (result !== null) {
        results.push(result);
      }
    }
  }

  return results;
}
```

**Step 2: Verify TypeScript compilation**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/utils.ts
git commit -m "feat: add shared utilities module with metadataCache support"
```

---

## Task 2: Add Reliability Features to Server

**Files:**
- Modify: `src/server.ts`

**Step 1: Add constants and update parseBody with size limit**

At top of file after imports, add:
```typescript
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const ROUTE_TIMEOUT = 30000; // 30 seconds
```

Replace `parseBody` method with:
```typescript
private async parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      if (!body) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(body);
      }
    });

    req.on("error", reject);
  });
}
```

**Step 2: Add request timeout wrapper**

Add new method after `parseBody`:
```typescript
private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Request timeout"));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
```

**Step 3: Update handleRequest to use timeout and catch body errors**

Replace `handleRequest` method with:
```typescript
private async handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://127.0.0.1:${DEFAULT_PORT}`);
  const path = url.pathname;
  const method = req.method || "GET";

  // Health check - no auth required, no timeout
  if (path === "/health" && method === "GET") {
    const vault = this.app.vault;
    this.sendJson(res, {
      ok: true,
      data: {
        status: "healthy",
        version: VERSION,
        vault: vault.getName(),
        fileCount: vault.getMarkdownFiles().length,
      },
    });
    return;
  }

  // Check auth for all other endpoints
  if (!this.checkAuth(req)) {
    this.sendError(res, 401, "AUTH_REQUIRED", "Authorization required");
    return;
  }

  // Find matching route
  for (const route of this.routes) {
    if (route.method !== method) continue;

    const match = path.match(route.pattern);
    if (!match) continue;

    // Extract params
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    // Parse body with size limit
    let body: unknown;
    try {
      body = await this.parseBody(req);
    } catch (err) {
      if ((err as Error).message === "Request body too large") {
        this.sendError(res, 413, "INTERNAL_ERROR", "Request body too large (max 10MB)");
      } else {
        this.sendError(res, 400, "INTERNAL_ERROR", "Failed to parse request body");
      }
      return;
    }

    // Execute route with timeout
    try {
      await this.withTimeout(route.handler(req, res, params, body), ROUTE_TIMEOUT);
    } catch (err) {
      if ((err as Error).message === "Request timeout") {
        if (!res.writableEnded) {
          this.sendError(res, 504, "INTERNAL_ERROR", "Request timeout");
        }
      } else {
        throw err;
      }
    }
    return;
  }

  // No route found
  this.sendError(res, 404, "NOT_FOUND", `Route not found: ${method} ${path}`);
}
```

**Step 4: Update stop() for graceful shutdown**

Replace `stop` method with:
```typescript
async stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!this.server) {
      resolve();
      return;
    }

    // Stop accepting new connections
    this.server.close(() => {
      this.server = null;
      resolve();
    });

    // Force close after 5 seconds
    setTimeout(() => {
      if (this.server) {
        this.server.closeAllConnections?.();
        this.server = null;
      }
      resolve();
    }, 5000);
  });
}
```

**Step 5: Add VERSION import**

Update imports at top of file:
```typescript
import { DEFAULT_PORT, VERSION } from "./shared";
```

**Step 6: Verify TypeScript compilation**

Run: `npm run typecheck`
Expected: No errors

**Step 7: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 8: Commit**

```bash
git add src/server.ts
git commit -m "feat: add reliability features - body limit, timeout, graceful shutdown"
```

---

## Task 3: Update Notes Routes

**Files:**
- Modify: `src/routes/notes.ts`

**Step 1: Replace entire file with optimized version**

```typescript
import { App, TFile } from "obsidian";
import { PetraServer } from "../server";
import type { Note, NoteInfo, NoteFrontmatter } from "../shared";
import { parseFrontmatter, fileToNoteInfo, normalizePath, getFrontmatter } from "../utils";

/** Convert TFile to full Note */
async function fileToNote(app: App, file: TFile): Promise<Note> {
  const raw = await app.vault.read(file);
  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    path: file.path.replace(/\.md$/, ""),
    title: (frontmatter.title as string) || file.basename,
    content: body,
    frontmatter,
    raw,
  };
}

/** Register note routes */
export function registerNoteRoutes(server: PetraServer, app: App): void {

  // GET /notes - List notes (uses metadataCache for speed)
  server.route("GET", "/notes", async (req, res, _params, _body) => {
    const url = new URL(req.url || "/", "http://localhost");
    const folder = url.searchParams.get("folder");
    const limit = parseInt(url.searchParams.get("limit") || "100");
    const tag = url.searchParams.get("tag");

    const files = app.vault.getMarkdownFiles();
    let filtered = files;

    // Filter by folder
    if (folder) {
      filtered = filtered.filter(f => f.path.startsWith(folder));
    }

    // Get note info using metadataCache (fast!)
    const notes: NoteInfo[] = [];
    for (const file of filtered) {
      if (notes.length >= limit) break;

      try {
        const info = fileToNoteInfo(app, file);

        // Filter by tag if specified
        if (tag && !info.tags.includes(tag)) continue;

        notes.push(info);
      } catch (err) {
        console.warn(`Failed to process ${file.path}:`, err);
        continue;
      }
    }

    server.sendJson(res, { ok: true, data: notes });
  });

  // POST /notes - Create note
  server.route("POST", "/notes", async (_req, res, _params, body) => {
    const { path, content = "", frontmatter = {} } = body as {
      path: string;
      content?: string;
      frontmatter?: NoteFrontmatter;
    };

    if (!path) {
      server.sendError(res, 400, "INVALID_PATH", "Path is required");
      return;
    }

    const normalizedPath = normalizePath(path);
    const existing = app.vault.getAbstractFileByPath(normalizedPath);

    if (existing) {
      server.sendError(res, 409, "ALREADY_EXISTS", `Note already exists: ${path}`);
      return;
    }

    // Build content with frontmatter
    const fm: NoteFrontmatter = {
      created: new Date().toISOString(),
      ...frontmatter,
    };

    const yamlLines = Object.entries(fm).map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}: [${(v as string[]).join(", ")}]`;
      }
      return `${k}: ${String(v)}`;
    });

    const fileContent = `---\n${yamlLines.join("\n")}\n---\n${content}`;

    // Ensure parent folder exists
    const folderPath = normalizedPath.split("/").slice(0, -1).join("/");
    if (folderPath) {
      const folderExists = app.vault.getAbstractFileByPath(folderPath);
      if (!folderExists) {
        await app.vault.createFolder(folderPath);
      }
    }

    const file = await app.vault.create(normalizedPath, fileContent);
    const note = await fileToNote(app, file);

    server.sendJson(res, { ok: true, data: note });
  });

  // GET /notes/:path - Read note
  server.route("GET", "/notes/:path", async (_req, res, params, _body) => {
    const path = normalizePath(params.path);
    const file = app.vault.getAbstractFileByPath(path);

    if (!file || !(file instanceof TFile)) {
      server.sendError(res, 404, "NOT_FOUND", `Note not found: ${params.path}`);
      return;
    }

    const note = await fileToNote(app, file);
    server.sendJson(res, { ok: true, data: note });
  });

  // PUT /notes/:path - Update note
  server.route("PUT", "/notes/:path", async (_req, res, params, body) => {
    const path = normalizePath(params.path);
    const file = app.vault.getAbstractFileByPath(path);

    if (!file || !(file instanceof TFile)) {
      server.sendError(res, 404, "NOT_FOUND", `Note not found: ${params.path}`);
      return;
    }

    const { content, append, frontmatter } = body as {
      content?: string;
      append?: string;
      frontmatter?: NoteFrontmatter;
    };

    const existing = await app.vault.read(file);
    const parsed = parseFrontmatter(existing);

    // Update content
    let newBody = parsed.body;
    if (content !== undefined) {
      newBody = content;
    } else if (append !== undefined) {
      newBody = parsed.body + "\n" + append;
    }

    // Update frontmatter
    const newFm: NoteFrontmatter = {
      ...parsed.frontmatter,
      ...frontmatter,
      modified: new Date().toISOString(),
    };

    const yamlLines = Object.entries(newFm).map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}: [${(v as string[]).join(", ")}]`;
      }
      return `${k}: ${String(v)}`;
    });

    const newContent = `---\n${yamlLines.join("\n")}\n---\n${newBody}`;
    await app.vault.modify(file, newContent);

    const note = await fileToNote(app, file);
    server.sendJson(res, { ok: true, data: note });
  });

  // DELETE /notes/:path - Delete note
  server.route("DELETE", "/notes/:path", async (_req, res, params, _body) => {
    const path = normalizePath(params.path);
    const file = app.vault.getAbstractFileByPath(path);

    if (!file || !(file instanceof TFile)) {
      server.sendError(res, 404, "NOT_FOUND", `Note not found: ${params.path}`);
      return;
    }

    await app.fileManager.trashFile(file);
    server.sendJson(res, { ok: true, data: { deleted: params.path } });
  });

  // POST /notes/:path/move - Move/rename note
  server.route("POST", "/notes/:path/move", async (_req, res, params, body) => {
    const path = normalizePath(params.path);
    const file = app.vault.getAbstractFileByPath(path);

    if (!file || !(file instanceof TFile)) {
      server.sendError(res, 404, "NOT_FOUND", `Note not found: ${params.path}`);
      return;
    }

    const { newPath } = body as { newPath: string };
    if (!newPath) {
      server.sendError(res, 400, "INVALID_PATH", "newPath is required");
      return;
    }

    const normalizedNewPath = normalizePath(newPath);

    // Use fileManager for link-aware rename
    await app.fileManager.renameFile(file, normalizedNewPath);

    const newFile = app.vault.getAbstractFileByPath(normalizedNewPath);
    if (newFile instanceof TFile) {
      const note = await fileToNote(app, newFile);
      server.sendJson(res, { ok: true, data: note });
    } else {
      server.sendJson(res, { ok: true, data: { moved: newPath } });
    }
  });
}
```

**Step 2: Verify TypeScript compilation**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/routes/notes.ts
git commit -m "refactor: notes routes to use shared utils and metadataCache"
```

---

## Task 4: Update Search Routes

**Files:**
- Modify: `src/routes/search.ts`

**Step 1: Replace entire file with optimized version**

```typescript
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
```

**Step 2: Verify TypeScript compilation**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/routes/search.ts
git commit -m "refactor: search routes with parallel reads and metadataCache"
```

---

## Task 5: Update Tags Routes

**Files:**
- Modify: `src/routes/tags.ts`

**Step 1: Replace entire file with optimized version**

```typescript
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
```

**Step 2: Verify TypeScript compilation**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/routes/tags.ts
git commit -m "refactor: tags routes to use metadataCache (no file reads)"
```

---

## Task 6: Update Links Routes

**Files:**
- Modify: `src/routes/links.ts`

**Step 1: Replace entire file with optimized version**

```typescript
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
```

**Step 2: Verify TypeScript compilation**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/routes/links.ts
git commit -m "refactor: links routes to use metadataCache and resolvedLinks"
```

---

## Task 7: Update Graph Routes

**Files:**
- Modify: `src/routes/graph.ts`

**Step 1: Replace entire file with optimized version**

```typescript
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
```

**Step 2: Verify TypeScript compilation**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/routes/graph.ts
git commit -m "refactor: graph routes to use metadataCache (no content parsing)"
```

---

## Task 8: Update Daily Routes

**Files:**
- Modify: `src/routes/daily.ts`

**Step 1: Replace entire file with optimized version**

```typescript
import { App, TFile, TFolder } from "obsidian";
import { PetraServer } from "../server";
import type { Note, NoteInfo } from "../shared";
import { parseFrontmatter, fileToNoteInfo } from "../utils";

interface DailyConfig {
  format: string;
  folder: string;
  template?: string;
}

/** Get daily notes config from Obsidian settings */
function getDailyConfig(_app: App): DailyConfig {
  return {
    format: "YYYY-MM-DD",
    folder: "",
  };
}

/** Format date using pattern */
function formatDate(date: Date, format: string): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayNamesShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  let result = format;
  result = result.replace(/YYYY/g, String(year));
  result = result.replace(/MM/g, month);
  result = result.replace(/DD/g, day);
  result = result.replace(/dddd/g, dayNames[date.getDay()]);
  result = result.replace(/ddd/g, dayNamesShort[date.getDay()]);

  return result;
}

/** Parse date string */
function parseDate(dateStr: string): Date | null {
  if (dateStr === "today") return new Date();
  if (dateStr === "tomorrow") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (dateStr === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }

  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  }

  return null;
}

/** Convert file to Note */
async function fileToNote(app: App, file: TFile): Promise<Note> {
  const raw = await app.vault.read(file);
  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    path: file.path.replace(/\.md$/, ""),
    title: (frontmatter.title as string) || file.basename,
    content: body,
    frontmatter,
    raw,
  };
}

/** Register daily notes routes */
export function registerDailyRoutes(server: PetraServer, app: App): void {

  // POST /daily - Create daily note
  server.route("POST", "/daily", async (_req, res, _params, body) => {
    const { date: dateStr = "today" } = body as { date?: string };

    const date = parseDate(dateStr);
    if (!date) {
      server.sendError(res, 400, "INVALID_PATH", `Invalid date: ${dateStr}`);
      return;
    }

    const config = getDailyConfig(app);
    const filename = formatDate(date, config.format);
    const notePath = config.folder ? `${config.folder}/${filename}.md` : `${filename}.md`;

    // Check if exists
    const existing = app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) {
      try {
        const note = await fileToNote(app, existing);
        server.sendJson(res, { ok: true, data: { note, created: false } });
      } catch (err) {
        server.sendError(res, 500, "INTERNAL_ERROR", `Failed to read daily note: ${err}`);
      }
      return;
    }

    // Create folder if needed
    if (config.folder) {
      const folder = app.vault.getAbstractFileByPath(config.folder);
      if (!folder) {
        await app.vault.createFolder(config.folder);
      }
    }

    // Create daily note
    try {
      const content = `---\ncreated: ${new Date().toISOString()}\n---\n`;
      const file = await app.vault.create(notePath, content);
      const note = await fileToNote(app, file);
      server.sendJson(res, { ok: true, data: { note, created: true } });
    } catch (err) {
      server.sendError(res, 500, "INTERNAL_ERROR", `Failed to create daily note: ${err}`);
    }
  });

  // GET /daily/:date - Get daily note
  server.route("GET", "/daily/:date", async (_req, res, params, _body) => {
    const date = parseDate(params.date);
    if (!date) {
      server.sendError(res, 400, "INVALID_PATH", `Invalid date: ${params.date}`);
      return;
    }

    const config = getDailyConfig(app);
    const filename = formatDate(date, config.format);
    const notePath = config.folder ? `${config.folder}/${filename}.md` : `${filename}.md`;

    const file = app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      server.sendError(res, 404, "NOT_FOUND", `Daily note not found for ${params.date}`);
      return;
    }

    try {
      const note = await fileToNote(app, file);
      server.sendJson(res, { ok: true, data: note });
    } catch (err) {
      server.sendError(res, 500, "INTERNAL_ERROR", `Failed to read daily note: ${err}`);
    }
  });

  // GET /daily - List recent daily notes (uses metadataCache)
  server.route("GET", "/daily", async (req, res, _params, _body) => {
    const url = new URL(req.url || "/", "http://localhost");
    const limit = parseInt(url.searchParams.get("limit") || "7");

    const config = getDailyConfig(app);
    const files = app.vault.getMarkdownFiles();

    // Filter to daily notes by pattern matching
    const dailyPattern = /^\d{4}-\d{2}-\d{2}$/;
    const dailyNotes: Array<{ file: TFile; date: Date }> = [];

    for (const file of files) {
      // Check if in daily folder
      if (config.folder && !file.path.startsWith(config.folder)) continue;

      // Check filename matches date pattern
      if (dailyPattern.test(file.basename)) {
        const [year, month, day] = file.basename.split("-").map(Number);
        dailyNotes.push({
          file,
          date: new Date(year, month - 1, day),
        });
      }
    }

    // Sort by date descending
    dailyNotes.sort((a, b) => b.date.getTime() - a.date.getTime());

    // Get note info using metadataCache
    const notes: NoteInfo[] = [];
    for (const { file } of dailyNotes.slice(0, limit)) {
      try {
        notes.push(fileToNoteInfo(app, file));
      } catch (err) {
        console.warn(`Failed to get info for ${file.path}:`, err);
      }
    }

    server.sendJson(res, { ok: true, data: notes });
  });
}
```

**Step 2: Verify TypeScript compilation**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/routes/daily.ts
git commit -m "refactor: daily routes with error isolation and metadataCache"
```

---

## Task 9: Update Templates Routes

**Files:**
- Modify: `src/routes/templates.ts`

**Step 1: Replace entire file with optimized version**

```typescript
import { App, TFile, TFolder } from "obsidian";
import { PetraServer } from "../server";
import type { Note } from "../shared";
import { parseFrontmatter } from "../utils";

interface TemplateInfo {
  name: string;
  path: string;
}

/** Get templates folder from Obsidian settings */
function getTemplatesFolder(app: App): string {
  const possibleFolders = ["Templates", "templates", "_templates"];

  for (const folder of possibleFolders) {
    if (app.vault.getAbstractFileByPath(folder) instanceof TFolder) {
      return folder;
    }
  }

  return "Templates";
}

/** Simple template variable replacement */
function processTemplate(content: string, variables: Record<string, string>): string {
  let processed = content;

  // Replace {{variable}} patterns
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g");
    processed = processed.replace(pattern, value);
  }

  // Built-in variables
  const now = new Date();
  processed = processed.replace(/\{\{\s*date\s*\}\}/g, now.toISOString().split("T")[0]);
  processed = processed.replace(/\{\{\s*time\s*\}\}/g, now.toTimeString().split(" ")[0]);
  processed = processed.replace(/\{\{\s*datetime\s*\}\}/g, now.toISOString());

  return processed;
}

/** Register template routes */
export function registerTemplateRoutes(server: PetraServer, app: App): void {

  // GET /templates - List available templates
  server.route("GET", "/templates", async (_req, res, _params, _body) => {
    const templatesFolder = getTemplatesFolder(app);
    const folder = app.vault.getAbstractFileByPath(templatesFolder);

    if (!(folder instanceof TFolder)) {
      server.sendJson(res, { ok: true, data: [] });
      return;
    }

    const templates: TemplateInfo[] = [];

    function scanFolder(f: TFolder, prefix: string = "") {
      for (const child of f.children) {
        try {
          if (child instanceof TFile && child.extension === "md") {
            templates.push({
              name: prefix + child.basename,
              path: child.path,
            });
          } else if (child instanceof TFolder) {
            scanFolder(child, prefix + child.name + "/");
          }
        } catch (err) {
          console.warn(`Failed to scan ${child.path}:`, err);
        }
      }
    }

    scanFolder(folder);
    templates.sort((a, b) => a.name.localeCompare(b.name));

    server.sendJson(res, { ok: true, data: templates });
  });

  // POST /templates/:name/run - Execute a template
  server.route("POST", "/templates/:name/run", async (_req, res, params, body) => {
    const { destination, variables = {} } = body as {
      destination: string;
      variables?: Record<string, string>;
    };

    if (!destination) {
      server.sendError(res, 400, "INVALID_PATH", "Destination path is required");
      return;
    }

    // Find template
    const templatesFolder = getTemplatesFolder(app);
    const templatePath = `${templatesFolder}/${params.name}.md`;
    const templateFile = app.vault.getAbstractFileByPath(templatePath);

    if (!(templateFile instanceof TFile)) {
      server.sendError(res, 404, "NOT_FOUND", `Template not found: ${params.name}`);
      return;
    }

    try {
      // Read and process template
      const templateContent = await app.vault.read(templateFile);
      const processedContent = processTemplate(templateContent, {
        title: destination.split("/").pop()?.replace(".md", "") || "",
        ...variables,
      });

      // Create destination
      const destPath = destination.endsWith(".md") ? destination : destination + ".md";

      // Check if exists
      if (app.vault.getAbstractFileByPath(destPath)) {
        server.sendError(res, 409, "ALREADY_EXISTS", `Note already exists: ${destination}`);
        return;
      }

      // Create parent folder if needed
      const parentPath = destPath.split("/").slice(0, -1).join("/");
      if (parentPath && !app.vault.getAbstractFileByPath(parentPath)) {
        await app.vault.createFolder(parentPath);
      }

      // Create the note
      const newFile = await app.vault.create(destPath, processedContent);

      // Return the created note
      const { frontmatter, body: noteBody } = parseFrontmatter(processedContent);
      const note: Note = {
        path: newFile.path.replace(/\.md$/, ""),
        title: (frontmatter.title as string) || newFile.basename,
        content: noteBody,
        frontmatter,
        raw: processedContent,
      };

      server.sendJson(res, { ok: true, data: note });
    } catch (err) {
      server.sendError(res, 500, "INTERNAL_ERROR", `Failed to execute template: ${err}`);
    }
  });
}
```

**Step 2: Verify TypeScript compilation**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/routes/templates.ts
git commit -m "refactor: templates routes with error isolation"
```

---

## Task 10: Final Verification

**Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: No errors

**Step 2: Run full build**

Run: `npm run build`
Expected: Build succeeds, `dist/main.js` updated

**Step 3: Check bundle size**

Run: `ls -la dist/main.js`
Expected: File exists, reasonable size (should be similar or smaller)

**Step 4: Run ESLint if available**

Run: `npm run lint 2>/dev/null || echo "No lint script"`
Expected: Pass or no lint script

**Step 5: Final commit if needed**

If any files changed during verification:
```bash
git add -A
git commit -m "chore: final cleanup"
```

---

## Summary

After completing all tasks:
- **Performance**: Routes use metadataCache instead of file parsing, parallel batch processing for search
- **Reliability**: 10MB body limit, 30s timeout, error isolation, graceful shutdown
- **Code Quality**: Shared utilities in `src/utils.ts`, no more duplication
