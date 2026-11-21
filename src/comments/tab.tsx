import { EmptyState } from "../brand/parts";
import { useEffect, useRef, useState } from "preact/hooks";
import { useWatch } from "../panel/use-watch";
import { Face } from "../people/face";
import { OFFLINE_WHY } from "../review/words";
import { plainQuote } from "../shared/anchoring/anchor";
import {
  agentPrefixShown,
  anchorWords,
  type AnchoredThreadView,
  canPost,
  canReply,
  canSendReply,
  carriedChip,
  COMMENT_WORDS,
  commenterName,
  extractSuggestionFromComments,
  failureWords,
  groupThreads,
  historyPending,
  leavesTheList,
  offersApply,
  offersResolveAll,
  offersVersion,
  openListedCount,
  ResolvePause,
  resolvedBadge,
  revisionDivider,
  type RevisionView,
  subjectChip,
  type ThreadFilter,
  timeAgo,
  threadVersions,
  SOMEONE,
} from "../shared/review-flow";
import type { CommentsHub, NoteComments } from "./hub";
import type { ToolbarOffer } from "./toolbar";
import type { FileKind } from "../mapping";
import { COMMENT_BUTTON, commentEmptyWords, NO_NOTE_OPEN, NOT_A_NOTE, PLUGIN_COMMENT_WORDS, TOOLBAR_OFFER } from "./words";

export interface CommentsTabEnv {
  hub: CommentsHub;
  renderBody(element: HTMLElement, markdown: string): () => void;
  canApply(path: string): boolean;
  mobile: boolean;
  toolbar: ToolbarOffer | null;
  told(message: string): void;
  canComment(path: string): boolean;
  startComment(path: string): Promise<void>;
  onSelection(listener: () => void): () => void;
  onEditorSelection: (listener: () => void) => () => void;
  openInSpecgit(path: string): void;
  openUrl(url: string): void;
  error(title: string, description: string): void;
  offline: { is: () => boolean; subscribe: (listener: () => void) => () => void };
  now(): number;
}

const FOCUS_RETRIES_MS = [50, 150, 400] as const;

const FILTERS: readonly ThreadFilter[] = ["open", "resolved", "all"];

export function CommentsTab({ env, path, file }: { env: CommentsTabEnv; path: string | null; file?: FileKind }) {
  const elsewhere = file && NOT_A_NOTE[file];
  if (elsewhere) return <EmptyState icon="message-square">{elsewhere}</EmptyState>;
  if (path === null) return <EmptyState icon="message-square">{NO_NOTE_OPEN}</EmptyState>;
  const note = env.hub.forNote(path);
  return note ? <NoteThreads key={path} env={env} note={note} /> : null;
}

