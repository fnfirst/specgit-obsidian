import type { BlobsAnswer, AttachmentFile, MainFile } from "../auth/git-copy";
import { type DocumentRef, isHiddenPath, noteName } from "../mapping";
import { gitBlobSha, gitBlobShaOfText } from "./blob-sha";
import { attachmentLinks, attachmentTarget } from "./attachment-links";
import { type LeftOut, leftOutKinds, leftOutTotal } from "./left-out";
import { leftOutWords } from "../pick/words";

export interface CopyInFile {
  path: string;
  doc: DocumentRef;
  sha?: string | null;
}

export interface CopyInOptions {

  commit?: string | null;

  others?: readonly string[];

  attachments?: ReadonlyMap<string, string>;

  top?: string;
}

export interface CopyInPorts {

  gitFile(doc: DocumentRef, at?: string | null): Promise<MainFile>;

  gitBlobs?(repo: string, commit: string, files: ReadonlyArray<{ sha: string; path: string }>): Promise<BlobsAnswer>;

  gitAttachment?(repo: string, at: string | null, path: string): Promise<AttachmentFile>;

  create(path: string, text: string): Promise<"created" | "exists" | "failed">;

  agreed?(repoPath: string, sha: string): void;

  createBinary?(path: string, bytes: ArrayBuffer): Promise<"created" | "exists" | "failed">;

  recordBase?(file: CopyInFile, text: string, sha: string): void;

  checkpoint?(): void;

  vaultPaths(): Iterable<string>;

  notWritten(path: string): void;

  during<T>(paths: string[], run: () => Promise<T>, left?: (result: T) => Readonly<Record<string, string>> | null): Promise<T>;

  blockedFor(): number;
  pause(ms: number): Promise<void>;
  clock(): number;

  current(): boolean;
  progress(done: number, total: number): void;
}

export interface CopyInResult {
  created: number;

  attachments: number;

  existed: number;

  gone: number;

  left: number;

  unreadable: string[];

  skipped: string[];

  leftOut: LeftOut;

  stopped: "slow" | "unreadable" | "unloaded" | null;
}

export const COPY_AT_ONCE = 4;

export const FILES_PER_BATCH = 50;

export const BATCHES_AT_ONCE = 2;

export const COPY_SLICE_MS = 12;

export const PROGRESS_EVERY_MS = 250;

export const CHECKPOINT_EVERY_MS = 5_000;

