import { gitBlobShaOfText } from "../changes/blob-sha";
import { agreedOf } from "../changes/cache";
import type { Looked } from "../changes/model";
import type { Activity } from "./activity";
import { changeKey, isEdit } from "./outbound";
import type { StayData, StayState } from "./state";
import { STAY_HELD } from "./words";

export type HoldReason = NonNullable<StayData["heldWhy"]>[string];

export interface HoldPorts {
  login(): string;
  inGroup(path: string): boolean;
}

export class StayHolds {
  constructor(
    private readonly state: StayState,
    private readonly activity: Activity,
    private readonly ports: HoldPorts,
  ) {}

  holdStopped(path: string, text: string): void {
    (this.state.data.editsHeld ??= {})[path] = gitBlobShaOfText(text);
    (this.state.data.heldWhy ??= {})[path] = "stopped";
    this.state.save();
  }

  holdEdit(looked: Looked, path: string, why: HoldReason): void {
    const sha = looked.files.get(path)?.sha;
    if (sha === undefined) return;
    (this.state.data.editsHeld ??= {})[path] = sha;
    (this.state.data.heldWhy ??= {})[path] = why;
  }

  holdNew(looked: Looked, key: string, path: string, why: HoldReason): void {
    if (!this.state.data.held.includes(key)) this.state.data.held.push(key);
    (this.state.data.heldWhy ??= {})[path] = why;
    const sha = looked.files.get(path)?.sha;
    if (sha !== undefined) (this.state.data.heldShas ??= {})[key] = sha;
  }

  restored(path: string): void {
    const { data } = this.state;
    const key = changeKey({ kind: "new", path });
    if (data.deletedAt) delete data.deletedAt[path];
    if (data.heldWhy?.[path] === "deleted") {
      delete data.heldWhy[path];
      delete data.editsHeld?.[path];
    }
    data.held = data.held.filter((one) => one !== key);
    data.burst = data.burst.filter((one) => one !== key);
    delete data.heldShas?.[key];
  }

  prune(looked: Looked, committed: ReadonlySet<string>, onUnhold: (key: string) => void): void {
    const { data } = this.state;
    for (const [path, sha] of Object.entries(data.editsHeld ?? {})) {
      const entry = looked.files.get(path);
      const draft = looked.drafts?.byPath.get(path);
      const reopened = draft !== undefined && ((draft.by ?? "").toLowerCase() === this.ports.login().toLowerCase() || (entry !== undefined && agreedOf(entry) !== undefined));
      if (data.heldWhy?.[path] === "deleted" && entry !== undefined && data.deletedAt?.[path] !== undefined && draft === undefined && !looked.repo.has(path)) {
        data.editsHeld![path] = entry.sha;
        continue;
      }
      if (data.heldWhy?.[path] === "deleted") delete data.deletedAt?.[path];
      if (data.heldWhy?.[path] === "closedElsewhere" && entry !== undefined && entry.sha !== looked.repo.get(path) && !reopened) {
        data.editsHeld![path] = entry.sha;
        continue;
      }
      if (entry?.sha !== sha || data.heldWhy?.[path] === "closedElsewhere") {
        delete data.editsHeld![path];
        if (data.heldWhy) delete data.heldWhy[path];
      }
    }
    const rowByKey = new Map(looked.rows.map((row) => [changeKey(row.change), row] as const));
    const keptHeld: string[] = [];
    const heldPaths = new Set<string>();
    for (const key of data.held) {
      const row = rowByKey.get(key);
      if (!row) continue;
      const path = row.change.path;
      const entry = looked.files.get(path);
      const heldSha = data.heldShas?.[key];
      const deleted = data.heldWhy?.[path] === "deleted" && data.deletedAt?.[path] !== undefined && !looked.repo.has(path);
      const suspect = this.activity.isSuspect(path);
      if (!deleted && heldSha !== undefined && entry !== undefined && entry.sha !== heldSha && !suspect) {
        delete data.heldShas?.[key];
        onUnhold(key);
        continue;
      }
      if (entry !== undefined && (deleted || heldSha === undefined || suspect)) (data.heldShas ??= {})[key] = entry.sha;
      keptHeld.push(key);
      heldPaths.add(path);
    }
    data.held = keptHeld;
    const keptHeldSet = new Set(keptHeld);
    data.burst = data.burst.filter((key) => keptHeldSet.has(key));
    if (data.heldShas) for (const key of Object.keys(data.heldShas)) if (!keptHeldSet.has(key)) delete data.heldShas[key];
    for (const path of Object.keys(data.heldWhy ?? {})) if (data.editsHeld?.[path] === undefined && !heldPaths.has(path)) delete data.heldWhy![path];
    const own = new Set(
      looked.rows.flatMap((row) => {
        const entry = looked.files.get(row.change.path);
        return isEdit(row, committed) && entry !== undefined && (agreedOf(entry) === undefined || entry.sha !== agreedOf(entry)) ? [row.change.path] : [];
      }),
    );
    for (const path of Object.keys(data.typed ?? {})) if (!own.has(path)) delete data.typed![path];
  }

  why(looked: Looked | null, path: string, on: boolean, attachmentNote: string | null): string | null {
    const { data } = this.state;
    const held = data.editsHeld?.[path];
    const reason = data.heldWhy?.[path] ?? "github";
    const own = held !== undefined && looked?.files.get(path)?.sha === held ? (reason === "closedElsewhere" && looked?.drafts?.byPath.has(path) ? STAY_HELD.closedElsewhereNew : STAY_HELD[reason]) : null;
    const row = own === null ? looked?.rows.find((one) => one.change.path === path && (one.change.kind === "new" || one.change.kind === "renamed")) : undefined;
    const onGithub = row !== undefined && (row.entry !== null || looked?.drafts?.byPath.has(path) === true || looked?.files.get(path)?.sent !== undefined);
    const key = row && !onGithub ? changeKey(row.change) : null;
    const newWhy = data.heldWhy?.[path];
    const heldNew =
      key !== null && data.held.includes(key)
        ? newWhy !== undefined
          ? STAY_HELD[newWhy]
          : data.burst.includes(key)
            ? STAY_HELD.flurry
            : STAY_HELD.held
        : null;
    const baseline = key !== null && heldNew === null && (data.baseline?.includes(key) ?? false) ? STAY_HELD.baseline : null;
    const grouped = on && own === null && heldNew === null && baseline === null && this.ports.inGroup(path) && looked?.drafts?.byPath.get(path)?.inGroup !== true && looked?.rows.some((one) => one.change.path === path && one.change.kind === "edited") === true ? STAY_HELD.group : null;
    const found = on ? (own ?? heldNew ?? baseline ?? grouped) : null;
    const attachments = on ? attachmentNote : null;
    return found !== null && attachments !== null ? `${found} ${attachments}` : (found ?? attachments);
  }
}