function NoteThreads({ env, note }: { env: CommentsTabEnv; note: NoteComments }) {
  const state = useWatch(note.store.subscribe, note.store.getState);
  const ui = useWatch(note.subscribe, note.getUi);
  const listRef = useRef<HTMLDivElement>(null);
  const { visible, filter, loading, error, revisions, historyLoaded } = state;
  const groups = groupThreads(visible, revisions);
  const openCount = openListedCount(visible);
  const offline = useWatch(env.offline.subscribe, env.offline.is);

  useEffect(() => {
    if (ui.selectedId === null) return;
    const card = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-thread-id]") ?? [])].find((element) => element.dataset.threadId === ui.selectedId);
    card?.scrollIntoView({ block: "nearest" });
  }, [ui.selectedId, visible]);

  useEffect(() => {
    if (ui.posting) listRef.current?.querySelector<HTMLElement>(".specgit-thread.is-pending")?.scrollIntoView({ block: "nearest" });
  }, [ui.posting, visible]);

  return (
    <div class="specgit-comments">
      <div class="specgit-comments-bar">
        <div class="specgit-filters" role="group" aria-label={COMMENT_WORDS.title}>
          {FILTERS.map((name) => (
            <button key={name} type="button" class={`specgit-filter${filter === name ? " is-selected" : ""}`} onClick={() => note.store.setFilter(name)}>
              {name}
            </button>
          ))}
        </div>
        <CommentButton env={env} path={note.path} offline={offline} />
      </div>
      {offline && <p class="specgit-hint" role="status" data-testid="comments-off">{OFFLINE_WHY}</p>}

      {env.toolbar && <ToolbarOfferLine env={env} offer={env.toolbar} />}

      {offersResolveAll({ canWrite: true, available: true, openCount }) && (
        <div class="specgit-bulk">
          <span>{COMMENT_WORDS.openLine(openCount)}</span>
          <button type="button" class="specgit-button" onClick={() => env.openInSpecgit(note.path)}>
            {PLUGIN_COMMENT_WORDS.resolveAllInSpecgit}
          </button>
        </div>
      )}

      <div
        class="specgit-thread-list"
        ref={listRef}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest("[data-thread-id]") && !target.closest("[data-comment-composer]")) note.deselect();
        }}
      >
        {ui.draft && (
          <Composer
            note={note}
            quote={ui.draft.quote}
            body={ui.draftBody}
            posting={ui.posting}
            waiting={ui.waiting}
            offline={offline}
            focusRequests={ui.focusRequests}
            onEditorSelection={env.onEditorSelection}
          />
        )}
        {loading && <p class="specgit-comments-note">{COMMENT_WORDS.loading}</p>}
        {error && <p class="specgit-comments-note is-error">{error}</p>}
        {!loading && !error && visible.length === 0 && !ui.draft && <EmptyState icon="message-square">{commentEmptyWords(env.mobile)}</EmptyState>}
        {groups.map((group) => (
          <section key={group.key} data-group={group.key}>
            {group.label && <h3 class="specgit-group-heading">{group.label}</h3>}
            {group.threads.map((thread) => (
              <Card key={thread.id} env={env} note={note} thread={thread} filter={filter} selected={ui.selectedId === thread.id} applying={ui.applyingId === thread.id} offline={offline} revisions={revisions} />
            ))}
          </section>
        ))}
        {historyPending(filter, historyLoaded, revisions) && <p class="specgit-comments-note">{COMMENT_WORDS.historyLoading}</p>}
      </div>
    </div>
  );
}

function CommentButton({ env, path, offline }: { env: CommentsTabEnv; path: string; offline: boolean }) {
  const [can, setCan] = useState(() => env.canComment(path));
  useEffect(() => {
    const check = (): void => setCan(env.canComment(path));
    check();
    return env.onSelection(check);
  }, [env, path]);
  return (
    <button type="button" class="specgit-button is-primary" data-testid="comment-button" disabled={!can || offline} title={offline ? OFFLINE_WHY : can ? undefined : COMMENT_BUTTON.select} onClick={() => void env.startComment(path)}>
      {COMMENT_BUTTON.label}
    </button>
  );
}

function ToolbarOfferLine({ env, offer }: { env: CommentsTabEnv; offer: ToolbarOffer }) {
  const [shown, setShown] = useState(() => offer.shown());
  if (!shown) return null;
  const add = (): void => {
    env.told(offer.add() ? TOOLBAR_OFFER.added : TOOLBAR_OFFER.notAdded);
    setShown(false);
  };
  return (
    <div class="specgit-toolbar-offer" data-testid="toolbar-offer">
      <button type="button" class="mod-cta specgit-toolbar-offer-add" onClick={add}>
        {TOOLBAR_OFFER.offer}
      </button>
      <button
        type="button"
        class="specgit-button is-link"
        onClick={() => {
          offer.dismiss();
          setShown(false);
        }}
      >
        {TOOLBAR_OFFER.dismiss}
      </button>
    </div>
  );
}

