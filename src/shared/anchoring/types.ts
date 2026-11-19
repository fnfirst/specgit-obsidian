export interface Anchor {
  path: string;
  lineStart: number;
  lineEnd: number;
  quotedText: string;
  prefix: string;
  suffix: string;
  commitSha: string;

  exactText?: string;

  outdated?: boolean;
}

export type ReanchorStatus = "exact" | "fuzzy" | "outdated";

export interface ReanchorResult {
  status: ReanchorStatus;
  lineStart: number;
  lineEnd: number;

  confidence: number;
}

export type CommentStrategy = "line" | "file" | "issue";
