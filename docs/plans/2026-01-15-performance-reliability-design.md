# Performance & Reliability Optimization Design

## Overview

Optimize Petra Bridge for performance and reliability through:
- Leveraging Obsidian's metadataCache instead of manual file parsing
- Consolidating duplicated utilities
- Adding parallel file operations
- Implementing reliability safeguards (body limits, timeouts, error isolation)

## Core Architecture Changes

### Shared Utilities Module (`src/utils.ts`)

Consolidate duplicated code from 5 route files into single module:

```typescript
// Shared utilities
export function parseFrontmatter(content: string): { frontmatter: NoteFrontmatter; body: string }
export function fileToNoteInfo(app: App, file: TFile): NoteInfo  // Uses metadataCache
export function normalizePath(path: string): string
export function getContext(content: string, searchText: string, maxLen?: number): string
```

### MetadataCache Integration

Replace manual frontmatter parsing with Obsidian's built-in cache:

```typescript
// Before (slow - reads file, parses YAML)
const content = await app.vault.read(file);
const { frontmatter } = parseFrontmatter(content);

// After (fast - uses pre-cached metadata)
const cache = app.metadataCache.getFileCache(file);
const frontmatter = cache?.frontmatter || {};
```

Benefits:
- Already cached and updated automatically
- No disk I/O for metadata-only operations
- Consistent parsing across the application

## Performance Optimizations

### Parallel File Operations

Batch file reads instead of sequential awaits:

```typescript
const BATCH_SIZE = 50;
for (let i = 0; i < files.length; i += BATCH_SIZE) {
  const batch = files.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map(async (file) => {
    try {
      const content = await app.vault.read(file);
      // process...
    } catch (err) {
      console.warn(`Skipping ${file.path}:`, err);
    }
  }));
}
```

### MetadataCache for Links

Use pre-computed link data:

```typescript
// Outgoing links (already resolved)
const resolved = app.metadataCache.resolvedLinks[file.path];

// Link metadata from cache
const cache = app.metadataCache.getFileCache(file);
const links = cache?.links || [];      // Wiki/markdown links
const tags = cache?.tags || [];        // Inline #tags
const frontmatter = cache?.frontmatter; // Parsed YAML
```

### Routes Optimized

| Route | Optimization |
|-------|-------------|
| `GET /notes` | metadataCache for frontmatter |
| `GET /tags` | metadataCache.tags + frontmatter.tags |
| `POST /search` | Parallel reads, early exit |
| `GET /notes/:path/backlinks` | metadataCache for link checking |
| `GET /notes/:path/outlinks` | metadataCache.resolvedLinks |
| `GET /graph/neighbors` | metadataCache for both directions |
| `POST /graph/query` | metadataCache + parallel traversal |

## Reliability Improvements

### Request Body Limits

```typescript
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB - generous for local service

private async parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    // ...
  });
}
```

### Request Timeouts

```typescript
const ROUTE_TIMEOUT = 30000; // 30 seconds

private async handleRequest(req, res): Promise<void> {
  const timeout = setTimeout(() => {
    if (!res.writableEnded) {
      this.sendError(res, 504, 'TIMEOUT', 'Request timeout');
    }
  }, ROUTE_TIMEOUT);

  try {
    await this.executeRoute(req, res);
  } finally {
    clearTimeout(timeout);
  }
}
```

### Error Isolation

Individual file errors don't crash entire request:

```typescript
for (const file of files) {
  try {
    // process file...
  } catch (err) {
    console.warn(`Failed to process ${file.path}:`, err);
    continue; // Skip and continue
  }
}
```

### Graceful Shutdown

```typescript
async stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!this.server) {
      resolve();
      return;
    }

    // Stop accepting new connections
    this.server.close(() => resolve());

    // Force close after timeout
    setTimeout(() => {
      this.server?.closeAllConnections?.();
      resolve();
    }, 5000);
  });
}
```

### Enhanced Health Check

```typescript
// GET /health returns more diagnostics
{
  ok: true,
  data: {
    status: "healthy",
    version: VERSION,
    uptime: process.uptime(),
    vault: vault.getName(),
    fileCount: vault.getMarkdownFiles().length
  }
}
```

## File Changes

### Create
- `src/utils.ts` - Shared utilities

### Modify
- `src/server.ts` - Body limits, timeouts, graceful shutdown, health
- `src/routes/notes.ts` - Use utils, metadataCache
- `src/routes/search.ts` - Use utils, parallel reads
- `src/routes/tags.ts` - Use utils, metadataCache.tags
- `src/routes/links.ts` - Use utils, metadataCache.resolvedLinks
- `src/routes/graph.ts` - Use metadataCache, parallel reads
- `src/routes/daily.ts` - Use utils, error isolation
- `src/routes/templates.ts` - Use utils, error isolation

## API Compatibility

All existing endpoints remain unchanged:
- Same routes, methods, parameters
- Same response shapes
- Same auth mechanism

## Expected Impact

- **Performance**: 5-10x faster for metadata-heavy endpoints on vaults with 100+ files
- **Reliability**: Graceful degradation, no hung requests, bounded memory usage
