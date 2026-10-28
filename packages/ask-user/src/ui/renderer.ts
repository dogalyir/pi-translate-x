import { Box, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  QUESTIONNAIRE_ENTRY_TYPE,
  isDurableQuestionnaireRecord,
  type DurableQuestionnaireRecord,
} from "../persistence/record.js";

export function renderQuestionnaireEntry(
  entry: { data?: unknown },
  options: { expanded?: boolean } | undefined,
  theme: Theme,
): Box {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

  if (!isDurableQuestionnaireRecord(entry.data)) {
    box.addChild(new Text(theme.fg("dim", "[Questionnaire record unavailable]"), 0, 0));
    return box;
  }

  const record: DurableQuestionnaireRecord = entry.data;
  const title = record.canonical.title ?? "Bilingual Questionnaire";
  const dateStr = new Date(record.createdAt).toLocaleTimeString();
  const langBadge = record.display?.language ? `[${record.display.language.toUpperCase()}]` : "";

  box.addChild(
    new Text(
      `${theme.style(title, { bold: true, fg: "accent" })} ${theme.fg("dim", langBadge)} ${theme.fg("dim", `(${dateStr})`)}`,
      0,
      0,
    ),
  );

  for (const ans of record.canonical.answers) {
    const header = ans.questionHeader;
    const labels = ans.selectedOptionLabels.length > 0
      ? ans.selectedOptionLabels.join(", ")
      : ans.customText ? `Custom: ${ans.customText}` : "(None)";

    let line = `  ${theme.style(header, { bold: true })}: ${labels}`;
    if (ans.customText && ans.selectedOptionLabels.length > 0) {
      line += ` (Custom: ${ans.customText})`;
    }
    box.addChild(new Text(line, 0, 0));

    if (ans.notes) {
      box.addChild(new Text(`    ${theme.fg("dim", `Note: ${ans.notes}`)}`, 0, 0));
    }
  }

  if (record.canonical.globalUserNotes) {
    box.addChild(
      new Text(
        `  ${theme.style("Global Notes", { bold: true })}: ${record.canonical.globalUserNotes}`,
        0,
        0,
      ),
    );
  }

  if (options?.expanded && record.display) {
    box.addChild(new Text(theme.fg("dim", "  ─ Localized Display ─"), 0, 0));
    for (const dq of record.display.questions) {
      box.addChild(new Text(theme.fg("dim", `    ${dq.header}: ${dq.prompt}`), 0, 0));
      if (dq.description) {
        box.addChild(new Text(theme.fg("dim", `      ${dq.description}`), 0, 0));
      }
      if (dq.options) {
        for (const opt of dq.options) {
          let optLine = `      • ${opt.label}`;
          if (opt.description) optLine += ` - ${opt.description}`;
          box.addChild(new Text(theme.fg("dim", optLine), 0, 0));
          if (opt.preview) {
            box.addChild(new Text(theme.fg("dim", `        Preview: ${opt.preview.replace(/\n/g, " ")}`), 0, 0));
          }
        }
      }
    }
  }

  return box;
}

export function registerQuestionnaireRenderer(pi: {
  registerEntryRenderer: (type: string, renderer: (entry: any, opts: any, theme: any) => any) => void;
}): void {
  pi.registerEntryRenderer(QUESTIONNAIRE_ENTRY_TYPE, (entry, opts, theme) => {
    return renderQuestionnaireEntry(entry, opts, theme);
  });
}
