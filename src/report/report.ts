import type { ApiAnswer } from "../api";
import { AuthError, NETWORK_MESSAGE } from "../auth/errors";
import { normalizeServer } from "../auth/config";
import { isRepoName } from "../mapping";
import type { NoteWord } from "../status";

export const SUPPORT_EMAIL = "support@specgit.com";

const SUPPORT_SUBJECT = "Obsidian+Plugin";

export function supportPageUrl(server: string): string {
  return `${normalizeServer(server)}/support?subject=${SUPPORT_SUBJECT}`;
}

const NOTE_WORDS: readonly NoteWord[] = ["Local", "Connecting…", "Live", "Reconnecting…", "Not live"];

export interface ReportDetails {
  plugin?: string;
  obsidian?: string;
  platform?: string;
  repository?: string;
  signedIn?: "yes" | "no";
  note?: NoteWord;
}

const DETAIL_LABELS: ReadonlyArray<readonly [keyof ReportDetails, string]> = [
  ["plugin", "Plugin version"],
  ["obsidian", "Obsidian version"],
  ["platform", "Platform"],
  ["repository", "Repository"],
  ["signedIn", "Signed in"],
  ["note", "Open note"],
];

export interface PlatformFlags {
  isMacOS?: boolean;
  isWin?: boolean;
  isLinux?: boolean;
  isIosApp?: boolean;
  isAndroidApp?: boolean;
  isPhone?: boolean;
  isTablet?: boolean;
}

export function platformWords(flags: PlatformFlags): string {
  const os = flags.isMacOS ? "macOS" : flags.isWin ? "Windows" : flags.isLinux ? "Linux" : flags.isIosApp ? "iOS" : flags.isAndroidApp ? "Android" : "unknown";
  return `${os}, ${flags.isPhone ? "phone" : flags.isTablet ? "tablet" : "desktop"}`;
}

export interface DetailsInput {
  pluginVersion: string;

  obsidianVersion: string;
  platform: string;

  repository: string;
  signedIn: boolean;

  noteState: NoteWord | null;
}

const VERSION = /^[A-Za-z0-9._+-]{1,32}$/;

export function buildDetails(input: DetailsInput): ReportDetails {
  const details: ReportDetails = {};
  if (VERSION.test(input.pluginVersion)) details.plugin = input.pluginVersion;
  if (VERSION.test(input.obsidianVersion)) details.obsidian = input.obsidianVersion;
  if (/^[A-Za-z]{1,16}, [a-z]{1,16}$/.test(input.platform)) details.platform = input.platform;
  if (isRepoName(input.repository) && input.repository.length <= 140) details.repository = input.repository;
  details.signedIn = input.signedIn ? "yes" : "no";
  if (input.noteState !== null && NOTE_WORDS.includes(input.noteState)) details.note = input.noteState;
  return details;
}

export function detailLines(details: ReportDetails): string[] {
  return DETAIL_LABELS.flatMap(([key, label]) => (details[key] ? [`${label}: ${details[key]}`] : []));
}

export function reportText(message: string, details: ReportDetails | null): string {
  const body = message.trim();
  return details ? `${body}\n\nSetup details\n${detailLines(details).join("\n")}` : body;
}

export type SendOutcome =
  | { kind: "sent" }

  | { kind: "signed_out" }

  | { kind: "refused"; message: string }

  | { kind: "rate_limited"; message: string }

  | { kind: "unavailable"; message: string };

export interface ReportBody {
  message: string;
  email?: string;
  details?: ReportDetails;
}

export interface ReportApi {
  call(method: "POST", path: string, input: { body: unknown }): Promise<ApiAnswer>;
}

const wordsOf = (answer: ApiAnswer, fallback: string): string => answer.message ?? fallback;

const MAIL_FAILED = `We couldn't send that just now. Try again later or email ${SUPPORT_EMAIL}.`;

