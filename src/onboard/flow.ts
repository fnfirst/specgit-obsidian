import type { ApiAnswer } from "../api";
import { isRepoName } from "../mapping";
import { VAULT_MAX_FILES, VAULT_MAX_TOTAL_BYTES, type VaultNextStep } from "../shared/review-flow";
import { type VaultPlan, safeRepoName } from "./plan";
import type { UploadRecord } from "./record";
import type { UploadProgress } from "./upload";
import {
  ACCOUNT_UNREAD,
  BAD_NAME,
  changed,
  CONTINUE,
  CREATE_FAILED,
  DONE_TITLE,
  FAILED,
  gone,
  isPublic,
  LINK_FAILED,
  nameTaken,
  notEmpty,
  OPEN_ON_GITHUB,
  SIGN_IN_UNFINISHED,
  STOPPED,
  underWay,
  VAULT_UNREAD,
} from "./words";

export interface OnboardAccount {
  login: string;
  next: VaultNextStep;
  installUrl: string | null;
  formUrl: string;
  freeInUse: boolean;
}

const NEXT_STEPS: readonly VaultNextStep[] = ["create", "install", "accept", "form"];

export function accountFrom(answer: ApiAnswer | null): OnboardAccount | null {
  const body = answer?.status === 200 ? answer.body : null;
  if (!body || typeof body.login !== "string" || typeof body.formUrl !== "string") return null;
  const next = NEXT_STEPS.find((step) => step === body.next);
  if (next === undefined) return null;
  return { login: body.login, next, installUrl: typeof body.installUrl === "string" ? body.installUrl : null, formUrl: body.formUrl, freeInUse: body.freeInUse === true };
}

export interface UploadView {
  kind: "reading" | "uploading";
  done: number;
  total: number;
  waiting: "slow" | "offline" | null;
}

export type OnboardView =
  | { step: "name"; typed: string; private: boolean; plan: VaultPlan | null;  unread: boolean; account: OnboardAccount | null; signedIn: boolean; problem: string | null }
  | { step: "creating"; name: string }
  | { step: "waiting"; why: "install" | "accept"; name: string; notSeen: boolean }
  | { step: "form"; name: string; canGiveAccess: boolean; notSeen: boolean }
  | { step: "upload"; progress: UploadView }
  | { step: "done"; repo: string }
  | { step: "problem"; why: "changed" | "gone" | "not_empty" | "public" | "failed" | "link"; line: string; action: "start_again" | "try_again" | null };

export interface OnboardEvents {
  edit(typed: string, isPrivate: boolean): void;
  press(typed: string, isPrivate: boolean): void;
  closed(): void;
  openAgain(): void;
  lookAgain(): void;
  openGithub(): void;
  giveAccess(): void;
  stop(): void;
  startAgain(): void;
  tryAgain(): void;
  openOnGitHub(): void;
}

export interface OnboardUi {
  show(view: OnboardView, on: OnboardEvents): void;
  close(): void;
  bringForward(): boolean;
}

export interface UploadControl {
  progress(state: UploadProgress): void;
  isCurrent(): boolean;
  expectPrivate?: boolean;
}

export interface OnboardDeps {
  ui: OnboardUi;
  confirmPublic?(repo: string): Promise<boolean>;
  signedIn(): boolean;
  signIn(options: { install: boolean }): Promise<"signed_in" | "unfinished">;
  call(action: string, body: Record<string, unknown>): Promise<ApiAnswer>;
  plan(): Promise<VaultPlan>;
  upload(repo: string, control: UploadControl): Promise<void>;
  record: { read(): UploadRecord | null; write(repo: string, isPrivate?: boolean): void; markUploaded(): void; clear(): void };
  openUrl(url: string): void;
  onFront(listener: () => void): () => void;
  wait(ms: number): Promise<void>;
  now(): number;
  apply(mapping: { repo: string; folder: string }): Promise<void>;
  vaultName(): string;
  repoChosen(): boolean;
  notify(message: string): void;
  notifyWithAction(message: string, label: string, run: () => void): void;
  progressNotice(message: string): { set(message: string): void; hide(): void };
}

export type OnboardState = { kind: "idle" } | { kind: "running"; phase: "reading" | "uploading"; done: number; total: number } | { kind: "stopped" };

const LOOK_EVERY_MS = 3_000;
const LOOK_FOR_MS = 10 * 60_000;

