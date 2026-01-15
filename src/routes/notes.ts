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
