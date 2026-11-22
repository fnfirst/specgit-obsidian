import type { DocumentRef } from "../mapping";
import { gitBlobShaOfText } from "../changes/blob-sha";
import type { Activity } from "./activity";
import type { StayPorts, StayVault } from "./types";

export function tiedTo(ports: StayPorts, identity: string, now: () => string, documentFor: (path: string) => DocumentRef | null, activity: Activity): StayPorts {
  const live = (): boolean => ports.enabled() && now() === identity;
  const own = <T>(paths: string[], run: () => Promise<T>, left?: (result: T) => Readonly<Record<string, string>> | null): Promise<T> => activity.during(paths, run, left);
  const vault: StayVault = {
    ...ports.vault,
    process: (path, edit, options) => {
      let text: string | null = null;
      return own(
        [path],
        () => ports.vault.process(path, (current) => (text = live() ? edit(current) : null), options),
        (result) => (result === "written" && text !== null ? { [path]: gitBlobShaOfText(text) } : null),
      );
    },
    create: (path, text) =>
      own(
        [path],
        async () => (live() ? ports.vault.create(path, text) : "failed"),
        (result) => (result === "created" ? { [path]: gitBlobShaOfText(text) } : null),
      ),
    rename: (from, to) => {
      let text: string | null = null;
      return own(
        [from, to],
        async () => {
          const moved = live() ? await ports.vault.rename(from, to) : "failed";
          if (moved === "renamed") text = await ports.vault.read(to);
          return moved;
        },
        (result) => (result === "renamed" ? (text === null ? {} : { [to]: gitBlobShaOfText(text) }) : null),
      );
    },
    trash: (path, expectedSha) => own([path], async () => live() && (await ports.vault.trash(path, expectedSha))),
  };
  return {
    ...ports,
    vault,
    documentFor,
    enabled: live,
    copyIn: (files, isCurrent, skipped) => ports.copyIn(files, () => isCurrent() && live(), skipped),
    commit: async (row, isCurrent, hooks) => (live() ? ports.commit(row, () => isCurrent() && live(), hooks) : { result: "retry", writes: 0 }),
  };
}
