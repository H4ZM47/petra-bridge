# Petra Bridge

An Obsidian plugin that exposes an HTTP API for the Petra CLI, enabling AI agents and automation tools to interact with your vault.

## Features

- **HTTP API** - RESTful endpoints for vault operations
- **Note Management** - Create, read, update, delete notes
- **Search** - Full-text search across your vault
- **Daily Notes** - Create and manage daily notes
- **Tags** - List and search by tags
- **Links** - Query backlinks and outlinks
- **Graph** - Traverse the link graph
- **Templates** - Execute templates programmatically

## Installation

### From Community Plugins (Recommended)

1. Open Obsidian Settings
2. Go to Community Plugins
3. Search for "Petra Bridge"
4. Click Install, then Enable

### Manual Installation

1. Download the latest release from [GitHub Releases](https://github.com/H4ZM47/petra-bridge/releases)
2. Extract files to your vault's `.obsidian/plugins/petra-bridge/` folder
3. Enable the plugin in Obsidian Settings > Community Plugins

## Usage

The plugin starts an HTTP server on `localhost:27182` when enabled.

### Authentication

On first run, a token is generated at `~/.petra/token`. All API requests (except `/health`) require this token:

```bash
TOKEN=$(cat ~/.petra/token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:27182/vault
```

### API Endpoints

#### Health Check
```
GET /health
```

#### Vault Info
```
GET /vault
```

#### Notes
```
GET    /notes              # List notes
POST   /notes              # Create note
GET    /notes/:path        # Read note
PUT    /notes/:path        # Update note
DELETE /notes/:path        # Delete note
POST   /notes/:path/move   # Move/rename note
GET    /notes/:path/backlinks  # Get backlinks
GET    /notes/:path/outlinks   # Get outlinks
```

#### Search
```
POST /search
Body: { "query": "keyword", "folder": "optional", "limit": 20, "caseSensitive": false }
```

#### Tags
```
GET /tags                  # List all tags with counts
GET /tags/:tag/notes       # Get notes with tag
```

#### Daily Notes
```
POST /daily                # Create daily note
GET  /daily/:date          # Get daily note (date: YYYY-MM-DD, "today", "yesterday", "tomorrow")
GET  /daily                # List recent daily notes
```

#### Graph
```
POST /graph/query          # Query link graph
GET  /graph/neighbors/:path  # Get immediate neighbors
```

#### Templates
```
GET  /templates            # List available templates
POST /templates/:name/run  # Execute template
Body: { "destination": "path/to/new-note", "variables": { "key": "value" } }
```

## Using with Petra CLI

This plugin is designed to work with the [Petra CLI](https://github.com/H4ZM47/petra-bridge). The CLI provides a convenient command-line interface for all API operations:

```bash
petra note list
petra note search "query"
petra note backlinks "path/to/note"
petra graph neighbors "path/to/note"
```

## Security

- The server binds to `127.0.0.1` only (localhost)
- All endpoints (except `/health`) require authentication
- Token is stored with restrictive permissions (`0600`)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Development mode (watch)
npm run dev

# Type check
npm run typecheck
```

## License

MIT