interface Session {
  typed: string;
  private: boolean;
  confirmedPublic: string | null;
  name: string;
  plan: VaultPlan | null;
  account: OnboardAccount | null;
  planFailed: boolean;
  problem: string | null;
  view: OnboardView | null;
  windowOpen: boolean;
  upload: { repo: string; counts: { kind: "reading" | "uploading"; done: number; total: number } | null; waiting: "slow" | "offline" | null } | null;
  stopRequested: boolean;
  notice: { set(message: string): void; hide(): void } | null;
  watching: object | null;
  refused: boolean;
  pressing: boolean;
  ended: boolean;
}

const nameOf = (repo: string): string => repo.split("/")[1] ?? "";

export class VaultOnboarding {
  private session: Session | null = null;
  private unloaded = false;
  private current: OnboardState = { kind: "idle" };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: OnboardDeps) {}

  state(): OnboardState {
    const s = this.session;
    const counts = s?.upload?.counts ?? { kind: "reading", done: 0, total: 0 };
    const next: OnboardState = s && this.running(s) ? { kind: "running", phase: counts.kind, done: counts.done, total: counts.total } : this.deps.record.read() !== null && !this.deps.repoChosen() ? { kind: "stopped" } : { kind: "idle" };
    const same = next.kind === this.current.kind && (next.kind !== "running" || (this.current.kind === "running" && next.phase === this.current.phase && next.done === this.current.done && next.total === this.current.total));
    if (!same) this.current = next;
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  unload(): void {
    this.unloaded = true;
    if (this.session) this.end(this.session);
  }

  start(): void {
    if (this.deps.repoChosen()) return;
    if (this.session && this.again(this.session)) return;
    const typed = safeRepoName(this.deps.vaultName()) ?? "";
    const s = this.newSession(typed);
    this.session = s;
    this.emit();
    this.showName(s);
    this.load(s);
  }

  async resume(): Promise<void> {
    if (this.session && this.again(this.session)) return;
    const record = this.deps.record.read();
    if (record === null) return;
    const s = this.newSession(nameOf(record.repo));
    s.private = record.private ?? true;
    this.session = s;
    if (!this.deps.signedIn() && (await this.deps.signIn({ install: false })) !== "signed_in") {
      this.end(s);
      return this.deps.notify(SIGN_IN_UNFINISHED);
    }
    if (s.ended) return;
    if (record.private === false) {
      if (!(await this.confirmPublicRepo(s, record.repo))) {
        this.end(s);
        return;
      }
      if (s.ended) return;
      s.confirmedPublic = record.repo;
    }
    if (record.uploaded === true) {
      s.upload = { repo: record.repo, counts: null, waiting: null };
      return void this.link(s, record.repo);
    }
    this.beginUpload(s, record.repo);
  }

  bringForward(): void {
    if (this.session) this.forward(this.session);
  }

  onLoad(): void {
    if (this.deps.record.read() === null) return;
    if (this.deps.repoChosen()) this.deps.record.clear();
    else this.deps.notifyWithAction(STOPPED, CONTINUE, () => void this.resume());
    this.emit();
  }

  private newSession(typed: string): Session {
    return {
      typed,
      private: true,
      confirmedPublic: null,
      name: "",
      plan: null,
      account: null,
      planFailed: false,
      problem: null,
      view: null,
      windowOpen: false,
      upload: null,
      stopRequested: false,
      notice: null,
      watching: null,
      refused: false,
      pressing: false,
      ended: false,
    };
  }

  private forward(s: Session): boolean {
    if (this.deps.ui.bringForward()) return true;
    if (!this.running(s)) return false;
    this.show(s, this.uploadView(s));
    return true;
  }

  private running(s: Session): boolean {
    return s.upload !== null && s.view?.step === "upload";
  }

  private again(s: Session): boolean {
    if (this.forward(s)) return true;
    this.end(s);
    return false;
  }

  private end(s: Session): void {
    s.ended = true;
    s.watching = null;
    s.notice?.hide();
    s.notice = null;
    s.windowOpen = false;
    this.deps.ui.close();
    if (this.session === s) this.session = null;
    this.emit();
  }

  private show(s: Session, view: OnboardView): void {
    if (s.ended) return;
    s.view = view;
    s.windowOpen = true;
    s.notice?.hide();
    s.notice = null;
    this.deps.ui.show(view, this.events(s));
  }

  private close(s: Session): void {
    s.windowOpen = false;
    this.deps.ui.close();
  }

  private events(s: Session): OnboardEvents {
    const live = (run: () => void | Promise<void>) => () => void (!s.ended && this.session === s ? run() : undefined);
    return {
      edit: (typed, isPrivate) => {
        s.typed = typed;
        s.private = isPrivate;
        if (isPrivate) s.confirmedPublic = null;
      },
      press: (typed, isPrivate) => {
        s.typed = typed;
        s.private = isPrivate;
        if (isPrivate) s.confirmedPublic = null;
        if (!s.ended) void this.press(s);
      },
      closed: live(() => {
        const step = s.view?.step;
        s.windowOpen = false;
        if (step === "upload") this.hide(s);
        else this.end(s);
      }),
      openAgain: live(() => this.openInstall(s)),
      lookAgain: live(() => this.lookAgain(s)),
      openGithub: live(() => {
        if (s.account) this.deps.openUrl(this.formAddress(s, s.account));
      }),
      giveAccess: live(() => this.openInstall(s)),
      stop: live(() => {
        s.stopRequested = true;
        this.end(s);
      }),
      startAgain: live(() => this.startAgain(s)),
      tryAgain: live(() => {
        const { upload, view } = s;
        if (!upload || view?.step !== "problem") return;
        if (view.why === "link") void this.link(s, upload.repo);
        else this.beginUpload(s, upload.repo);
      }),
      openOnGitHub: live(() => {
        if (s.upload) this.deps.openUrl(`https://github.com/${s.upload.repo}`);
      }),
    };
  }

  private openInstall(s: Session): void {
    if (s.account?.installUrl) this.deps.openUrl(s.account.installUrl);
  }

  private nameView(s: Session): OnboardView {
    return { step: "name", typed: s.typed, private: s.private, plan: s.plan, unread: s.planFailed, account: s.account, signedIn: this.deps.signedIn(), problem: s.problem };
  }

  private showName(s: Session): void {
    this.show(s, this.nameView(s));
  }

  private redrawName(s: Session): void {
    if (s.windowOpen && s.view?.step === "name") this.showName(s);
  }

  private load(s: Session): void {
    if (s.plan === null)
      void this.deps.plan().then(
        (plan) => {
          s.plan = plan;
          this.redrawName(s);
        },
        () => {
          s.planFailed = true;
          s.problem = VAULT_UNREAD;
          this.redrawName(s);
        },
      );
    if (this.deps.signedIn() && s.account === null)
      void this.account().then((account) => {
        s.account = account;
        this.redrawName(s);
      });
  }

  private async ask(action: string, body: Record<string, unknown>): Promise<ApiAnswer | null> {
    try {
      return await this.deps.call(action, body);
    } catch {
      return null;
    }
  }

  private async account(): Promise<OnboardAccount | null> {
    return accountFrom(await this.ask("account", {}));
  }

  private back(s: Session, problem: string | null): void {
    s.problem = problem;
    s.pressing = false;
    this.showName(s);
  }

  private async press(s: Session): Promise<void> {
    if (s.pressing) return;
    if (s.planFailed) {
      s.planFailed = false;
      s.problem = null;
      this.showName(s);
      return this.load(s);
    }
    if (s.plan === null) return;
    const name = safeRepoName(s.typed);
    if (name === null) return this.back(s, BAD_NAME);
    if (s.plan.totalBytes > VAULT_MAX_TOTAL_BYTES || s.plan.files.length > VAULT_MAX_FILES) return;
    s.name = name;
    s.problem = null;
    s.pressing = true;
    try {
      if (!this.deps.signedIn()) return await this.signIn(s);
      const account = s.account ?? (await this.account());
      if (s.ended) return;
      if (account === null) return this.back(s, ACCOUNT_UNREAD);
      await this.proceed(s, account);
    } finally {
      s.pressing = false;
    }
  }

  private async signIn(s: Session): Promise<void> {
    this.close(s);
    const result = await this.deps.signIn({ install: true });
    if (s.ended) return;
    s.account = null;
    if (result === "unfinished") return this.back(s, SIGN_IN_UNFINISHED);
    s.problem = null;
    this.showName(s);
    s.account = await this.account();
    if (s.ended) return;
    this.redrawName(s);
    if (s.account === null) return this.back(s, ACCOUNT_UNREAD);
    await this.proceed(s, s.account);
  }

  private async confirmPublicRepo(s: Session, repo: string): Promise<boolean> {
    if (!this.deps.confirmPublic) return false;
    s.notice?.hide();
    s.notice = null;
    return this.deps.confirmPublic(repo);
  }

  private async handlePublicMismatch(s: Session, repo: string): Promise<void> {
    const ok = await this.confirmPublicRepo(s, repo);
    if (s.ended) return;
    if (ok) {
      s.private = false;
      s.confirmedPublic = repo;
      this.deps.record.write(repo, false);
      this.beginUpload(s, repo);
      return;
    }
    this.deps.record.clear();
    this.problem(s, "public", isPublic(nameOf(repo)), null);
  }

  private async proceed(s: Session, account: OnboardAccount): Promise<void> {
    s.account = account;
    if (!s.private && (account.next === "create" || account.next === "form")) {
      const target = `${account.login}/${s.name}`;
      if (s.confirmedPublic !== target) {
        const ok = await this.confirmPublicRepo(s, target);
        if (s.ended) return;
        if (!ok) return this.back(s, null);
        s.confirmedPublic = target;
      }
    }
    switch (account.next) {
      case "create":
        return this.create(s);
      case "install":
      case "accept":
        if (account.installUrl) this.deps.openUrl(account.installUrl);
        return this.look(s);
      case "form":
        return this.openForm(s, account);
    }
  }

  private async create(s: Session): Promise<void> {
    const { name } = s;
    this.show(s, { step: "creating", name });
    const answer = await this.ask("create", { name, private: s.private });
    const made = answer?.status === 200 && typeof answer.body?.repo === "string" && isRepoName(answer.body.repo) ? answer.body.repo : null;
    if (made !== null) this.deps.record.write(made, s.private);
    if (s.ended) return;
    if (made !== null) {
      s.refused = false;
      return this.beginUpload(s, made);
    }
    if (answer?.code === "name_taken") return this.back(s, nameTaken(name));
    if (answer?.code === "bad_name") return this.back(s, BAD_NAME);
    if (answer?.code !== "cannot_create") return this.back(s, CREATE_FAILED);
    const again = await this.account();
    if (s.ended) return;
    if (again === null) return this.back(s, ACCOUNT_UNREAD);
    const refusedBefore = s.refused;
    s.refused = true;
    await this.proceed(s, refusedBefore && again.next === "create" ? { ...again, next: "form" } : again);
  }

  private look(s: Session): void {
    const account = s.account;
    if (account === null || (account.next !== "install" && account.next !== "accept")) return;
    const why = account.next;
    this.show(s, { step: "waiting", why, name: s.name, notSeen: false });
    this.watch(
      s,
      async (live) => {
        const now = await this.account();
        if (now === null || !live()) return false;
        s.account = now;
        const ready = why === "install" ? now.next !== "install" : now.next === "create";
        if (ready) void this.proceed(s, now);
        return ready;
      },
      () => this.show(s, { step: "waiting", why, name: s.name, notSeen: true }),
    );
  }

  private formAddress(s: Session, account: OnboardAccount): string {
    return `${account.formUrl}&name=${encodeURIComponent(s.name)}&visibility=${s.private ? "private" : "public"}`;
  }

  private openForm(s: Session, account: OnboardAccount): void {
    this.deps.openUrl(this.formAddress(s, account));
    this.lookForRepository(s, account);
  }

  private lookForRepository(s: Session, account: OnboardAccount): void {
    const { name } = s;
    const repo = `${account.login}/${name}`;
    this.show(s, { step: "form", name, canGiveAccess: account.installUrl !== null, notSeen: false });
    this.watch(
      s,
      async (live) => {
        const answer = await this.ask("start", { repo, gitignore: s.plan?.gitignore ?? "", ...(s.private ? { expectPrivate: true } : {}) });
        if (answer === null || !live()) return false;
        if (answer.code === "repo_public" || (answer.status === 200 && s.private && answer.body?.private === false)) {
          s.watching = null;
          void this.handlePublicMismatch(s, repo);
          return true;
        }
        if (answer.status === 200) {
          this.deps.record.write(repo, s.private);
          this.beginUpload(s, repo);
          return true;
        }
        if (answer.code !== "not_empty") return false;
        this.show(s, { step: "problem", why: "not_empty", line: notEmpty(name), action: null });
        return true;
      },
      () => this.show(s, { step: "form", name, canGiveAccess: account.installUrl !== null, notSeen: true }),
    );
  }

  private watch(s: Session, probe: (live: () => boolean) => Promise<boolean>, timedOut: () => void): void {
    const mine = {};
    s.watching = mine;
    const live = (): boolean => s.watching === mine && !s.ended;
    let woken = false;
    let wake: (() => void) | null = null;
    const unsubscribe = this.deps.onFront(() => {
      woken = true;
      wake?.();
    });
    const until = this.deps.now() + LOOK_FOR_MS;
    void (async () => {
      try {
        while (live()) {
          if (this.deps.now() >= until) return timedOut();
          if (await probe(live)) return;
          if (!woken) await Promise.race([this.deps.wait(LOOK_EVERY_MS), new Promise<void>((resume) => (wake = resume))]);
          woken = false;
          wake = null;
        }
      } finally {
        unsubscribe();
      }
    })();
  }

  private lookAgain(s: Session): void {
    const account = s.account;
    if (account === null) return;
    if (s.view?.step === "form") this.lookForRepository(s, account);
    else this.look(s);
  }

  private uploadView(s: Session): OnboardView {
    const counts = s.upload?.counts ?? { kind: "reading", done: 0, total: 0 };
    return { step: "upload", progress: { ...counts, waiting: s.upload?.waiting ?? null } };
  }

  private noticeLine(s: Session): string {
    const { kind, done, total } = s.upload?.counts ?? { kind: "reading", done: 0, total: 0 };
    return underWay(kind, done, total);
  }

  private beginUpload(s: Session, repo: string): void {
    s.upload = { repo, counts: null, waiting: null };
    s.watching = null;
    this.show(s, this.uploadView(s));
    this.emit();
    void this.deps.upload(repo, { progress: (state) => this.progressed(s, state), isCurrent: () => !s.ended && !s.stopRequested && !this.unloaded, expectPrivate: s.private });
  }

  private hide(s: Session): void {
    s.notice = this.deps.progressNotice(this.noticeLine(s));
  }

  private progressed(s: Session, state: UploadProgress): void {
    const { upload } = s;
    if (s.ended || !upload) return;
    switch (state.kind) {
      case "reading":
      case "uploading":
        upload.counts = state;
        upload.waiting = null;
        break;
      case "waiting":
        upload.waiting = state.why;
        break;
      case "done":
        this.deps.record.markUploaded();
        return void this.link(s, state.repo);
      case "stopped":
        return this.end(s);
      case "failed":
        return this.failed(s, state.why, upload.repo);
    }
    if (s.windowOpen && s.view?.step === "upload") this.show(s, this.uploadView(s));
    else s.notice?.set(this.noticeLine(s));
    this.emit();
  }

  private async link(s: Session, repo: string): Promise<void> {
    try {
      await this.deps.apply({ repo, folder: "" });
    } catch {
      return this.problem(s, "link", LINK_FAILED, "try_again");
    }
    this.deps.record.clear();
    if (s.ended) return;
    if (s.windowOpen) {
      this.show(s, { step: "done", repo });
      this.emit();
      return;
    }
    this.deps.notifyWithAction(DONE_TITLE, OPEN_ON_GITHUB, () => this.deps.openUrl(`https://github.com/${repo}`));
    this.end(s);
  }

  private problem(s: Session, why: Extract<OnboardView, { step: "problem" }>["why"], line: string, action: "start_again" | "try_again" | null): void {
    this.show(s, { step: "problem", why, line, action });
    this.emit();
  }

  private failed(s: Session, why: "changed" | "gone" | "not_empty" | "public" | "failed", repo: string): void {
    const name = nameOf(repo);
    if (why === "public") {
      void this.handlePublicMismatch(s, repo);
      return;
    }
    if (why === "not_empty") this.deps.record.clear();
    if (why === "changed") this.problem(s, why, changed(name), "start_again");
    else if (why === "gone") this.problem(s, why, gone(name), "start_again");
    else if (why === "not_empty") this.problem(s, why, notEmpty(name), null);
    else this.problem(s, why, FAILED, "try_again");
  }

  private async startAgain(s: Session): Promise<void> {
    const { upload, view } = s;
    if (view?.step === "problem" && view.why === "changed" && upload) await this.ask("stop", { repo: upload.repo });
    if (s.ended) return;
    this.deps.record.clear();
    s.upload = null;
    s.problem = null;
    s.confirmedPublic = null;
    this.showName(s);
    this.emit();
    this.load(s);
  }
}
