import type { SpecgitApi } from "../api";
import { AuthError } from "../auth/errors";
import { isRepoName } from "../mapping";
import { FAILED_LIST, LOADING_REPOSITORIES, NO_MATCH, NO_REPOSITORIES, OFFLINE_LIST, SIGNED_OUT_LIST, SLOW_LIST } from "./words";

export type RepoAccess = "writable" | "read_only" | "not_installed";

export interface RepoChoice {
  fullName: string;
  private: boolean;
  access: RepoAccess;

  ownerInstallationId: number | null;
  pushedAt: string | null;
}

export type RepoList = { kind: "ok"; repos: RepoChoice[] } | { kind: "signed_out" | "offline" | "slow" | "failed" };

export const LIST_DEADLINE_MS = 15_000;

const asRecord = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);

function choiceOf(value: unknown): RepoChoice | null {
  const row = asRecord(value);
  if (!row || typeof row.fullName !== "string" || !isRepoName(row.fullName)) return null;
  if (row.accessible === false) return null;
  const pushes = asRecord(row.permissions)?.push === true;
  const app = asRecord(row.app);
  const installed = app?.installed === true;
  return {
    fullName: row.fullName,
    private: row.private === true,
    access: !pushes ? "read_only" : installed ? "writable" : "not_installed",
    ownerInstallationId: typeof app?.ownerInstallationId === "number" ? app.ownerInstallationId : null,
    pushedAt: typeof row.pushedAt === "string" ? row.pushedAt : null,
  };
}

export function listFrom(body: Record<string, unknown>): RepoChoice[] {
  const rows = [body.repos, body.opened].flatMap((part) => (Array.isArray(part) ? (part as unknown[]) : []));
  const seen = new Set<string>();
  const repos: RepoChoice[] = [];
  for (const row of rows) {
    const choice = choiceOf(row);
    if (!choice || seen.has(choice.fullName.toLowerCase())) continue;
    seen.add(choice.fullName.toLowerCase());
    repos.push(choice);
  }
  return repos.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
}

export async function readRepoList(api: Pick<SpecgitApi, "call">, signedIn: () => boolean, deadlineMs = LIST_DEADLINE_MS): Promise<RepoList> {
  if (!signedIn()) return { kind: "signed_out" };
  let timer: number | undefined;
  const slow = new Promise<RepoList>((resolve) => {
    timer = window.setTimeout(() => resolve({ kind: "slow" }), deadlineMs);
  });
  const asked = api
    .call("GET", "/api/repos")
    .then((answer): RepoList => {
      if (answer.status === 401 || answer.status === 403) return { kind: "signed_out" };
      if (answer.status !== 200 || answer.body === null) return { kind: "failed" };
      return { kind: "ok", repos: listFrom(answer.body) };
    })
    .catch((error: unknown): RepoList => ({ kind: error instanceof AuthError && error.code === "signed_out" ? "signed_out" : "offline" }));
  try {
    return await Promise.race([asked, slow]);
  } finally {
    window.clearTimeout(timer);
  }
}

export type Row = { kind: "repo"; repo: RepoChoice } | { kind: "use"; name: string } | { kind: "retry" } | { kind: "onboard" };

export const MAX_ROWS = 100;

export function typedRepository(query: string): string | null {
  const name = query
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return isRepoName(name) ? name : null;
}

export function rowsFor(list: RepoList | null, query: string, onboard = false): Row[] {
  const typed = typedRepository(query);

  const words = (typed ?? query).toLowerCase().split(/\s+/).filter(Boolean);
  const repos = list?.kind === "ok" ? list.repos : [];
  const shown = repos.filter((repo) => words.every((word) => repo.fullName.toLowerCase().includes(word))).slice(0, MAX_ROWS);

  const rows: Row[] = [...(onboard && query.trim() === "" ? [{ kind: "onboard" as const }] : []), ...shown.map((repo): Row => ({ kind: "repo", repo }))];
  if (typed !== null && !repos.some((repo) => repo.fullName.toLowerCase() === typed.toLowerCase())) rows.push({ kind: "use", name: typed });
  if (list !== null && list.kind !== "ok" && list.kind !== "signed_out") rows.push({ kind: "retry" });
  return rows;
}

export function emptyWords(list: RepoList | null, query: string): string {
  if (list === null) return LOADING_REPOSITORIES;
  switch (list.kind) {
    case "signed_out":
      return SIGNED_OUT_LIST;
    case "offline":
      return OFFLINE_LIST;
    case "slow":
      return SLOW_LIST;
    case "failed":
      return FAILED_LIST;
    case "ok":
      return list.repos.length === 0 && query.trim() === "" ? NO_REPOSITORIES : NO_MATCH;
  }
}
