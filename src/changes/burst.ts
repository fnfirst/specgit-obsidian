import { BURST_RESEND_CODE, burstBytes, burstWrites, GROUP_UPLOAD_CHUNK_BYTES, GROUP_UPLOAD_MAX_FILES, isBurstUnavailable, type BurstFile, type BurstLeftOut, type BurstLeftWhy } from "../shared/review-flow";
import type { ChangeRow } from "./model";
import { ATTACHMENT_REQUEST_BYTES, type NamedAttachment } from "./attachment-send";
import { isLostAnswerResult, type StepResult } from "../review/review-api";

export const BURST_FROM = 20;

export const WRITES_PER_FILE = 4;

export function groupWrites(files: number, bytes: number): number {

  const burst = burstWrites(Math.max(Math.ceil(files / GROUP_UPLOAD_MAX_FILES), Math.ceil(bytes / GROUP_UPLOAD_CHUNK_BYTES)) + (bytes > GROUP_UPLOAD_CHUNK_BYTES ? 1 : 0));
  return files <= BURST_FROM ? burst + files : burst;
}

export type LeftOutWhy = BurstLeftWhy | "rename";

export interface LeftOut {
  path: string;
  why: LeftOutWhy;
}

export interface BurstPick {
  row: ChangeRow;
  base: string | null;
}

export function planBurst(rows: readonly ChangeRow[]): { send: BurstPick[]; left: LeftOut[] } {
  const send: BurstPick[] = [];
  const left: LeftOut[] = [];
  for (const row of rows) {
    if (row.change.kind === "deleted") continue;
    if (row.change.kind === "renamed") left.push({ path: row.change.path, why: "rename" });
    else if (row.review?.reviewBranch || row.review?.pr || row.entry) left.push({ path: row.change.path, why: "review" });
    else if (row.change.mainMoved || (row.change.kind !== "new" && row.change.repoSha !== null && row.change.base !== row.change.repoSha)) left.push({ path: row.change.path, why: "main" });
    else send.push({ row, base: row.change.kind === "new" ? null : row.change.base });
  }
  return { send, left };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function leftOutWords(left: readonly LeftOut[]): string | null {
  if (left.length === 0) return null;
  const review = left.filter((one) => one.why === "review").length;
  const renamed = left.filter((one) => one.why === "rename").length;
  const grouped = left.filter((one) => one.why === "grouped").length;
  const main = left.length - review - renamed - grouped;
  const reasons = [
    review > 0 ? `${plural(review, "already has a review of its own", "already have reviews of their own")}` : null,
    main > 0 ? `${plural(main, "changed on GitHub after you last had it", "changed on GitHub after you last had them")}` : null,
    renamed > 0 ? `${plural(renamed, "was renamed here", "were renamed here")}` : null,
    grouped > 0 ? `${plural(grouped, "is in another group", "are in other groups")}` : null,
  ].filter((one): one is string => one !== null);
  return `${plural(left.length, "file wasn't", "files weren't")} grouped: ${reasons.join(", and ")}. Nothing was lost.`;
}

export function burstParts(files: readonly BurstFile[], limit = GROUP_UPLOAD_CHUNK_BYTES): BurstFile[][] {
  const parts: BurstFile[][] = [];
  let part: BurstFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = burstBytes([file]);
    if (part.length > 0 && (bytes + size > limit || part.length >= GROUP_UPLOAD_MAX_FILES)) {
      parts.push(part);
      part = [];
      bytes = 0;
    }
    part.push(file);
    bytes += size;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

export interface BurstPartPlan {
  files: readonly BurstFile[];

  attachments?: readonly NamedAttachment[];

  named?: readonly NamedAttachment[];
}

export function attachmentGroups(attachments: readonly NamedAttachment[], budget = ATTACHMENT_REQUEST_BYTES): NamedAttachment[][] {
  const groups: NamedAttachment[][] = [];
  let open: NamedAttachment[] | null = null;
  let bytes = 0;
  for (const attachment of attachments) {
    if (attachment.base64.length > budget) {
      groups.push([attachment]);
      continue;
    }
    if (open === null || bytes + attachment.base64.length > budget) {
      open = [];
      bytes = 0;
      groups.push(open);
    }
    open.push(attachment);
    bytes += attachment.base64.length;
  }
  return groups;
}

export function planBurstParts(files: readonly BurstFile[], attachmentsOf: ReadonlyMap<string, readonly NamedAttachment[]>): BurstPartPlan[] {
  const seen = new Set<string>();
  const plan: BurstPartPlan[] = [];
  for (const part of burstParts(files)) {
    const fresh = part.flatMap((file) => attachmentsOf.get(file.path) ?? []).filter((attachment) => {
      const key = `${attachment.repoPath}\n${attachment.sha}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const groups = attachmentGroups(fresh);
    const last = groups.at(-1);

    const rides = last !== undefined && burstBytes(part) + last.reduce((n, attachment) => n + attachment.base64.length, 0) <= ATTACHMENT_REQUEST_BYTES;
    for (const group of rides ? groups.slice(0, -1) : groups) plan.push({ files: [], attachments: group });
    plan.push({ files: part, ...(rides ? { attachments: last } : {}) });
  }
  return plan;
}

export function newUploadId(random: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `up-${Array.from({ length: 20 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("")}`;
}

export type BurstSent = { ok: true; id?: string; left: BurstLeftOut[] } | { ok: false; result: Extract<StepResult, { ok: false }> };

const RESENDS = 3;

export const CONFLICT_WAITS_MS: readonly number[] = [2_000, 5_000, 10_000];

export const UNAVAILABLE_WAITS_MS: readonly number[] = [3_000, 8_000, 20_000, 45_000];

export async function sendBurst(
  upload: (part: { uploadId: string; last: boolean; files: readonly BurstFile[]; attachments?: readonly NamedAttachment[]; named?: readonly NamedAttachment[] }) => Promise<StepResult>,
  parts: readonly (readonly BurstFile[] | BurstPartPlan)[],
  uploadId: string,
  wait: (ms: number) => Promise<void> = async () => undefined,

  options: { last?: boolean; onAnswer?: (body: Record<string, unknown>) => void } = {},
): Promise<BurstSent> {
  let id: string | undefined;
  let left: BurstLeftOut[] = [];
  for (const [i, one] of parts.entries()) {
    const { files, attachments, named } = Array.isArray(one) ? { files: one as readonly BurstFile[], attachments: undefined, named: undefined } : (one as BurstPartPlan);
    const last = options.last !== false && i === parts.length - 1;
    const send = () => upload({ uploadId, last, files, ...(attachments && attachments.length > 0 ? { attachments } : {}), ...(named && named.length > 0 ? { named } : {}) });
    let answer = await send();
    let lost = 0;
    let behind = 0;
    let down = 0;
    while (!answer.ok) {
      if (isLostAnswerResult(answer) && lost < RESENDS) lost += 1;
      else if (answer.code === BURST_RESEND_CODE && behind < CONFLICT_WAITS_MS.length) await wait(CONFLICT_WAITS_MS[behind++]!);
      else if (isBurstUnavailable(answer) && down < UNAVAILABLE_WAITS_MS.length) await wait(UNAVAILABLE_WAITS_MS[down++]!);
      else break;
      answer = await send();
    }
    if (!answer.ok) return { ok: false, result: answer };
    options.onAnswer?.(answer.body);
    if (typeof answer.body.id === "string") id = answer.body.id;
    if (Array.isArray(answer.body.left)) left = answer.body.left as BurstLeftOut[];
  }
  return { ok: true, ...(id ? { id } : {}), left };
}
