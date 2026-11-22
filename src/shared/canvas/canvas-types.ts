export type CanvasColor = string;
export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEnd = "none" | "arrow";
export type CanvasBackgroundStyle = "cover" | "ratio" | "repeat";

export const CANVAS_SIDES: readonly CanvasSide[] = ["top", "right", "bottom", "left"];

export const CANVAS_GRID = 20;

export interface CanvasOrigin {
  text: string;
  value: Record<string, unknown>;
  entries: CanvasOriginEntry[];
  line: number;
  index?: number;
}

export interface CanvasOriginEntry {
  key: string;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  extra?: Record<string, unknown>;
  keyOrder?: string[];
  origin?: CanvasOrigin;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: "text";
  text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: "file";
  file: string;
  subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: "link";
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: CanvasBackgroundStyle;
}

export interface CanvasUnknownNode extends CanvasNodeBase {
  type: "unknown";
  rawType: string;
}

export type CanvasNode =
  | CanvasTextNode
  | CanvasFileNode
  | CanvasLinkNode
  | CanvasGroupNode
  | CanvasUnknownNode;

export type CanvasNodeType = CanvasNode["type"];

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toEnd?: CanvasEnd;
  color?: CanvasColor;
  label?: string;
  extra?: Record<string, unknown>;
  keyOrder?: string[];
  origin?: CanvasOrigin;
}

export interface CanvasObjectLayout {
  open: string;
  sep: string;
  colon: string;
  close: string;
}

export interface CanvasArrayLayout {
  open: string;
  seps: string[];
  close: string;
}

export interface CanvasFormat {
  newline: "\n" | "\r\n";
  head: string;
  tail: string;
  top?: CanvasObjectLayout;
  arrays?: { nodes?: CanvasArrayLayout; edges?: CanvasArrayLayout };
  obsidian: boolean;
  emptySource?: string;
  extraSource?: Record<string, string>;
}

export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  extra?: Record<string, unknown>;
  keyOrder?: string[];
  format?: CanvasFormat;
}

export type CanvasIssueCode =
  | "json"
  | "not_object"
  | "duplicate_id"
  | "dangling_edge"
  | "missing_field"
  | "invalid_value";

export interface CanvasIssue {
  code: CanvasIssueCode;
  message: string;
  line: number | null;
  id?: string;
}

export type CanvasParseResult =
  | { ok: true; canvas: CanvasDoc; issues: CanvasIssue[] }
  | { ok: false; issues: CanvasIssue[] };

export interface CanvasLineIndex {
  nodes: Record<string, number>;
  edges: Record<string, number>;
}

export const CANVAS_CHANGE_FIELDS = [
  "position",
  "size",
  "text",
  "file",
  "url",
  "label",
  "color",
  "type",
  "background",
  "ends",
  "sides",
  "endpoints",
  "order",
  "extra",
] as const;

export type CanvasChangeField = (typeof CANVAS_CHANGE_FIELDS)[number];

export interface CanvasItemChange {
  id: string;
  kind: "added" | "removed" | "changed";
  fields: CanvasChangeField[];
}

export interface CanvasDiff {
  nodes: CanvasItemChange[];
  edges: CanvasItemChange[];
}

export type CanvasConflictReason = "both_changed" | "deleted_vs_edited";

export const CANVAS_CONFLICT_FIELDS = [
  "position",
  "size",
  "type",
  "text",
  "file",
  "subpath",
  "url",
  "label",
  "color",
  "background",
  "backgroundStyle",
  "fromNode",
  "toNode",
  "fromSide",
  "toSide",
  "fromEnd",
  "toEnd",
] as const;

export type CanvasConflictField = (typeof CANVAS_CONFLICT_FIELDS)[number];

interface CanvasConflictKey {
  key: string;
  id: string;
}

export type CanvasItemConflict =
  | (CanvasConflictKey & {
      itemKind: "node";
      field: "*";
      reason: "both_changed" | "deleted_vs_edited";
      base: CanvasNode | null;
      ours: CanvasNode | null;
      theirs: CanvasNode | null;
    })
  | (CanvasConflictKey & {
      itemKind: "edge";
      field: "*";
      reason: "both_changed" | "deleted_vs_edited";
      base: CanvasEdge | null;
      ours: CanvasEdge | null;
      theirs: CanvasEdge | null;
    });

