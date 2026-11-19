import type { CatchUpPreview, ItemOutcome } from "../shared/review-flow";
import { groupControls, heldWords, HOLD_PICKS, ENDING_STOP } from "../shared/review-flow";
import type { ActionAnswer, ConfirmQuestion, PanelAction, StatusNotice, StatusReviewer } from "../shared/status-panel";
import type { BroughtDraft } from "../changes/bring-in";
import { groupableRows } from "../changes/group-flows";
import type { ChangeRow } from "../changes/model";
import type { ChangesFlows } from "../changes/flows";
import type { NoteChoice } from "../changes/awareness";
import type { Reviewer } from "../review/review-api";
import { sameLogin } from "../shared/review-flow";
import { comparedOf, type VaultFile } from "../changes/vault-state";
import type { Units } from "./panel-model";
import { groupId } from "./panel-model";

export type StatusFlows = Pick<
  ChangesFlows,
  | "showRowChanges"
  | "showVaultView"
  | "moveBackToDraft"
  | "abandon"
  | "abandonGroup"
  | "discard"
  | "publish"
  | "submit"
  | "approve"
  | "askForChanges"
  | "addReviewer"
  | "submitPlan"
  | "createGroup"
  | "addToGroup"
  | "takeOut"
  | "ungroup"
  | "stopEnding"
  | "resolveGroup"
  | "renameGroup"
  | "preview"
  | "settleFromMain"
>;

export interface StatusPorts {
  flows: StatusFlows;

  units: () => Units;

  active: () => string | null;

  choice: (path: string) => NoteChoice | undefined;

  inVault: (path: string) => boolean;
  openNote: (path: string) => void;

  openInSpecgit: (path: string) => void;

  openNoteInSpecgit: (path: string) => void;
  openUrl: (url: string) => void;

  join: (path: string) => void;
  connect: (path: string) => void;
  disconnect: (path: string) => void;
  copyLink: (path: string) => void;

  copyIn: () => Promise<void>;

  moveHeldDeletes: () => void;
  addOffered: () => void;

  vaultFile: (path: string) => VaultFile | undefined;

  bringInNewer: () => Promise<unknown>;
  bringInDraft: (path: string) => Promise<BroughtDraft>;

  showSince: (path: string, on: boolean) => void;

  ask: (question: ConfirmQuestion) => Promise<string>;
  confirmCatchUp: (row: ChangeRow, preview: CatchUpPreview | null) => Promise<boolean>;

  editGroup: (id: string | null) => void;
  setReviewers: (next: (was: readonly StatusReviewer[]) => readonly StatusReviewer[]) => void;
  setNotice: (notice: StatusNotice | null) => void;

  done: (step: "submit" | "publish", id: string) => boolean;

  refresh: () => Promise<void>;

  busy: () => boolean;

  toast: (title: string, description?: string) => void;

  notBrought: string;
}

const asReviewer = (one: Reviewer): StatusReviewer => ({ login: one.login, ...(one.avatarUrl ? { avatarUrl: one.avatarUrl } : {}) });

const rowsOf = (units: Units, ids: readonly string[]): ChangeRow[] => ids.flatMap((id) => units.rows.get(id) ?? []);

function pinnedUnit(ports: StatusPorts): ChangeRow | undefined {
  const path = ports.active();
  if (path === null) return undefined;
  const units = ports.units();
  return units.rows.get(path) ?? [...units.rows.values()].find((row) => row.group?.files.some((file) => file.path === path));
}

function noticeOf(did: NonNullable<StatusNotice["did"]>, results: ReadonlyArray<{ id: string; ok: boolean }>): StatusNotice {
  const needs = results.filter((one) => !one.ok).map((one) => one.id);
  return { done: results.length - needs.length, did, needs: needs.length, ...(needs.length > 0 ? { ids: needs } : {}) };
}

const keyOf = (row: ChangeRow): string => (row.group ? groupId(row.group.id) : row.change.path);

async function bulk(ports: StatusPorts, rows: readonly ChangeRow[], step: "submit" | "publish", run: () => Promise<unknown>): Promise<void> {
  await run();
  if (rows.length < 2) return;
  const did = step === "submit" ? "submitted" : "published";
  ports.setNotice(noticeOf(did, rows.map((row) => ({ id: keyOf(row), ok: ports.done(step, keyOf(row)) }))));
}

