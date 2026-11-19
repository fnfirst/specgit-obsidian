import { apiVersion, Platform, type Plugin } from "obsidian";
import type { NoteWord } from "../status";
import { ReportModal } from "./modal";
import { alertReportText, buildDetails, platformWords, type ReportApi, ReportForm } from "./report";

export interface ReportSetupDeps {
  api: ReportApi;

  server: () => string;
  version: string;

  repository: () => string;
  signedIn: () => boolean;

  noteState: () => NoteWord | null;
}

export interface ReportHandle {

  open(message?: string): void;

  openForAlert(title: string, description?: string): void;
}

export function setUpReport(plugin: Plugin, deps: ReportSetupDeps): ReportHandle {

  let draft: { form: ReportForm; fromAlert: boolean } | null = null;
  const open = (message = ""): void => {
    const reuse = message === "" && draft !== null && draft.form.message !== "";
    const form = new ReportForm(
      {
        api: deps.api,
        signedIn: deps.signedIn,
        server: deps.server,
        details: () =>
          buildDetails({
            pluginVersion: deps.version,
            obsidianVersion: apiVersion,
            platform: platformWords(Platform),
            repository: deps.repository(),
            signedIn: deps.signedIn(),
            noteState: deps.noteState(),
          }),
        copy: (text) => navigator.clipboard.writeText(text),
        openUrl: (url) => void window.open(url),
      },
      reuse ? draft!.form.message : message,
    );

    const fromAlert = reuse ? draft!.fromAlert : message !== "";
    draft = { form, fromAlert };
    new ReportModal(plugin.app, form, fromAlert, () => (draft = null)).open();
  };
  plugin.addCommand({ id: "report-a-problem", name: "Report a problem", callback: () => open() });
  return { open, openForAlert: (title, description) => open(alertReportText(title, description)) };
}