export interface CanvasFieldConflict extends CanvasConflictKey {
  itemKind: "node" | "edge";
  field: CanvasConflictField | (string & {});
  reason: "both_changed";
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export type CanvasConflict = CanvasItemConflict | CanvasFieldConflict;

export interface CanvasMergeResult {
  merged: CanvasDoc;
  conflicts: CanvasConflict[];
  base: CanvasDoc;
  ours: CanvasDoc;
  theirs: CanvasDoc;
}

export type CanvasConflictChoice = "ours" | "theirs";

export interface BoardOutlineCard {
  id: string;
  type: CanvasNodeType;
  width: number;
  height: number;
  target?: string;
  subpath?: string;
  text?: string;
  group?: string;
}

export interface BoardOutlineRelation {
  id: string;
  from: string;
  to: string;
  label?: string;
  undirected?: boolean;
  bidirectional?: boolean;
}

export interface BoardOutline {
  cards: BoardOutlineCard[];
  relations: BoardOutlineRelation[];
  truncated: number;
}

export type LanePosition = "top" | "bottom" | number;

export type PlacementAnchor =
  | { relation: "right_of" | "left_of" | "above" | "below"; of: string }
  | { relation: "inside_group"; group: string; at?: LanePosition }
  | { relation: "near"; x: number; y: number }
  | { relation: "free" };

export type BoardOp =
  | { op: "add_text_card"; ref?: string; text: string; place: PlacementAnchor; color?: CanvasColor }
  | { op: "add_note_card"; ref?: string; file: string; subpath?: string; place: PlacementAnchor }
  | { op: "update_text_card"; id: string; find: string; replace: string }
  | { op: "connect"; from: string; to: string; label?: string; fromSide?: CanvasSide; toSide?: CanvasSide; fromEnd?: CanvasEnd; toEnd?: CanvasEnd; color?: CanvasColor }
  | { op: "relabel_edge"; id: string; label: string }
  | { op: "restyle_edge"; id: string; label?: string; color?: CanvasColor; fromSide?: CanvasSide; toSide?: CanvasSide; fromEnd?: CanvasEnd; toEnd?: CanvasEnd }
  | { op: "remove_edge"; id: string }
  | { op: "create_group"; ref?: string; label: string; cards?: string[]; place?: LanePlacement; color?: CanvasColor }
  | { op: "move_into_group"; card: string; group: string }
  | { op: "move_card"; id: string; place: PlacementAnchor }
  | { op: "resize_card"; id: string; width?: number; height?: number; fit?: boolean }
  | { op: "delete_text_card"; id: string }
  | { op: "remove_note_card"; id: string }
  | { op: "restyle_card"; id: string; label?: string; color?: CanvasColor }
  | { op: "remove_group"; id: string }
  | { op: "tidy_group"; id: string }
  | { op: "add_link_card"; ref?: string; url: string; place: PlacementAnchor }
  | { op: "add_image_card"; ref?: string; file: string; place: PlacementAnchor }
  | { op: "add_file_card"; ref?: string; file: string; subpath?: string; place: PlacementAnchor; color?: CanvasColor }
  | { op: "create_note_card"; ref?: string; file: string; text?: string; place: PlacementAnchor }
  | { op: "convert_to_note"; id: string; file: string }
  | { op: "point_card_at_note"; id: string; file: string }
  | { op: "duplicate_card"; ref?: string; id: string; place?: PlacementAnchor }
  | { op: "reorder_card"; id: string; to: "front" | "back" }
  | { op: "delete_link_card"; id: string };

export interface LanePlacement {
  relation: "right_of" | "left_of" | "above" | "below";
  of: string;
}

export type BoardOpKind = BoardOp["op"];

export interface BoardOpsResult {
  canvas: CanvasDoc;
  created: Record<string, string>;
  errors: Array<{ index: number; message: string }>;
  notes: Array<{ index: number; message: string }>;
  grew: string[];
  newNotes: Array<{ index: number; file: string; text: string }>;
}
