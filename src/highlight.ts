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
    searchOnlyEditableRange: boolean,
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
  onDidChangeContent(listener: () => void): { dispose(): void };
  isDisposed(): boolean;
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
 * wrapper exposes no tokenizer hook. Returns a disposer.
 */
export function attachHighlighting(model: HighlightModel): () => void {
  let ids: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const apply = () => {
    const decorations = RULES.flatMap(([className, regex]) =>
      model
        .findMatches(regex, false, true, true, null, false, MATCH_LIMIT)
        .map(({ range }) => ({ range, options: { inlineClassName: className } })),
    );
    ids = model.deltaDecorations(ids, decorations);
  };

  apply();
  const subscription = model.onDidChangeContent(() => {
    clearTimeout(timer);
    timer = setTimeout(apply, 50);
  });

  return () => {
    clearTimeout(timer);
    subscription.dispose();
    if (!model.isDisposed()) model.deltaDecorations(ids, []);
  };
}
