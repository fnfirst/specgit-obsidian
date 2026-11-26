export type GithubStatusState = "operational" | "degraded" | "outage";
export type GithubStatusSource = "none" | "feed" | "observed" | "both";
export type GithubComponentKey = "api" | "git" | "pull_requests" | "issues" | "webhooks";
export type GithubComponentLevel = "operational" | "degraded_performance" | "partial_outage" | "major_outage";
export type GithubCircuitState = "closed" | "open" | "half_open";

export interface GithubStatusSnapshot {
  state: GithubStatusState;
  source: GithubStatusSource;
  circuit: GithubCircuitState;
  retryAfterSec: number | null;
  components: Partial<Record<GithubComponentKey, GithubComponentLevel>>;
  webhooksOnly: boolean;
  incidentName: string | null;
  statusUrl: string;
  updatedAt: number;
}

export interface GithubStatusEvent {
  kind: "github_status";
  status: GithubStatusSnapshot;
}

export const GITHUB_STATUS_PAGE_URL = "https://www.githubstatus.com";
export const GITHUB_FAST_FAIL_HEADER = "x-specgit-fast-fail";
export const GITHUB_UNAVAILABLE_CODE = "github_unavailable";

export const OPERATIONAL_GITHUB_STATUS: GithubStatusSnapshot = {
  state: "operational",
  source: "none",
  circuit: "closed",
  retryAfterSec: null,
  components: {},
  webhooksOnly: false,
  incidentName: null,
  statusUrl: GITHUB_STATUS_PAGE_URL,
  updatedAt: 0,
};

export const GITHUB_STATUS_COPY = {
  bannerOutage: "GitHub is having an outage. Keep writing here, and specgit will save your changes once GitHub is back.",
  bannerDegraded: "GitHub is having trouble right now. Keep writing here, and specgit will save your changes once GitHub is back.",
  bannerObserved: "GitHub isn't answering right now. Your edits stay safe here while specgit keeps retrying.",
  bannerWebhooks: "GitHub updates are delayed right now. Live refresh may take a few minutes.",
  bannerSignIn: "GitHub is having trouble right now, so sign-in and loading may fail. Try again shortly.",
  saveWaitingLabel: "Waiting on GitHub",
  saveWaitingText: "Your edits stay safe here. specgit will save to GitHub once it's back.",
  actionPaused: "GitHub isn't answering right now, so this action is paused. Try again in a moment.",
  recoveredSaved: "GitHub is back. Your changes are saved.",
  recoveredOnline: "GitHub is back.",
  statusLinkLabel: "GitHub Status",
  tryAgainLabel: "Try again",
  obsidianBanner: "GitHub is having trouble right now. Syncing and publishing are paused until it's back.",
  obsidianObserved: "GitHub isn't answering right now. Syncing will retry automatically.",
  mcpHint: "GitHub is having trouble right now. Live edits stay safe in specgit, and GitHub steps can be retried once GitHub recovers.",
  authCallbackUnavailable: "GitHub is having trouble right now, so sign-in couldn't finish. Please try again shortly.",
} as const;

export const GITHUB_COMPONENT_IDS: Record<GithubComponentKey, string> = {
  api: "brv1bkgrwx7q",
  git: "8l4ygp009s5s",
  pull_requests: "hhtssxt0f5v2",
  issues: "kr09ddfgbfsf",
  webhooks: "4230lsnqdsld",
};

export const GITHUB_COMPONENT_NAMES: Record<GithubComponentKey, string> = {
  api: "API Requests",
  git: "Git Operations",
  pull_requests: "Pull Requests",
  issues: "Issues",
  webhooks: "Webhooks",
};

const CORE_COMPONENTS: readonly GithubComponentKey[] = ["api", "git", "pull_requests", "issues"];
const ALL_COMPONENTS: readonly GithubComponentKey[] = ["api", "git", "pull_requests", "issues", "webhooks"];
const VALID_STATES: readonly GithubStatusState[] = ["operational", "degraded", "outage"];
const VALID_SOURCES: readonly GithubStatusSource[] = ["none", "feed", "observed", "both"];
const VALID_CIRCUITS: readonly GithubCircuitState[] = ["closed", "open", "half_open"];
const VALID_LEVELS: readonly GithubComponentLevel[] = ["operational", "degraded_performance", "partial_outage", "major_outage"];