export async function copyIn(ports: CopyInPorts, files: readonly CopyInFile[], skipped: readonly string[] = [], options: CopyInOptions = {}): Promise<CopyInResult> {
  const result: CopyInResult = { created: 0, attachments: 0, existed: 0, gone: 0, left: 0, unreadable: [], skipped: [...skipped], leftOut: leftOutKinds(options.others ?? []), stopped: null };
  const commit = options.commit ?? null;
  const there = new Set([...ports.vaultPaths()].map((path) => path.toLowerCase()));
  let done = 0;
  let told = Number.NEGATIVE_INFINITY;
  let savedAt = ports.clock();

  const checkpoint = (final = false): void => {
    if (!final && ports.clock() - savedAt < CHECKPOINT_EVERY_MS) return;
    ports.checkpoint?.();
    savedAt = ports.clock();
  };
  let sliceStart = ports.clock();

  const shown: Array<{ note: string; links: string[] }> = [];
  const wantAttachments = (options.attachments?.size ?? 0) > 0 && ports.gitAttachment !== undefined && ports.createBinary !== undefined;
  const tell = (final = false): void => {
    if (!final && ports.clock() - told < PROGRESS_EVERY_MS) return;
    told = ports.clock();
    ports.progress(done, files.length);
  };
  const slice = async (): Promise<void> => {
    if (ports.clock() - sliceStart >= COPY_SLICE_MS) {
      await ports.pause(0);
      sliceStart = ports.clock();
    }
  };

  const mayGoOn = (): boolean => {
    if (result.stopped !== null) return false;
    if (!ports.current()) {
      result.stopped = "unloaded";
      return false;
    }
    if (ports.blockedFor() > 0) {
      result.stopped = "slow";
      return false;
    }
    return true;
  };

  const land = async (file: CopyInFile, key: string, main: MainFile): Promise<"done" | "skip" | "unloaded"> => {
    if (main.kind === "unreadable") {
      there.delete(key);

      if (main.outage) result.stopped = "unreadable";
      else result.unreadable.push(file.path);
      return "skip";
    }
    if (main.kind === "absent") {
      there.delete(key);
      result.gone++;
      return "done";
    }
    if (!ports.current()) {
      there.delete(key);
      result.stopped = "unloaded";
      return "unloaded";
    }
    const made = await ports.during([file.path], () => ports.create(file.path, main.text), (result) => (result === "created" ? { [file.path]: gitBlobShaOfText(main.text) } : null));
    if (made === "created") {
      result.created++;
      ports.recordBase?.(file, main.text, main.sha);
      if (wantAttachments) shown.push({ note: file.path, links: attachmentLinks(main.text) });
    } else {
      ports.notWritten(file.path);
      if (made === "exists") result.existed++;
      else {
        there.delete(key);
        return "skip";
      }
    }
    return "done";
  };

  const pending: CopyInFile[] = [];
  for (const file of files) {
    if (isHiddenPath(file.path)) {

      done++;
    } else if (there.has(file.path.toLowerCase())) {
      result.existed++;
      done++;
    } else pending.push(file);
  }
  tell();

  const alone: CopyInFile[] = [];
  const batchable = commit !== null && ports.gitBlobs !== undefined ? pending.filter((file) => file.sha) : [];
  const batched = new Set(batchable);
  for (const file of pending) if (!batched.has(file)) alone.push(file);
  if (batchable.length > 0) {
    const batches: CopyInFile[][] = [];
    for (let i = 0; i < batchable.length; i += FILES_PER_BATCH) batches.push(batchable.slice(i, i + FILES_PER_BATCH));
    let nextBatch = 0;
    let routeMissing = false;

    let batchOutages = 0;
    const runBatches = async (): Promise<void> => {
      while (mayGoOn()) {
        const batch = batches[nextBatch++];
        if (!batch) return;
        if (routeMissing) {
          alone.push(...batch);
          continue;
        }

        const taken: Array<{ file: CopyInFile; key: string }> = [];
        for (const file of batch) {
          const key = file.path.toLowerCase();
          if (there.has(key)) {
            result.existed++;
            done++;
          } else {
            there.add(key);
            taken.push({ file, key });
          }
        }
        if (taken.length === 0) continue;
        const answer = await ports.gitBlobs!(taken[0]!.file.doc.repo, commit!, taken.map(({ file }) => ({ sha: file.sha!, path: file.doc.path })));
        if (answer.kind === "outage") {

          for (const { key } of taken) there.delete(key);
          if (++batchOutages > 1) {
            result.stopped = "unreadable";
            return;
          }
          alone.push(...taken.map(({ file }) => file));
          continue;
        }
        if (answer.kind === "missing") {
          routeMissing = true;
          for (const { file, key } of taken) {
            there.delete(key);
            alone.push(file);
          }
          continue;
        }
        for (const { file, key } of taken) {
          const read = answer.files.get(file.sha!);
          if (read?.kind !== "text") {

            there.delete(key);
            alone.push(file);
            continue;
          }
          const landed = await land(file, key, { kind: "file", text: read.text, sha: file.sha! });
          if (landed === "unloaded") return;
          if (landed === "done") done++;
          tell();
          await slice();
        }
        checkpoint();
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCHES_AT_ONCE, batches.length) }, runBatches));
  }
  let next = 0;
  const work = async (): Promise<void> => {
    while (mayGoOn()) {
      const file = alone[next++];
      if (!file) return;
      const key = file.path.toLowerCase();
      if (there.has(key)) {
        result.existed++;
        done++;
      } else {

        there.add(key);
        const landed = await land(file, key, await ports.gitFile(file.doc, commit));
        if (landed === "unloaded") return;
        if (landed === "skip") continue;
        done++;
        checkpoint();
      }
      tell();
      await slice();
    }
  };
  if (result.stopped === null) await Promise.all(Array.from({ length: Math.min(COPY_AT_ONCE, alone.length) }, work));

  const copiedAttachments = new Set<string>();
  if (wantAttachments && result.stopped === null && shown.length > 0) {
    const attachments = options.attachments!;
    const candidates = [...attachments.keys()];
    const wanted = new Map<string, string>();
    for (const { note, links } of shown) {
      for (const link of links) {
        const target = attachmentTarget(link, note, candidates, options.top ?? "");
        const repoPath = target === null ? undefined : attachments.get(target);
        if (target !== null && repoPath !== undefined && !wanted.has(target)) wanted.set(target, repoPath);
      }
    }
    const queue = [...wanted];
    let at = 0;
    const bring = async (): Promise<void> => {
      while (mayGoOn()) {
        const one = queue[at++];
        if (!one) return;
        const [path, repoPath] = one;
        const key = path.toLowerCase();
        if (there.has(key)) continue;
        there.add(key);
        const read = await ports.gitAttachment!(files[0]?.doc.repo ?? "", commit, repoPath);
        if (read.kind !== "bytes") {
          there.delete(key);

          if (read.kind === "unreadable" && read.outage) result.stopped = "unreadable";
          continue;
        }
        const made = await ports.during([path], () => ports.createBinary!(path, read.bytes));
        if (made === "created") {
          ports.agreed?.(repoPath, await gitBlobSha(read.bytes));
          result.attachments++;
          copiedAttachments.add(path);
        } else {
          ports.notWritten(path);
          if (made === "failed") there.delete(key);
        }
        await slice();
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_AT_ONCE, queue.length) }, bring));
  }
  checkpoint(true);
  result.leftOut = leftOutKinds((options.others ?? []).filter((path) => !copiedAttachments.has(path)));

  result.left = files.length - result.created - result.existed - result.gone - files.filter((file) => isHiddenPath(file.path)).length;
  tell(true);
  return result;
}