async function chooseForGroup(ports: StatusPorts, card: ChangeRow): Promise<void> {
  const overview = card.group!.overview;
  const controls = groupControls(overview);

  const picks = ports.busy() ? { mine: false, theirs: false } : controls.picks;
  const choices = [
    ...(picks.mine ? [{ id: "mine", label: HOLD_PICKS.mine, primary: true }] : []),
    ...(picks.theirs ? [{ id: "theirs", label: HOLD_PICKS.theirs }] : []),
    ...(controls.stop ? [{ id: "stop", label: ENDING_STOP, ...(picks.mine ? {} : { primary: true }) }] : []),
  ];
  if (choices.length === 0) return;
  const picked = await ports.ask({ title: card.group!.held?.words ?? heldWords(overview) ?? card.group!.overview.name, choices });
  if (picked === "mine" || picked === "theirs") await ports.flows.resolveGroup(card, picked);
  else if (picked === "stop") await ports.flows.stopEnding(card);
}

async function chooseForNote(ports: StatusPorts, path: string, row: ChangeRow | undefined): Promise<void> {
  const choice = ports.choice(path);
  if (choice) return choice.run();
  if (row) await ports.flows.settleFromMain(row);
}

async function catchUp(ports: StatusPorts, row: ChangeRow | undefined): Promise<void> {
  if (!row) return;
  const preview = await ports.flows.preview(row.doc);

  if (await ports.confirmCatchUp(row, preview)) await ports.flows.settleFromMain(row, { asked: true });
}

async function approve(ports: StatusPorts, rows: readonly ChangeRow[]): Promise<void> {
  const outcomes: ItemOutcome[] = await ports.flows.approve(rows);
  if (rows.length < 2 || outcomes.length === 0) return;
  ports.setNotice(noticeOf("approved", rows.map((row, at) => ({ id: keyOf(row), ok: outcomes[at]?.status === "done" }))));
}

