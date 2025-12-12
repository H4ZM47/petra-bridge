// Inlined shared types and constants from @petra/shared

export const VERSION = "0.1.2";

/** Default port for petra-bridge HTTP server */
export const DEFAULT_PORT = 27182;

/** Config directory path */
export const CONFIG_DIR = ".petra";

/** Token file name */
export const TOKEN_FILE = "token";

/** Frontmatter metadata from a note */
export interface NoteFrontmatter {
  title?: string;
  tags?: string[];
  aliases?: string[];
  created?: string;
  modified?: string;
  [key: string]: unknown;
}

/** A note with its content and metadata */
export interface Note {
  /** Path relative to vault root, without .md extension */
  path: string;
  /** Note title (from frontmatter or filename) */
  title: string;
  /** Raw markdown content (without frontmatter) */
  content: string;
  /** Parsed frontmatter */
  frontmatter: NoteFrontmatter;
  /** Full raw content including frontmatter */
  raw: string;
}

/** Minimal note info for listings */
export interface NoteInfo {
  path: string;
  title: string;
  tags: string[];
  created?: string;
  modified?: string;
}

/** API response wrapper */
export interface ApiResponse<T> {
  ok: true;
  data: T;
}

/** API error response */
export interface ApiError {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
  };
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

/** Error codes */
export type ErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "INVALID_PATH"
  | "VAULT_NOT_SET"
  | "BRIDGE_UNAVAILABLE"
  | "BRIDGE_ERROR"
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "INTERNAL_ERROR";

/** A match found in search */
export interface SearchMatch {
  /** Line number (1-indexed) */
  line: number;
  /** The matched line text */
  text: string;
}

/** Search result for a note */
export interface SearchResult {
  /** The note's metadata */
  note: NoteInfo;
  /** Array of matches found in the note */
  matches: SearchMatch[];
}
