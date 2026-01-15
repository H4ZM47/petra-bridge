import { App } from "obsidian";
import { DEFAULT_PORT, VERSION } from "./shared";
import type { ApiResponse, ApiError, ErrorCode } from "./shared";

// Node's http and crypto are available in Obsidian desktop
import * as http from "http";
import { timingSafeEqual } from "crypto";

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const ROUTE_TIMEOUT = 30000; // 30 seconds

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  body: unknown
) => Promise<void>;

export interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class PetraServer {
  private server: http.Server | null = null;
  private routes: Route[] = [];
  private authToken: string | null = null;

  constructor(public readonly app: App) {}

  /** Set the auth token for request validation */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /** Register a route */
  route(method: string, path: string, handler: RouteHandler): void {
    // Convert path pattern like /notes/:path to regex
    const paramNames: string[] = [];
    const pattern = path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });

    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler,
    });
  }

  /** Start the HTTP server */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // Restrict CORS to Obsidian app and localhost origins only
        // This prevents malicious websites from making cross-origin requests
        const origin = req.headers.origin;
        const allowedOrigins = ["app://obsidian.md", "http://localhost", "http://127.0.0.1"];
        if (origin && allowedOrigins.some(allowed => origin.startsWith(allowed))) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        }

        // Handle preflight
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        this.handleRequest(req, res).catch((err) => {
          this.sendError(res, 500, "INTERNAL_ERROR", String(err));
        });
      });

      this.server.on("error", reject);
      this.server.listen(DEFAULT_PORT, "127.0.0.1", () => {
        resolve();
      });
    });
  }

  /** Stop the server */
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

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://127.0.0.1:${DEFAULT_PORT}`);
    const path = url.pathname;
    const method = req.method || "GET";

    // Health check - minimal info without auth, full info with auth
    if (path === "/health" && method === "GET") {
      // Basic health (no sensitive info) for unauthenticated requests
      if (!this.checkAuth(req)) {
        this.sendJson(res, {
          ok: true,
          data: { status: "healthy" },
        });
        return;
      }
      // Full health info only for authenticated requests
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

  private checkAuth(req: http.IncomingMessage): boolean {
    if (!this.authToken) return true; // No token set = no auth required

    const authHeader = req.headers.authorization;
    if (!authHeader) return false;

    const [type, token] = authHeader.split(" ");
    if (type !== "Bearer" || !token) return false;

    // Use timing-safe comparison to prevent side-channel attacks
    try {
      const tokenBuf = Buffer.from(token, "utf8");
      const authBuf = Buffer.from(this.authToken, "utf8");
      if (tokenBuf.length !== authBuf.length) return false;
      return timingSafeEqual(tokenBuf, authBuf);
    } catch {
      return false;
    }
  }

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

  /** Send JSON response */
  sendJson<T>(res: http.ServerResponse, data: ApiResponse<T>): void {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(data));
  }

  /** Send error response */
  sendError(
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string
  ): void {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(status);
    const error: ApiError = { ok: false, error: { code: code as ErrorCode, message } };
    res.end(JSON.stringify(error));
  }
}