export async function runAction(action: PanelAction, ports: StatusPorts): Promise<ActionAnswer> {
  const { flows } = ports;
  const units = ports.units();
  switch (action.type) {
    case "row": {
      const row = units.rows.get(action.id);
      switch (action.action) {
        case "open":
        case "review":

          return ports.inVault(action.id) ? ports.openNote(action.id) : ports.openInSpecgit(action.id);
        case "join":
          return ports.join(action.id);
        case "show-changes": {

          const file = ports.vaultFile(action.id);
          const compared = file ? comparedOf(file.state) : null;
          if (file && compared?.kind === "both" && !compared.baseUnknown) return flows.showVaultView(file, "mine");
          return row ? flows.showRowChanges(row) : undefined;
        }
        case "see-github":
        case "see-difference": {
          const file = ports.vaultFile(action.id);
          return file ? flows.showVaultView(file, action.action === "see-github" ? "github" : "difference") : undefined;
        }
        case "add-reviewer":
          return row ? flows.addReviewer([row]) : undefined;
        case "move-back":
          return row ? flows.moveBackToDraft([row]) : undefined;
        case "stop-review":
          return row ? flows.abandon([row]) : undefined;
        case "discard":
          return row ? flows.discard([row]) : undefined;
        case "view-on-github": {
          const url = units.urls.get(action.id);
          return url ? ports.openUrl(url) : undefined;
        }
        case "bring-in": {
          const brought = await ports.bringInDraft(action.id);
          if (brought.kind !== "brought" && brought.kind !== "exists") ports.toast(ports.notBrought);
          return;
        }
        case "publish":
          return row ? bulk(ports, [row], "publish", () => flows.publish([row])) : undefined;
        case "choose":
          return chooseForNote(ports, action.id, row);
        case "catch-up":
          return catchUp(ports, row);
        case "submit-only":
        case "publish-only":

          return;
      }
      return;
    }
    case "group": {
      const card = units.rows.get(action.id);
      switch (action.action) {
        case "rename":
          return ports.editGroup(action.id);
        case "ungroup":
          return card ? void (await flows.ungroup(card)) : undefined;
        case "choose":
          return card ? chooseForGroup(ports, card) : undefined;
        case "stop-review":
          return card ? flows.abandonGroup(card) : undefined;
        case "add-reviewer":
          return card ? flows.addReviewer([card]) : undefined;
        case "move-back":
          return card ? flows.moveBackToDraft([card]) : undefined;
        case "view-on-github": {
          const url = units.urls.get(action.id);
          return url ? ports.openUrl(url) : undefined;
        }
        case "submit-only":
        case "publish-only":
          return;
      }
      return;
    }
    case "pinned": {
      const path = ports.active();
      const row = pinnedUnit(ports);
      switch (action.action) {
        case "add-reviewer":
          return row ? flows.addReviewer([row]) : undefined;
        case "ask-changes":
          return row ? void (await flows.askForChanges([row])) : undefined;
        case "choose":
          return path === null ? undefined : chooseForNote(ports, path, row);
        case "catch-up":
          return catchUp(ports, row);
        case "connect-live":
          return path === null ? undefined : ports.connect(path);
        case "disconnect":
          return path === null ? undefined : ports.disconnect(path);
        case "open-in-specgit":
          return path === null ? undefined : ports.openNoteInSpecgit(path);
        case "copy-link":
          return path === null ? undefined : ports.copyLink(path);

        case "view-on-github":
        case "propose":
          return;
      }
      return;
    }
    case "fold":
      switch (action.id) {
        case "not-here":
          return ports.copyIn();
        case "newer":
          return void (await ports.bringInNewer());
        case "deleted":
          return ports.moveHeldDeletes();
        case "offered":
          return ports.addOffered();
      }
      return;
    case "fold-item": {
      if (action.action === "open") return ports.inVault(action.id) ? ports.openNote(action.id) : ports.openInSpecgit(action.id);
      const file = ports.vaultFile(action.id);
      return file ? flows.showVaultView(file, "github") : undefined;
    }
    case "remove-reviewer":
      return ports.setReviewers((was) => was.filter((one) => !sameLogin(one.login, action.login)));
    case "show-changes": {
      const path = ports.active();
      return path === null ? undefined : ports.showSince(path, action.on);
    }
    case "submit": {
      const rows = rowsOf(units, action.ids);
      if (rows.length === 0) return;

      await bulk(ports, rows, "submit", () => flows.submit(rows, action.reviewers, { asked: true }));

      ports.setReviewers(() => []);
      return;
    }
    case "approve":
      return approve(ports, rowsOf(units, action.ids));
    case "publish": {
      const rows = rowsOf(units, action.ids);

      const own = rows.length === 1 && action.ids.length === 1 && action.ids[0] === ports.active();
      return rows.length === 0 ? undefined : bulk(ports, rows, "publish", () => (own ? flows.publish(rows, { document: true }) : flows.publish(rows)));
    }
    case "discard":
      return flows.discard(rowsOf(units, action.ids));
    case "take-out": {
      const card = units.rows.get(action.group);
      return card ? void (await flows.takeOut(card, action.id)) : undefined;
    }
    case "group-together": {
      const made = await flows.createGroup(groupableRows(rowsOf(units, action.ids)));

      if (made.ok && made.id !== undefined) {
        ports.editGroup(groupId(made.id));
        return { groupId: groupId(made.id) };
      }
      return;
    }
    case "add-to-group": {
      const rows = groupableRows(rowsOf(units, action.ids));
      if (action.group === null) {
        const made = await flows.createGroup(rows);
        if (made.ok && made.id !== undefined) {
          ports.editGroup(groupId(made.id));
          return { groupId: groupId(made.id) };
        }
        return;
      }
      const card = units.rows.get(action.group);
      return card ? void (await flows.addToGroup(card, rows)) : undefined;
    }
    case "rename-group": {
      const card = units.rows.get(action.id);
      ports.editGroup(null);
      return card ? void (await flows.renameGroup(card, action.name)) : undefined;
    }
    case "add-reviewer": {

      const rows = rowsOf(units, action.ids);
      const first = rows[0] ?? pinnedUnit(ports);
      if (!first) return;
      const picked = await flows.submitPlan(rows.length > 0 ? rows : [first]).pickReviewer();
      if (picked) ports.setReviewers((was) => (was.some((one) => one.login === picked.login) ? was : [...was, asReviewer(picked)]));
      return;
    }
    case "retry":
      return ports.refresh();
  }
}
