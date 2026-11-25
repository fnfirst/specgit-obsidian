import { gitBlobShaOfText } from "../changes/blob-sha";
import { agreedOf } from "../changes/cache";
import type { Looked } from "../changes/model";
import { unchangedHere } from "../changes/unchanged-here";
import { toLf } from "../disk/line-endings";
import type { NotePhase } from "../status";
import type { StayState } from "./state";

export const roomShas = (text: string): string[] => {
  const lf = toLf(text);
  const lfSha = gitBlobShaOfText(lf);
  const crlfSha = gitBlobShaOfText(lf.replace(/\n/g, "\r\n"));
  return crlfSha === lfSha ? [lfSha] : [lfSha, crlfSha];
};

export class RoomWrites {
  constructor(
    private readonly state: StayState,
    private readonly onChange: () => void,
  ) {}

  record(path: string, text: string | null): void {
    if (text === null) {
      if (this.state.data.roomWrote?.[path] !== undefined) {
        delete this.state.data.roomWrote[path];
        this.onChange();
      }
      return;
    }
    (this.state.data.roomWrote ??= {})[path] = roomShas(text);
    delete this.state.data.typed?.[path];
    this.onChange();
  }

  has(path: string): boolean {
    return (this.state.data.roomWrote?.[path]?.length ?? 0) > 0;
  }

  matches(path: string, sha: string | undefined): boolean {
    return sha !== undefined && this.state.data.roomWrote?.[path]?.includes(sha) === true;
  }

  matchesPair(path: string, diskSha: string, draftBlob: string): boolean {
    const shas = this.state.data.roomWrote?.[path];
    return shas !== undefined && shas.includes(diskSha) && shas.includes(draftBlob);
  }

  hasLocalEdit(looked: Looked | null, path: string, text: string): boolean {
    const entry = looked?.files.get(path);
    if (!entry || entry.base === null) return false;
    const shas = roomShas(text);
    if (shas.includes(entry.base)) return false;
    if (unchangedHere(entry) && shas.includes(entry.sha)) return false;
    const agreed = agreedOf(entry);
    if (agreed !== undefined && shas.includes(agreed)) return false;
    if (shas.some((sha) => this.matches(path, sha))) return false;
    return true;
  }

  renamed(from: string, to: string): void {
    const wrote = this.state.data.roomWrote;
    if (!wrote || from === to || wrote[from] === undefined) return;
    wrote[to] = wrote[from];
    delete wrote[from];
    this.onChange();
  }

  prune(looked: Looked, phaseOf: (path: string) => NotePhase): void {
    const wrote = this.state.data.roomWrote;
    if (!wrote) return;
    let changed = false;
    for (const [path, shas] of Object.entries(wrote)) {
      if (phaseOf(path) !== "local") continue;
      const entry = looked.files.get(path);
      const repoSha = looked.repo.get(path);
      const matchesRemote = entry !== undefined && shas.includes(entry.sha);
      const clear =
        !entry ||
        agreedOf(entry) === entry.sha ||
        (matchesRemote && entry.sha === repoSha) ||
        (!matchesRemote && entry.sha !== entry.base && entry.sha !== repoSha);
      if (!clear) continue;
      delete wrote[path];
      changed = true;
    }
    if (changed) this.onChange();
  }
}
