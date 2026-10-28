interface Range {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** The slice of Monaco's ITextModel used here; keeps the build independent of monaco's typings. */
export interface HighlightModel {
  findMatches(
    search: string,
    searchScope: Range,
    isRegex: boolean,
    matchCase: boolean,
    wordSeparators: string | null,
    captureMatches: boolean,
    limitResultCount?: number,
  ): { range: Range }[];
  deltaDecorations(
    oldIds: string[],
    decorations: { range: Range; options: { inlineClassName: string } }[],
  ): string[];
  getLineCount(): number;
  getLineMaxColumn(line: number): number;
  onDidChangeContent(listener: () => void): { dispose(): void };
  isDisposed(): boolean;
}

/** The slice of Monaco's editor used to find what is on screen. */
export interface HighlightEditor {
  getVisibleRanges(): { startLineNumber: number; endLineNumber: number }[];
  onDidScrollChange(listener: () => void): { dispose(): void };
}

const LEVELS = (words: string) => new RegExp(`\\b(?:${words})\\b`).source;

// Order matters only for readability; overlapping matches just stack their classes.
const RULES: [className: string, regex: string][] = [
  ["bl-time", "\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?"],
  ["bl-error", LEVELS("ERROR|FATAL|CRITICAL|PANIC|SEVERE")],
  ["bl-warn", LEVELS("WARN|WARNING")],
  ["bl-info", LEVELS("INFO|NOTICE")],
  ["bl-debug", LEVELS("DEBUG|TRACE")],
  ["bl-tag", "\\[(?!(?:ERROR|FATAL|CRITICAL|PANIC|SEVERE|WARN|WARNING|INFO|NOTICE|DEBUG|TRACE)\\])[A-Za-z_][\\w.:-]*\\]"],
  ["bl-uuid", "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b"],
  ["bl-url", "https?://[^\\s\"'<>]+"],
];

// Only the visible lines plus this margin are coloured, so size of the log does not matter.
const MARGIN_LINES = 300;
const MATCH_LIMIT = 5000;

/** Mid-tone colours that stay readable on both light and dark editor themes. */
export const HIGHLIGHT_CSS = `
.BetterLogs .bl-time { color: #7f8fa6 !important; }
.BetterLogs .bl-error { color: #f14c4c !important; font-weight: bold; }
.BetterLogs .bl-warn { color: #d19a00 !important; font-weight: bold; }
.BetterLogs .bl-info { color: #3b9c5a !important; font-weight: bold; }
.BetterLogs .bl-debug { color: #8a8a8a !important; }
.BetterLogs .bl-tag { color: #4a90d9 !important; }
.BetterLogs .bl-uuid { color: #a070c0 !important; }
.BetterLogs .bl-url { color: #2f9ec0 !important; text-decoration: underline; }
`;

/**
 * Colours well-known log tokens through model decorations; the public editor
 * wrapper exposes no tokenizer hook. Only the visible window (+/- MARGIN_LINES)
 * is scanned, and it follows scrolling. Returns a disposer.
 */
export function attachHighlighting(editor: HighlightEditor, model: HighlightModel): () => void {
  let ids: string[] = [];
  let applied: [from: number, to: number] | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const visibleWindow = (): [number, number] | null => {
    const ranges = editor.getVisibleRanges();
    if (!ranges.length) return null;
    const last = model.getLineCount();
    return [
      Math.max(1, ranges[0].startLineNumber - MARGIN_LINES),
      Math.min(last, ranges[ranges.length - 1].endLineNumber + MARGIN_LINES),
    ];
  };

  const apply = () => {
    if (model.isDisposed()) return;
    const range = visibleWindow();
    if (!range) return;
    applied = range;
    const scope = {
      startLineNumber: range[0],
      startColumn: 1,
      endLineNumber: range[1],
      endColumn: model.getLineMaxColumn(range[1]),
    };
    const decorations = RULES.flatMap(([className, regex]) =>
      model
        .findMatches(regex, scope, true, true, null, false, MATCH_LIMIT)
        .map(({ range }) => ({ range, options: { inlineClassName: className } })),
    );
    ids = model.deltaDecorations(ids, decorations);
  };

  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(apply, delay);
  };

  // Re-scan only once the view gets close to the edge of what is already coloured.
  const onScroll = () => {
    const visible = editor.getVisibleRanges();
    if (!applied || !visible.length) return schedule(0);
    const first = visible[0].startLineNumber;
    const end = visible[visible.length - 1].endLineNumber;
    const nearTop = applied[0] > 1 && first < applied[0] + MARGIN_LINES / 3;
    const nearBottom = applied[1] < model.getLineCount() && end > applied[1] - MARGIN_LINES / 3;
    if (nearTop || nearBottom || end > applied[1] || first < applied[0]) schedule(80);
  };

  apply();
  if (!applied) schedule(50); // editor not laid out yet
  const subscriptions = [
    model.onDidChangeContent(() => schedule(50)),
    editor.onDidScrollChange(onScroll),
  ];

  return () => {
    clearTimeout(timer);
    subscriptions.forEach((s) => s.dispose());
    if (!model.isDisposed()) model.deltaDecorations(ids, []);
  };
}
