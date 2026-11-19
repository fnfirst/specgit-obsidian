import type { StatusChipKey, StatusGroupMenuItem, StatusNoun, StatusPillState, StatusRowButton, StatusRowMenuItem, StatusRunning } from "../review-flow";

export type { StatusChipKey, StatusGroupMenuItem, StatusNoun, StatusPillState, StatusRowButton, StatusRowMenuItem, StatusRunning };

export type Lane = "approve" | "publish" | "drafts" | "others" | "none";

export type CheckKind = "submit" | "approve" | "publish";

export interface StatusPerson {
  login: string;
  avatarUrl?: string;
}

export interface StatusPeople {
  people: readonly (string | StatusPerson)[];

  asksYou?: boolean;
}

export interface StatusDoc extends StatusPeople {
  kind: "doc";
  id: string;
  name: string;

  renamedFrom?: string;

  state?: StatusPillState;

  when?: string;

  here?: readonly (string | StatusPerson)[];

  lane?: Lane;

  changed?: number;

  reason?: string;

  teammate?: boolean;

  check?: CheckKind;

  hasChanges?: boolean;

  button?: StatusRowButton;

  hasReview?: boolean;

  menu?: readonly StatusRowMenuItem[];

  tipPeople?: readonly string[];

  folder?: string;

  views?: readonly ("github" | "difference")[];

  openComments?: number;

  autoPublish?: boolean;
}

export interface StatusGroupMember {
  id: string;
  name: string;
}

export interface StatusGroup extends StatusPeople {
  kind: "group";
  id: string;
  name: string;
  members: readonly StatusGroupMember[];
  state: StatusPillState;
  when?: string;
  reason?: string;
  check?: CheckKind;
  hasChanges?: boolean;
  button?: StatusRowButton;
  tipPeople?: readonly string[];

  editing?: boolean;
  here?: readonly (string | StatusPerson)[];
  lane?: Lane;
  changed?: number;

  hasReview?: boolean;
  openComments?: number;
  autoPublish?: boolean;

  ending?: boolean;
}

export type StatusItem = StatusDoc | StatusGroup;

export interface StatusReviewer {
  login: string;
  avatarUrl?: string;
  mark?: "approved" | "changes";
}

export interface StatusPinned extends StatusPeople {
  id: string;
  name: string;
  state: StatusPillState;
  when?: string;

  changed?: number;

  here?: readonly (string | StatusPerson)[];

  check?: CheckKind;
  lane?: Lane;
  hasChanges?: boolean;
  showChanges: boolean;

  reviewers?: readonly StatusReviewer[];

  step?: "choose";
  tipPeople?: readonly string[];

  note?: string;

  groupId?: string;

  hasReview?: boolean;

  teammate?: boolean;

  nothingToSend?: boolean;

  publishable?: boolean;

  canApprove?: boolean;

  propose?: string;

  menu?: readonly PinnedMenuItem[];

  reason?: string;

  views?: readonly ("github" | "difference")[];

  hideChanges?: boolean;

  approveInSpecgit?: boolean;

  local?: boolean;

  fixBelow?: boolean;
  openComments?: number;
  autoPublish?: boolean;

  plugin?: { connected: boolean; joining?: boolean; people?: number };
}

export type PinnedMenuItem = "open-in-specgit" | "copy-link" | "view-on-github";

export interface StatusFold {

  id: "not-here" | "newer" | "deleted" | "offered";
  count: number;

  progress?: { done: number; total: number };

  items?: readonly StatusFoldItem[];
}

export interface StatusFoldItem {
  id: string;
  name: string;

  folder?: string;
}

export type RowAction = StatusRowMenuItem | StatusRowButton;
export type GroupAction = StatusGroupMenuItem | "choose";
export type PinnedAction = "add-reviewer" | "catch-up" | "ask-changes" | "choose" | "connect-live" | "disconnect" | "open-in-specgit" | "copy-link" | "view-on-github" | "propose";

export type PanelAction =
  | { type: "row"; id: string; action: RowAction }
  | { type: "group"; id: string; action: GroupAction }
  | { type: "pinned"; action: PinnedAction }
  | { type: "fold"; id: StatusFold["id"] }
  | { type: "show-changes"; on: boolean }
  | { type: "submit"; ids: readonly string[]; reviewers: readonly string[] }
  | { type: "approve"; ids: readonly string[] }
  | { type: "publish"; ids: readonly string[] }
  | { type: "discard"; ids: readonly string[] }
  | { type: "take-out"; group: string; id: string }
  | { type: "group-together"; ids: readonly string[] }
  | { type: "add-to-group"; ids: readonly string[]; group: string | null }
  | { type: "rename-group"; id: string; name: string }

  | { type: "add-reviewer"; ids: readonly string[] }

  | { type: "remove-reviewer"; login: string }

  | { type: "fold-item"; fold: "newer"; id: string; action: "open" | "see-github" }
  | { type: "retry" };

export type ActionAnswer = { groupId?: string } | void;

export interface StatusNotice {
  done: number;
  did: "published" | "submitted" | "approved";
  needs: number;

  ids?: readonly string[];
}

export interface PanelStart {

  menu?: string;

  chip?: StatusChipKey;

  tip?: string;

  askSeparate?: boolean;
  step?: "submit";

  holdNotice?: boolean;

  openGroups?: readonly string[];

  scroll?: number;

  flash?: readonly string[];
}

export interface StatusPanelModel {
  loading?: boolean;
  loadFailed?: boolean;
  offline?: boolean;

  busy?: boolean;

  running?: StatusRunning;

  groupsOff?: boolean;

  cardOnly?: boolean;

  grouping?: {
    reason: string;

    retry?: boolean;

    link?: { label: string; href: string };
  };

  readOnly?: boolean;

  pinned?: StatusPinned | null;

  items: readonly StatusItem[];

  folds?: readonly StatusFold[];

  checked: readonly string[];

  reviewers?: readonly StatusReviewer[];
  notice?: StatusNotice | null;
  start?: PanelStart;

  onChecked?: (ids: readonly string[]) => void;
  onAction: (action: PanelAction) => void | Promise<ActionAnswer>;
}

export interface PanelMenuItem {
  label: string;
  danger?: boolean;
  run: () => void;
}

export interface ConfirmQuestion {
  title: string;
  choices: readonly { id: string; label: string; primary?: boolean }[];
}

export interface PanelHost {
  noun: StatusNoun;

  touch?: boolean;

  openMenu?: (items: readonly PanelMenuItem[], anchor: HTMLElement) => void;

  confirm?: (question: ConfirmQuestion) => Promise<string>;
}
