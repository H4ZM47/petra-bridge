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