export async function sendReport(api: ReportApi, body: ReportBody): Promise<SendOutcome> {
  let answer: ApiAnswer;
  try {
    answer = await api.call("POST", "/api/support/report", { body });
  } catch (error) {
    if (error instanceof AuthError && error.code === "signed_out") return { kind: "signed_out" };
    if (error instanceof AuthError && error.code === "plugin_outdated") return { kind: "unavailable", message: error.message };
    return { kind: "unavailable", message: NETWORK_MESSAGE };
  }
  if (answer.status >= 200 && answer.status < 300) return { kind: "sent" };
  if (answer.status === 401) return { kind: "signed_out" };
  if (answer.status === 429) return { kind: "rate_limited", message: wordsOf(answer, `You've sent a few reports already. Try again in a while, or email ${SUPPORT_EMAIL}.`) };
  if (answer.status === 400) return { kind: "refused", message: wordsOf(answer, "specgit couldn't take that report. Check what you wrote and try again.") };
  return { kind: "unavailable", message: answer.status === 503 ? wordsOf(answer, MAIL_FAILED) : NETWORK_MESSAGE };
}

export interface ReportDeps {
  api: ReportApi;
  signedIn(): boolean;
  server(): string;

  details(): ReportDetails;

  copy(text: string): Promise<void>;
  openUrl(url: string): void;
}

export type SubmitResult = { kind: "closed"; notice: string } | { kind: "stay" };

export interface Problem {
  words: string;

  offerCopy: boolean;
}

export const NOTHING_WRITTEN = "Write what happened first.";
export const COPY_FAILED = "We couldn't copy the report. Select the text above, copy it, and paste it into the support page.";

export const SIGNED_OUT_WORDS = "You're signed out. Choose Copy and open support to send it from the support page.";

export const thanksWords = (email: string): string =>
  email === "" ? "Thanks, we got your report. Add an email next time if you'd like a reply." : "Thanks, we got your report. We'll reply to the email you gave.";

export const COPIED_WORDS = "Report copied. Paste it into the support page that just opened.";

export class ReportForm {
  message: string;
  email = "";
  includeDetails = true;
  problem: Problem | null = null;
  private sending = false;
  private signedOut: boolean;

  constructor(
    private readonly deps: ReportDeps,
    initialMessage = "",
  ) {
    this.message = initialMessage;
    this.signedOut = !deps.signedIn();
  }

  details(): ReportDetails | null {
    return this.includeDetails ? this.deps.details() : null;
  }

  get primary(): "send" | "copy" {
    return this.signedOut ? "copy" : "send";
  }

  get busy(): boolean {
    return this.sending;
  }

  async submit(): Promise<SubmitResult> {
    if (this.sending) return { kind: "stay" };
    if (this.message.trim() === "") {
      this.problem = { words: NOTHING_WRITTEN, offerCopy: false };
      return { kind: "stay" };
    }
    this.sending = true;
    this.problem = null;
    try {

      if (!this.signedOut && !this.deps.signedIn()) this.signedOut = true;
      return this.signedOut ? await this.copyAndOpen() : await this.send();
    } finally {
      this.sending = false;
    }
  }

  async copyReport(): Promise<boolean> {
    try {
      await this.deps.copy(reportText(this.message, this.details()));
      return true;
    } catch {
      this.problem = { words: COPY_FAILED, offerCopy: false };
      return false;
    }
  }

  private async send(): Promise<SubmitResult> {
    const email = this.email.trim();
    const details = this.details();
    const outcome = await sendReport(this.deps.api, { message: this.message.trim(), ...(email ? { email } : {}), ...(details ? { details } : {}) });
    switch (outcome.kind) {
      case "sent":
        return { kind: "closed", notice: thanksWords(email) };
      case "signed_out":

        this.signedOut = true;
        return { kind: "stay" };
      case "refused":
      case "rate_limited":
        this.problem = { words: outcome.message, offerCopy: false };
        return { kind: "stay" };
      case "unavailable":
        this.problem = { words: outcome.message, offerCopy: true };
        return { kind: "stay" };
    }
  }

  private async copyAndOpen(): Promise<SubmitResult> {
    if (!(await this.copyReport())) return { kind: "stay" };
    this.deps.openUrl(supportPageUrl(this.deps.server()));
    return { kind: "closed", notice: COPIED_WORDS };
  }
}

export function alertReportText(title: string, description?: string): string {
  return description ? `${title}\n\n${description}` : title;
}