function Composer({
  note,
  quote,
  body,
  posting,
  waiting,
  offline,
  focusRequests,
  onEditorSelection,
}: {
  note: NoteComments;
  quote: string;
  body: string;
  posting: boolean;
  waiting: boolean;
  offline: boolean;
  focusRequests: number;
  onEditorSelection: CommentsTabEnv["onEditorSelection"];
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!note.claimFocus(focusRequests)) return;
    const doc = field.current?.doc ?? activeDocument;
    const take = (): void => {
      const now = doc.activeElement;
      if (!now || now === doc.body || now.closest(".cm-editor") || now === field.current) field.current?.focus();
    };
    take();
    const later = FOCUS_RETRIES_MS.map((ms) => window.setTimeout(take, ms));
    const stop = (): void => later.forEach((timer) => window.clearTimeout(timer));
    const away = (event: Event): void => {
      const target = event.target as Node | null;
      if (!(target?.instanceOf(Node) && field.current?.closest("[data-comment-composer]")?.contains(target))) stop();
    };
    doc.addEventListener("pointerdown", away, true);
    doc.addEventListener("keydown", away, true);
    const unsubscribe = onEditorSelection(stop);
    return () => {
      stop();
      doc.removeEventListener("pointerdown", away, true);
      doc.removeEventListener("keydown", away, true);
      unsubscribe();
    };
  }, [note, focusRequests, onEditorSelection]);
  const send = (): void => void note.postDraft();
  return (
    <div class="specgit-composer" data-comment-composer data-send-scope>
      <div class="specgit-composer-quote">
        <blockquote>{plainQuote(quote) === "" ? COMMENT_WORDS.selectionFallback : plainQuote(quote)}</blockquote>
        <button type="button" class="specgit-icon-button" aria-label={COMMENT_WORDS.cancel} onClick={() => note.cancelDraft()}>
          ×
        </button>
      </div>
      <textarea
        ref={field}
        rows={3}
        value={body}
        placeholder={COMMENT_WORDS.composerPlaceholder}
        disabled={posting}
        onInput={(event) => note.setDraftBody((event.target as HTMLTextAreaElement).value)}
      />
      <div class="specgit-composer-actions">
        <button type="button" class="specgit-button" onClick={() => note.cancelDraft()}>
          {COMMENT_WORDS.cancel}
        </button>
        <button type="button" class="specgit-button is-primary" data-send disabled={!canPost(body, posting, offline)} onClick={send}>
          {waiting ? COMMENT_WORDS.waitingForSave : posting ? COMMENT_WORDS.posting : COMMENT_WORDS.comment}
        </button>
      </div>
    </div>
  );
}

interface CardProps {
  env: CommentsTabEnv;
  note: NoteComments;
  thread: AnchoredThreadView;
  filter: ThreadFilter;
  selected: boolean;
  applying: boolean;
  offline: boolean;
  revisions: readonly RevisionView[];
}