const COMPONENT_BY_ID: Record<string, GithubComponentKey> = {
  [GITHUB_COMPONENT_IDS.api]: "api",
  [GITHUB_COMPONENT_IDS.git]: "git",
  [GITHUB_COMPONENT_IDS.pull_requests]: "pull_requests",
  [GITHUB_COMPONENT_IDS.issues]: "issues",
  [GITHUB_COMPONENT_IDS.webhooks]: "webhooks",
};

const COMPONENT_BY_NAME: Record<string, GithubComponentKey> = {
  "api requests": "api",
  "git operations": "git",
  "pull requests": "pull_requests",
  issues: "issues",
  webhooks: "webhooks",
};

const COMPONENT_KEYWORDS: Record<GithubComponentKey, RegExp> = {
  api: /\bapi\b/i,
  git: /\bgit\b/i,
  pull_requests: /\bpull requests?\b/i,
  issues: /\bissues?\b/i,
  webhooks: /\bwebhooks?\b/i,
};

const IGNORED_INCIDENT_KEYWORDS = /\b(?:copilot|actions|packages|pages|codespaces)\b/i;

const SAFE_HTTPS_URL = /^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/\S*)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_HTTPS_URL.test(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isComponentLevel(value: unknown): value is GithubComponentLevel {
  return typeof value === "string" && (VALID_LEVELS as readonly string[]).includes(value);
}

function isComponentKey(value: string): value is GithubComponentKey {
  return (ALL_COMPONENTS as readonly string[]).includes(value);
}

function matchComponentKey(id: unknown, name: unknown): GithubComponentKey | null {
  if (typeof id === "string") {
    const byId = COMPONENT_BY_ID[id.trim()];
    if (byId) return byId;
  }
  if (typeof name === "string") {
    const byName = COMPONENT_BY_NAME[name.trim().toLowerCase()];
    if (byName) return byName;
  }
  return null;
}

function operationalFeed(now: number): Omit<GithubStatusSnapshot, "circuit" | "retryAfterSec"> {
  return {
    state: "operational",
    source: "none",
    components: {},
    webhooksOnly: false,
    incidentName: null,
    statusUrl: GITHUB_STATUS_PAGE_URL,
    updatedAt: now,
  };
}

function incidentComponentRefs(incident: Record<string, unknown>): { hasMetadata: boolean; keys: Set<GithubComponentKey> } {
  const keys = new Set<GithubComponentKey>();
  let hasMetadata = false;
  if (Array.isArray(incident.components) && incident.components.length > 0) {
    hasMetadata = true;
    for (const item of incident.components) {
      if (!isRecord(item)) continue;
      const key = matchComponentKey(item.id, item.name);
      if (key) keys.add(key);
    }
  }
  if (Array.isArray(incident.incident_updates)) {
    for (const update of incident.incident_updates) {
      if (!isRecord(update) || !Array.isArray(update.affected_components) || update.affected_components.length === 0) continue;
      hasMetadata = true;
      for (const comp of update.affected_components) {
        if (!isRecord(comp)) continue;
        const key = matchComponentKey(comp.code ?? comp.id, comp.name);
        if (key) keys.add(key);
      }
    }
  }
  return { hasMetadata, keys };
}

function pickIncident(
  incidents: unknown,
  affectedKeys: ReadonlySet<GithubComponentKey>,
  webhooksOnly: boolean,
): { name: string | null; url: string } {
  if (!Array.isArray(incidents) || affectedKeys.size === 0) {
    return { name: null, url: GITHUB_STATUS_PAGE_URL };
  }
  const unresolved: Record<string, unknown>[] = [];
  for (const item of incidents) {
    if (!isRecord(item)) continue;
    const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    if (status === "resolved" || status === "postmortem") continue;
    unresolved.push(item);
  }
  const format = (incident: Record<string, unknown>): { name: string | null; url: string } => {
    const rawName = typeof incident.name === "string" ? incident.name.trim() : "";
    const shortlink = isSafeHttpsUrl(incident.shortlink) ? incident.shortlink : GITHUB_STATUS_PAGE_URL;
    return { name: rawName !== "" ? rawName : null, url: shortlink };
  };
  let webhookMatch: Record<string, unknown> | null = null;
  for (const incident of unresolved) {
    const refs = incidentComponentRefs(incident);
    if (!refs.hasMetadata) continue;
    let matchedCore = false;
    let matchedAny = false;
    for (const key of refs.keys) {
      if (!affectedKeys.has(key)) continue;
      matchedAny = true;
      if (key !== "webhooks") matchedCore = true;
    }
    if (matchedCore || (webhooksOnly && matchedAny)) return format(incident);
    if (matchedAny && webhookMatch === null) webhookMatch = incident;
  }
  if (webhookMatch !== null) return format(webhookMatch);
  let fallback: Record<string, unknown> | null = null;
  for (const incident of unresolved) {
    const refs = incidentComponentRefs(incident);
    if (refs.hasMetadata) continue;
    const name = typeof incident.name === "string" ? incident.name.trim() : "";
    let keywordHit = false;
    for (const key of affectedKeys) {
      if (COMPONENT_KEYWORDS[key].test(name)) {
        keywordHit = true;
        break;
      }
    }
    if (keywordHit) return format(incident);
    if (fallback === null && !IGNORED_INCIDENT_KEYWORDS.test(name)) fallback = incident;
  }
  return fallback !== null ? format(fallback) : { name: null, url: GITHUB_STATUS_PAGE_URL };
}

export function parseGithubSummaryPayload(
  raw: unknown,
  now: number,
): Omit<GithubStatusSnapshot, "circuit" | "retryAfterSec"> {
  if (!isRecord(raw) || !Array.isArray(raw.components)) return operationalFeed(now);
  const components: Partial<Record<GithubComponentKey, GithubComponentLevel>> = {};
  const affectedKeys = new Set<GithubComponentKey>();
  for (const entry of raw.components) {
    if (!isRecord(entry)) continue;
    const key = matchComponentKey(entry.id, entry.name);
    if (!key) continue;
    if (!isComponentLevel(entry.status) || entry.status === "operational") continue;
    components[key] = entry.status;
    affectedKeys.add(key);
  }
  if (affectedKeys.size === 0) return operationalFeed(now);
  let coreAffected = false;
  let coreMajor = false;
  for (const key of CORE_COMPONENTS) {
    const level = components[key];
    if (!level) continue;
    coreAffected = true;
    if (level === "major_outage") coreMajor = true;
  }
  const webhooksOnly = !coreAffected;
  const state: GithubStatusState = coreMajor ? "outage" : "degraded";
  const incident = pickIncident(raw.incidents, affectedKeys, webhooksOnly);
  return {
    state,
    source: "feed",
    components,
    webhooksOnly,
    incidentName: incident.name,
    statusUrl: incident.url,
    updatedAt: now,
  };
}

export function combineGithubStatus(
  feed: Omit<GithubStatusSnapshot, "circuit" | "retryAfterSec"> | null,
  observed: { degraded: boolean; circuit: GithubCircuitState; retryAfterSec: number | null },
  now: number,
): GithubStatusSnapshot {
  const feedActive = feed !== null && feed.state !== "operational";
  const observedActive = observed.degraded || observed.circuit !== "closed";
  const retryAfterSec =
    observed.circuit !== "closed" &&
    typeof observed.retryAfterSec === "number" &&
    Number.isFinite(observed.retryAfterSec) &&
    observed.retryAfterSec > 0
      ? observed.retryAfterSec
      : null;

  if (!feedActive && !observedActive) {
    return {
      state: "operational",
      source: "none",
      circuit: "closed",
      retryAfterSec: null,
      components: {},
      webhooksOnly: false,
      incidentName: null,
      statusUrl: GITHUB_STATUS_PAGE_URL,
      updatedAt: now,
    };
  }

  if (feedActive && !observedActive) {
    return {
      state: feed.state,
      source: "feed",
      circuit: "closed",
      retryAfterSec: null,
      components: { ...feed.components },
      webhooksOnly: feed.webhooksOnly,
      incidentName: feed.incidentName,
      statusUrl: feed.statusUrl,
      updatedAt: now,
    };
  }

  if (!feedActive) {
    return {
      state: "degraded",
      source: "observed",
      circuit: observed.circuit,
      retryAfterSec,
      components: {},
      webhooksOnly: false,
      incidentName: null,
      statusUrl: GITHUB_STATUS_PAGE_URL,
      updatedAt: now,
    };
  }

  return {
    state: feed.state === "outage" ? "outage" : "degraded",
    source: "both",
    circuit: observed.circuit,
    retryAfterSec,
    components: { ...feed.components },
    webhooksOnly: false,
    incidentName: feed.incidentName,
    statusUrl: feed.statusUrl,
    updatedAt: now,
  };
}

export function isGithubAffected(snapshot: GithubStatusSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return snapshot.circuit !== "closed" || (snapshot.state !== "operational" && !snapshot.webhooksOnly);
}

export function githubStatusTone(snapshot: GithubStatusSnapshot | null | undefined): "none" | "info" | "warning" | "error" {
  if (!snapshot) return "none";
  if (snapshot.state === "operational" && snapshot.circuit === "closed") return "none";
  if (snapshot.state === "outage") return "error";
  if (snapshot.circuit !== "closed") return "warning";
  if (snapshot.webhooksOnly) return "info";
  return "warning";
}

export function githubStatusHeadline(
  snapshot: GithubStatusSnapshot | null | undefined,
  surface: "editor" | "app" | "obsidian",
): string | null {
  if (!snapshot) return null;
  if (snapshot.state === "operational" && snapshot.circuit === "closed") return null;
  if (snapshot.webhooksOnly && snapshot.circuit === "closed") return GITHUB_STATUS_COPY.bannerWebhooks;
  if (surface === "obsidian") {
    return snapshot.source === "observed" || snapshot.source === "none"
      ? GITHUB_STATUS_COPY.obsidianObserved
      : GITHUB_STATUS_COPY.obsidianBanner;
  }
  if (surface === "app") return GITHUB_STATUS_COPY.bannerSignIn;
  if (snapshot.state === "outage") return GITHUB_STATUS_COPY.bannerOutage;
  if (snapshot.source === "observed" || snapshot.source === "none") return GITHUB_STATUS_COPY.bannerObserved;
  return GITHUB_STATUS_COPY.bannerDegraded;
}

export function isGithubStatusSnapshot(raw: unknown): raw is GithubStatusSnapshot {
  if (!isRecord(raw)) return false;
  if (typeof raw.state !== "string" || !(VALID_STATES as readonly string[]).includes(raw.state)) return false;
  if (typeof raw.source !== "string" || !(VALID_SOURCES as readonly string[]).includes(raw.source)) return false;
  if (typeof raw.circuit !== "string" || !(VALID_CIRCUITS as readonly string[]).includes(raw.circuit)) return false;
  if (
    raw.retryAfterSec !== null &&
    (typeof raw.retryAfterSec !== "number" || !Number.isFinite(raw.retryAfterSec) || raw.retryAfterSec < 0)
  ) {
    return false;
  }
  if (!isRecord(raw.components)) return false;
  for (const key of Object.keys(raw.components)) {
    if (!isComponentKey(key)) return false;
    const value = raw.components[key];
    if (value !== undefined && !isComponentLevel(value)) return false;
  }
  if (typeof raw.webhooksOnly !== "boolean") return false;
  if (raw.incidentName !== null && typeof raw.incidentName !== "string") return false;
  if (!isSafeHttpsUrl(raw.statusUrl)) return false;
  if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) return false;
  return true;
}

function cleanGithubStatus(status: GithubStatusSnapshot): GithubStatusSnapshot {
  const components: Partial<Record<GithubComponentKey, GithubComponentLevel>> = {};
  for (const key of Object.keys(status.components) as GithubComponentKey[]) {
    const level = status.components[key];
    if (level !== undefined) components[key] = level;
  }
  return {
    state: status.state,
    source: status.source,
    circuit: status.circuit,
    retryAfterSec: status.retryAfterSec,
    components,
    webhooksOnly: status.webhooksOnly,
    incidentName: status.incidentName,
    statusUrl: status.statusUrl,
    updatedAt: status.updatedAt,
  };
}

export function readGithubStatusEvent(value: unknown): GithubStatusEvent | null {
  if (!isRecord(value) || value.kind !== "github_status") return null;
  if (!isGithubStatusSnapshot(value.status)) return null;
  return { kind: "github_status", status: cleanGithubStatus(value.status) };
}

export function parseGithubStatusEvent(raw: string): GithubStatusEvent | null {
  try {
    return readGithubStatusEvent(JSON.parse(raw));
  } catch {
    return null;
  }
}