const named = (paths: readonly string[]): string => {
  const names = paths.slice(0, 3).map(noteName);
  return paths.length > 3 ? `${names.join(", ")} and ${paths.length - 3} more` : names.join(", ");
};

export function copiedWords(result: CopyInResult): string {
  const notes = (count: number): string => (count === 1 ? "1 note" : `${count} notes`);
  const parts: string[] = [];
  if (result.created > 0) parts.push(`Copied ${notes(result.created)}${result.attachments > 0 ? ` and ${result.attachments === 1 ? "1 file" : `${result.attachments} files`}` : ""} into your vault.`);
  else if (result.left === 0 && result.skipped.length === 0) parts.push("Nothing needed copying.");
  if (result.unreadable.length > 0) parts.push(`${named(result.unreadable)} couldn't be read, so ${result.unreadable.length === 1 ? "it was" : "they were"} left out.`);
  if (result.skipped.length > 0) parts.push(`${named(result.skipped)} ${result.skipped.length === 1 ? "was" : "were"} left out: another note has the same name in different capitals.`);
  const unreached = result.left - result.unreadable.length;
  if (unreached > 0 && result.stopped !== null) {
    const why = result.stopped === "slow" ? "GitHub asked specgit to slow down" : result.stopped === "unloaded" ? "copying was stopped" : "specgit couldn't read them just now";
    parts.push(`${notes(unreached)} ${unreached === 1 ? "wasn't" : "weren't"} copied because ${why}. The Status tab offers them again.`);
  }
  if (leftOutTotal(result.leftOut) > 0) parts.push(leftOutWords(result.leftOut));
  return parts.join(" ");
}