function Card({ env, note, thread, filter, selected, applying, offline, revisions }: CardProps) {
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const [confirming, setConfirming] = useState<null | "resolve" | "reopen">(null);
  const [leaving, setLeaving] = useState(false);
  const pause = useRef<ResolvePause | null>(null);
  pause.current ??= new ResolvePause((run, ms) => {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
  });
  const sending = useRef(false);
  useEffect(() => () => pause.current?.flush(), []);

  const quote = anchorWords(thread.anchor);
  const carried = carriedChip(thread);
  const suggests = extractSuggestionFromComments(thread.displayComments) !== null;
  const toggle = (): void => {
    if (confirming || offline) return;
    const action = thread.resolved ? "reopen" : "resolve";
    if (!leavesTheList(filter, action)) {
      void note.store.resolve(thread.id, action === "resolve");
      return;
    }
    setConfirming(action);
    pause.current?.start({
      fade: () => setLeaving(true),
      commit: () => {
        void note.store.resolve(thread.id, action === "resolve");
        setConfirming(null);
        setLeaving(false);
      },
    });
  };

  const send = async (): Promise<void> => {
    if (sending.current || offline) return;
    const body = reply;
    if (body.trim() === "") return;
    sending.current = true;
    setReply("");
    setReplying(true);
    try {
      await note.store.reply(thread.id, body);
    } catch (error) {
      setReply(body);
      env.error(COMMENT_WORDS.replyFailedTitle, failureWords(error));
    } finally {
      sending.current = false;
      setReplying(false);
    }
  };

  const versions = offersVersion(thread, revisions, true) ? threadVersions(thread, revisions) : [];
  const classes = ["specgit-thread", selected ? "is-active" : "", thread.resolved && !confirming ? "is-resolved" : "", thread.pending ? "is-pending" : "", confirming === "resolve" ? "is-confirming" : "", leaving ? "is-leaving" : ""];
  return (
    <div class={classes.filter(Boolean).join(" ")} data-thread-id={thread.id} data-resolving={confirming ?? undefined} onClick={() => note.select(thread.id, "card")}>
      <div class="specgit-thread-badges">
        {(thread.resolved || confirming === "resolve") && <span class="specgit-chip is-success">{resolvedBadge(thread)}</span>}
        {carried && <span class="specgit-chip is-muted">{carried}</span>}
        {thread.reanchorStatus === "outdated" && <span class="specgit-chip is-warning">{COMMENT_WORDS.outdated}</span>}
        {subjectChip(thread) && <span class="specgit-chip is-muted">{subjectChip(thread)}</span>}
        {thread.pending && <span class="specgit-chip is-muted">{COMMENT_WORDS.sendingBadge}</span>}
      </div>
      {quote && suggests && <p class="specgit-suggestion-label">{PLUGIN_COMMENT_WORDS.before}</p>}
      {quote && <blockquote class="specgit-thread-quote">{quote}</blockquote>}
      {thread.reopenedEarlier && <p class="specgit-thread-note">{COMMENT_WORDS.reopenedEarlierNote}</p>}

      {thread.displayComments.map((comment, index) => {
        const divider = revisionDivider(thread.displayComments, index);
        const name = commenterName(comment.author) ?? COMMENT_WORDS.unknownAuthor;
        const url = divider === null ? null : (thread.segments?.find((segment) => segment.prNumber === divider)?.prUrl ?? null);
        return (
          <div key={comment.id}>
            {divider !== null && (
              <div class="specgit-revision">
                {url ? (
                  <a href={url} onClick={(event) => (event.stopPropagation(), env.openUrl(url), event.preventDefault())}>
                    {COMMENT_WORDS.revision(divider)}
                  </a>
                ) : (
                  <span>{COMMENT_WORDS.revision(divider)}</span>
                )}
              </div>
            )}
            <div class={`specgit-comment-row${comment.pending ? " is-pending" : ""}`}>
              <Face src={comment.author?.avatarUrl} name={commenterName(comment.author) ?? SOMEONE} />
              <div class="specgit-comment-main">
                <div class="specgit-comment-head">
                  <span class="specgit-comment-author">{name}</span>
                  {comment.isBot && <span class="specgit-chip">agent</span>}
                  <span class="specgit-comment-when">{comment.pending ? COMMENT_WORDS.sendingAuthor : timeAgo(comment.createdAt, env.now())}</span>
                </div>
                <CommentBody env={env} markdown={agentPrefixShown(comment.body, comment.author)} />
              </div>
            </div>
          </div>
        );
      })}

      <div class="specgit-thread-actions" onClick={(event) => event.stopPropagation()}>
        {offersApply(thread, env.canApply(note.path)) && (
          <button type="button" class="specgit-button" disabled={applying || offline} onClick={() => void note.applySuggestion(thread.id)}>
            {applying ? COMMENT_WORDS.applying : COMMENT_WORDS.apply}
          </button>
        )}
        {versions.length > 0 && (
          <button type="button" class="specgit-button" onClick={() => env.openUrl(versionUrl(note, versions[0]!.sha, versions[0]!.path))}>
            {COMMENT_WORDS.viewVersion}
          </button>
        )}
        <button type="button" class="specgit-button is-link specgit-resolve" disabled={confirming !== null || thread.pending || offline} onClick={toggle}>
          {confirming === "resolve" ? COMMENT_WORDS.resolved : confirming === "reopen" ? COMMENT_WORDS.reopened : thread.resolved ? COMMENT_WORDS.reopen : COMMENT_WORDS.resolve}
        </button>
      </div>

      {canReply(thread, true) && (
        <form
          class="specgit-reply"
          data-send-scope
          onClick={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            rows={2}
            value={reply}
            placeholder={replying ? COMMENT_WORDS.replySending : COMMENT_WORDS.replyPlaceholder}
            disabled={replying}
            onInput={(event) => setReply((event.target as HTMLTextAreaElement).value)}
            onClick={() => note.select(thread.id, "field")}
            onFocus={() => note.select(thread.id, "field")}
          />
          <button type="submit" class="specgit-button is-link" data-send disabled={!canSendReply(reply, replying) || offline}>
            {COMMENT_WORDS.send}
          </button>
        </form>
      )}
    </div>
  );
}

function versionUrl(note: NoteComments, sha: string, path: string): string {
  return `https://github.com/${note.doc.repo}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function CommentBody({ env, markdown }: { env: CommentsTabEnv; markdown: string }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    target.replaceChildren();
    return env.renderBody(target, markdown);
  }, [env, markdown]);
  return <div class="specgit-comment-body" ref={element} />;
}
