import type { FileKind, NoteFile, PathKind, Place } from "../mapping";
import { type LeftOut, leftOutTotal } from "../changes/left-out";

export const CHOOSE_REPOSITORY = "Choose repository";
export const CHANGE = "Change";
export const SEARCH_PLACEHOLDER = "Search your repositories";
export const NO_REPOSITORY_YET = "None chosen yet.";
export const WHOLE_VAULT = "Whole vault";
export const CHOOSE_FOLDER = "Choose folder";
export const CHOOSE_A_REPOSITORY_FIRST = "Choose a repository first, and then its folder.";

export const LOADING_REPOSITORIES = "Looking at your repositories…";
export const NO_REPOSITORIES = "No repositories to show yet. Type a repository as owner/name to use one.";
export const NO_MATCH = "No repository matches that. Type owner/name to use one that isn't in the list.";

export const SIGNED_OUT_LIST = "Sign in to see your repositories, or type one as owner/name.";
export const OFFLINE_LIST = "specgit didn't answer. Check your connection, or type a repository as owner/name.";
export const SLOW_LIST = "GitHub is slow to answer. Try again in a moment, or type a repository as owner/name.";
export const FAILED_LIST = "Couldn't list your repositories. Try again in a moment, or type one as owner/name.";
export const TRY_AGAIN = "Try again";

export const PRIVATE_WORD = "Private";
export const PUBLIC_WORD = "Public";
export const CAN_WRITE = "specgit can write here";
export const READ_ONLY = "Read only for you";
export const NOT_INSTALLED = "specgit doesn't have access here yet";
export const NOT_LISTED = "Not in your list";
export const useRepository = (name: string): string => `Use ${name}`;

export const FOLDER_TITLE = "Choose the vault folder";
export const USE_IT = "Use it";
export const CHOOSE_ANOTHER_FOLDER = "Choose another folder";
export const LOADING_FOLDER = "Looking at this repository's files…";
export const STILL_WORKING = "specgit is still finishing the last step.";
export const FOLDER_PLACEHOLDER = "Search your folders";
export const FOLDER_UNREAD = "specgit couldn't read this repository's files just now, so it can't tell which folder holds them. Use the whole vault, or choose a folder.";
const notes = (count: number): string => (count === 1 ? "1 note" : `${count} notes`);
export const noFilesInVault = (repo: string, total: number): string =>
  total === 0 ? `${repo} has no notes yet. Use the whole vault, or choose a folder for the ones you add.` : `${repo} has ${notes(total)}, none in this vault yet. Choose a folder for ${total === 1 ? "it" : "them"}.`;
export const mirrorsRepository = (repo: string): string => `Your vault holds ${repo}'s files at the top level.`;
export const holdsFiles = (folder: string): string => `Your '${folder}' folder holds this repository's files.`;
export const matchCount = (matched: number, total: number): string => `${matched} of ${total} files are there.`;
export const outsideStays = (folder: string): string => `Notes outside '${folder}' stay in this vault only.`;
export const THING_WORDS: Record<PathKind, string> = { note: "note", board: "board", base: "Bases file", other: "file" };
export const outsideFolderWords = (folder: string, repo: string, file: PathKind): string =>
  `This ${THING_WORDS[file]} is outside ${folder}, so it stays in this vault only.`;

export const NO_REPOSITORY_WORDS = "Choose the GitHub repository your notes belong to. specgit sends your changes there for review.";

export const FILE_WORDS: Record<FileKind, string> = {
  board: "Boards can't be edited live in Obsidian. Submit changes from the Status tab, or open it in specgit.",
  base: "Bases files can't be edited live in Obsidian. Submit changes from the Status tab, or open it in specgit.",
  other: "specgit works with notes, boards and Bases files. Files go with the notes that use them.",
};

export function placeWords(place: Exclude<Place, NoteFile>, linked: { repo: string; folder: string }): string {
  switch (place.kind) {
    case "outside":
      return outsideFolderWords(linked.folder, linked.repo, place.file);
    case "unlinked":
      return NO_REPOSITORY_WORDS;
    default:
      return FILE_WORDS[place.kind];
  }
}

export const copyInTitle = (repo: string): string => `Copy notes in from ${repo}?`;
export const copyInQuestion = (repo: string, count: number): string => `${repo} has ${count === 1 ? "1 note that isn't" : `${count} notes that aren't`} in this vault yet. specgit can copy ${count === 1 ? "it" : "them"} in now. Your other notes stay as they are.`;
export const copyInLabel = (count: number): string => (count === 1 ? "Copy it in" : "Copy them in");
export const NOT_NOW = "Not now";
export const hiddenWords = (count: number): string => (count === 1 ? "1 file in a hidden folder (like .github) stays on GitHub." : `${count} files in hidden folders (like .github) stay on GitHub.`);

export function leftOutWords(left: LeftOut): string {
  const kinds: Array<[number, string, string]> = [[left.html, "HTML page", "HTML pages"], [left.image, "image", "images"], [left.pdf, "PDF", "PDFs"], [left.other, "other file", "other files"]];
  const named = kinds.filter(([n]) => n > 0).map(([n, one, many]) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`);
  const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : (named[0] ?? "");
  const total = leftOutTotal(left);
  const said = total === 1 ? `1 file stays on GitHub because it isn't a note: ${list}.` : `${total.toLocaleString("en-US")} files stay on GitHub because they aren't notes: ${list}.`;
  return left.image > 0 ? `${said} A file a note uses comes in with the note when the note is copied.` : said;
}

export const copyingWords = (done: number, total: number): string => `Copying notes in… ${done} of ${total}`;

export const switchTitle = (to: string): string => `Switch to ${to}?`;
export const switchQuestion = (from: string, unsent: number | null): string =>
  unsent === null ? `specgit couldn't check whether you have changes to ${from} that aren't submitted. Either way, they stay in your vault.` : unsent === 1 ? `1 change to ${from} isn't submitted yet. It shows again when you switch back.` : `${unsent} changes to ${from} aren't submitted yet. They show again when you switch back.`;
export const SWITCH_LABEL = "Switch";
export const stayWith = (from: string): string => `Stay with ${from}`;

export const SETUP_TITLE = "Use this repository?";
export const setupQuestion = (repo: string): string => `A link asked to connect this vault to ${repo}. Only continue if you expected this.`;
export const SETUP_CONFIRM = "Continue";
export const SETUP_CANCEL = "Cancel";
export const SIGN_IN = "Sign in";
export const SETUP_SIGN_IN = "Sign in to specgit first, and then open the link again.";
export const SETUP_BAD_LINK = "That link doesn't name a repository. Open it from a repository's page on specgit.com.";
export const linked = (repo: string): string => `This vault now uses ${repo}.`;
