import type { AnchoredThreadView, RevisionView, ThreadComment } from "./threads";

export interface ThreadGroup {
  key: string;
  label: string | null;
  threads: AnchoredThreadView[];
}

export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function groupThreads(threads: readonly AnchoredThreadView[], revisions: readonly RevisionView[] = []): ThreadGroup[] {
  if (!threads.some((t) => t.status)) return threads.length ? [{ key: "all", label: null, threads: [...threads] }] : [];
  const open = threads.filter((t) => !t.resolved);
  const current = threads.filter((t) => t.resolved && t.status !== "resolved_earlier");
  const earlier = new Map<number, AnchoredThreadView[]>();
  for (const t of threads) {
    if (t.status !== "resolved_earlier") continue;
    const pr = t.prNumber ?? 0;
    earlier.set(pr, [...(earlier.get(pr) ?? []), t]);
  }
  const labelled = earlier.size > 0 || (open.length > 0 && current.length > 0);
  const groups: ThreadGroup[] = [];
  if (open.length) groups.push({ key: "open", label: labelled ? "Open" : null, threads: open });
  if (current.length) groups.push({ key: "resolved_current", label: labelled ? "Resolved in this revision" : null, threads: current });
  for (const pr of [...earlier.keys()].sort((a, b) => b - a)) {
    const rev = revisions.find((r) => r.prNumber === pr);
    const when = shortDate(rev?.mergedAt);
    groups.push({
      key: `earlier:${pr}`,
      label: `Resolved earlier · #${pr}${when ? ` (published ${when})` : ""}`,
      threads: earlier.get(pr)!,
    });
  }
  return groups;
}

export function carriedChip(thread: AnchoredThreadView): string | null {
  const segments = thread.segments ?? [];
  if (segments.length < 2 || thread.status === "resolved_earlier") return null;
  const first = segments[0]!;
  const when = shortDate(thread.origin?.createdAt ?? first.date);
  return `carried from #${thread.origin?.prNumber ?? first.prNumber}${when ? ` · ${when}` : ""}`;
}

export function revisionDivider(comments: readonly ThreadComment[], index: number): number | null {
  if (index === 0) return null;
  const prev = comments[index - 1]?.prNumber;
  const cur = comments[index]?.prNumber;
  return prev !== undefined && cur !== undefined && cur !== prev ? cur : null;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface ThreadVersion {
  key: "commented" | "published";
  label: string;
  sha: string;
  path: string;
}

export function threadVersions(thread: AnchoredThreadView, revisions: readonly RevisionView[] = []): ThreadVersion[] {
  const path = thread.origin?.path ?? thread.anchor?.path;
  const sha = thread.origin?.commitSha ?? thread.anchor?.commitSha;
  if (!path) return [];
  const out: ThreadVersion[] = [];
  if (sha && COMMIT_SHA.test(sha)) out.push({ key: "commented", label: "When commented", sha, path });
  const pr = thread.origin?.prNumber ?? thread.segments?.[0]?.prNumber;
  const merged = revisions.find((r) => r.prNumber === pr)?.mergeCommitSha;
  if (pr && merged && COMMIT_SHA.test(merged)) out.push({ key: "published", label: `As published in #${pr}`, sha: merged, path });
  return out;
}
