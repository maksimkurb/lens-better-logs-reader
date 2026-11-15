import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Renderer } from "@freelensapp/extensions";
import { LogSource, stripTimestamps, type Target } from "./log-source";
import { attachHighlighting, HIGHLIGHT_CSS, type HighlightEditor, type HighlightModel } from "./highlight";


const POLL_MS = 2000;
const OLDER_AT_PX = 100;
const SEARCH_DELAY_MS = 400;

// Hide everything the built-in tab renders inside its log list, and its search box
// (the editor has its own, Ctrl+F). The built-in controls row stays and drives us.
const STYLE = `
.PodLogs .LogList > :not(.BetterLogs) { display: none !important; }
.PodLogs .LogSearch { display: none !important; }
/* Keep native selection out of the gutter, so double-click selects words only. */
.BetterLogs .margin, .BetterLogs .margin * { user-select: none !important; -webkit-user-select: none !important; }
.BetterLogs .bl-loading { display: flex; align-items: center; height: 100%; padding-left: 8px; opacity: 0.7; font-size: 12px; }
.BetterLogs .bl-dots i { display: inline-block; width: 4px; height: 4px; margin-right: 4px; border-radius: 50%; background: currentColor; animation: bl-blink 1.2s infinite ease-in-out both; }
.BetterLogs .bl-dots i:nth-child(2) { animation-delay: 0.2s; }
.BetterLogs .bl-dots i:nth-child(3) { animation-delay: 0.4s; }
@keyframes bl-blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
${HIGHLIGHT_CSS}`;

interface View {
  target: Target | null;
  timestamps: boolean;
  wrap: boolean;
}

/** The slice of Monaco's editor API used here. */
interface Editor extends HighlightEditor {
  getModel(): HighlightModel | null;
  onDidChangeModel(listener: () => void): { dispose(): void };
  onDidContentSizeChange(listener: () => void): { dispose(): void };
  onDidScrollChange(listener: () => void): { dispose(): void };
  getTopForLineNumber(line: number): number;
  getScrollTop(): number;
  getScrollHeight(): number;
  getLayoutInfo(): { height: number };
  setScrollTop(top: number): void;
  changeViewZones(callback: (accessor: ViewZoneAccessor) => void): void;
}

interface PrependableModel {
  getValue(): string;
  applyEdits(edits: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }[]): void;
}

interface ViewZoneAccessor {
  addZone(zone: { afterLineNumber: number; heightInPx: number; domNode: HTMLElement }): string;
  removeZone(id: string): void;
}

/** A line above the first one with animated dots, shown while older lines are being fetched. */
function showLoadingLine(editor: Editor): () => void {
  const node = document.createElement("div");
  node.className = "bl-loading";
  node.innerHTML = '<span class="bl-dots"><i></i><i></i><i></i></span>';
  let id = "";
  editor.changeViewZones((a) => (id = a.addZone({ afterLineNumber: 0, heightInPx: 20, domNode: node })));
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    editor.changeViewZones((a) => a.removeZone(id));
  };
}

const text = (root: Element, selector: string) =>
  root.querySelector(selector)?.textContent?.trim() ?? "";

const checked = (root: Element, selector: string) =>
  root.querySelector(selector)?.classList.contains("checked") ?? false;

/** The built-in tab owns pod/container selection and the toggles; we read them from its DOM. */
function readView(root: Element): View {
  const namespace = text(root, '[data-testid="namespace-badge"]');
  const pod = text(root, ".pod-selector");
  const container = text(root, ".container-selector");
  return {
    target:
      namespace && pod && container
        ? { namespace, pod, container, previous: checked(root, ".show-previous") }
        : null,
    timestamps: checked(root, ".show-timestamps"),
    wrap: checked(root, ".show-word-wrap"),
  };
}

/** Adds a host inside the built-in log list, which already has the right size and position. */
function mountHost(root: Element): HTMLElement | null {
  const list = root.querySelector<HTMLElement>(".LogList");
  if (!list || list.querySelector(":scope > .BetterLogs")) return null;
  const host = document.createElement("div");
  host.className = "BetterLogs";
  host.style.cssText = "position: absolute; inset: 0; overflow: hidden;";
  list.append(host);
  return host;
}

/**
 * The MonacoEditor component exposes no editor handle (its `innerRef` is unused), so read the
 * instance off the component in the React tree. This is the one place that depends on that.
 */
function findEditor(host: HTMLElement): Editor | null {
  // Preferred: ask the host's Monaco which editors exist and take the one inside our host.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monaco = (globalThis as any).FreelensExtensionApi?.MonacoEditor;
    const found = monaco?.editor?.getEditors?.().find((e: Editor & { getContainerDomNode(): HTMLElement }) =>
      host.contains(e.getContainerDomNode()),
    );
    if (found) return found;
  } catch {
    // fall through to the React tree
  }
  const element = host.querySelector('[data-test-id="monaco-editor"]');
  const key = element && Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fiber: any = key ? (element as any)[key] : null;
  while (fiber && !fiber.stateNode?.editor?.getScrollTop) fiber = fiber.return;
  return fiber?.stateNode.editor ?? null;
}

/**
 * Monaco searches the whole model on every keystroke of its find box, which stalls on big logs.
 * Hold typed input back until the user pauses (Enter searches at once).
 */
function delaySearchInput(host: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  let replaying = false;
  const flush = () => {
    clearTimeout(timer);
    const fire = release;
    release = undefined;
    fire?.();
  };
  const onInput = (event: Event) => {
    const input = event.target as HTMLElement;
    if (replaying || !input.closest?.(".find-widget")) return;
    event.stopImmediatePropagation();
    clearTimeout(timer);
    release = () => {
      replaying = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      replaying = false;
    };
    timer = setTimeout(flush, SEARCH_DELAY_MS);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") flush();
  };
  host.addEventListener("input", onInput, true);
  host.addEventListener("keydown", onKeyDown, true);
  return () => {
    clearTimeout(timer);
    host.removeEventListener("input", onInput, true);
    host.removeEventListener("keydown", onKeyDown, true);
  };
}

const atBottom = (editor: Editor) =>
  editor.getScrollTop() + editor.getLayoutInfo().height >= editor.getScrollHeight() - 2;

function LogsView({ root, host }: { root: Element; host: HTMLElement }) {
  const [logs, setLogs] = useState("");
  const [view, setView] = useState<View>(() => readView(root));
  const stickToBottom = useRef(true);
  const editorRef = useRef<Editor | null>(null);
  const sourceRef = useRef<LogSource | null>(null);
  // Line to keep in place after older lines were added in front of it.
  const anchorLine = useRef<number | null>(null);
  const loadingOlder = useRef(false);
  const positioned = useRef(false);
  const timestampsRef = useRef(false);

  // React to the built-in controls as soon as they change.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = readView(root);
      setView((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const observer = new MutationObserver((mutations) => {
      if (mutations.every((m) => host.contains(m.target))) return; // our own editor churn
      if (!frame) frame = requestAnimationFrame(update);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [root, host]);

  // Highlighting and follow-the-tail, through the editor API.
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    // The editor is created by the host component after it mounts; wait for it.
    let frame = 0;
    let tries = 0;
    const look = () => {
      const found = findEditor(host);
      if (found) setEditor(found);
      else if (tries++ < 600) frame = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(frame);
  }, [host]);

  useEffect(() => {
    editorRef.current = editor;
    if (!editor) return;
    let detach: (() => void) | undefined;
    const attach = () => {
      detach?.();
      const model = editor.getModel();
      detach = model ? attachHighlighting(editor, model) : undefined;
    };
    attach();
    const subscriptions = [
      editor.onDidChangeModel(attach),
      // Fires once new text is laid out, which is also the first open.
      editor.onDidContentSizeChange(() => {
        if (anchorLine.current !== null) {
          editor.setScrollTop(editor.getTopForLineNumber(anchorLine.current));
          anchorLine.current = null;
        } else if (stickToBottom.current) {
          editor.setScrollTop(editor.getScrollHeight());
          positioned.current = true;
        }
      }),
      // Like the built-in list, fetch earlier lines when the top is reached.
      editor.onDidScrollChange(async () => {
        const source = sourceRef.current;
        // `positioned`: the first scroll to the tail has happened, so a scrollTop near 0 is the user's.
        if (!source?.hasOlder || loadingOlder.current || !positioned.current || editor.getScrollTop() > OLDER_AT_PX) return;
        loadingOlder.current = true;
        stickToBottom.current = false; // we are at the top, not following the tail
        // Where the first visible line sits inside the viewport; restored after the prepend.
        const first = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
        const offset = editor.getTopForLineNumber(first) - editor.getScrollTop();
        const hideLoading = showLoadingLine(editor);
        try {
          await source.loadOlder();
          if (sourceRef.current !== source) return;
          hideLoading();
          const shown = timestampsRef.current ? source.text : stripTimestamps(source.text);
          const model = editor.getModel() as unknown as PrependableModel | null;
          const current = model?.getValue() ?? "";
          if (model && shown.length > current.length && shown.endsWith(current)) {
            // Insert the older lines in front instead of replacing the text, so Monaco keeps the
            // rest of the editor as it is, then put the same line back where it was.
            const prefix = shown.slice(0, shown.length - current.length);
            model.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: prefix }]);
            const added = prefix.split("\n").length - 1;
            const restore = () => editor.setScrollTop(editor.getTopForLineNumber(first + added) - offset);
            restore();
            requestAnimationFrame(restore);
            setLogs(source.text);
          } else if (shown !== current) {
            anchorLine.current = first + Math.max(0, shown.split("\n").length - current.split("\n").length);
            setLogs(source.text);
          }
        } catch {
          // Try again on the next scroll.
        } finally {
          hideLoading();
          loadingOlder.current = false;
        }
      }),
    ];
    const stopDelaying = delaySearchInput(host);
    return () => {
      stopDelaying();
      subscriptions.forEach((s) => s.dispose());
      detach?.();
    };
  }, [editor, host]);

  timestampsRef.current = view.timestamps;
  const key = JSON.stringify(view.target);

  useEffect(() => {
    setLogs("");
    stickToBottom.current = true;
    positioned.current = false;
    anchorLine.current = null;
    const target: Target | null = JSON.parse(key);
    if (!target) return;
    const source = new LogSource(target);
    sourceRef.current = source;
    let cancelled = false;

    const load = async () => {
      try {
        if (!(await source.refresh()) || cancelled) return;
        // Remember where the view was before the update; the editor follows once it has laid out.
        const editor = editorRef.current;
        stickToBottom.current = editor ? atBottom(editor) : true;
        setLogs(source.text);
      } catch (error) {
        if (!cancelled && !source.text) setLogs(`Failed to load logs: ${error}`);
      }
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      source.dispose();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [key]);

  const { MonacoEditor } = Renderer.Component;
  const shown = useMemo(() => (view.timestamps ? logs : stripTimestamps(logs)), [logs, view.timestamps]);

  return (
    <MonacoEditor
      id={`better-logs-${view.target?.pod ?? "none"}`}
      readOnly
      value={shown}
      language={"plaintext" as "yaml"}
      options={{
        minimap: { enabled: false },
        lineNumbers: "off",
        folding: false,
        lineDecorationsWidth: 8,
        wordWrap: view.wrap ? "on" : "off",
        scrollBeyondLastLine: false,
        padding: { top: 4, bottom: 8 },
        renderLineHighlight: "none",
        automaticLayout: true,
        contextmenu: false,
      }}
      // The wrapper otherwise sizes itself from the line count.
      style={{ position: "absolute", inset: 0, height: "100%" }}
    />
  );
}

/** Watches for the built-in logs tab and swaps its list for a Monaco editor. */
export function LogsOverlay() {
  const [mounts, setMounts] = useState<{ root: Element; host: HTMLElement }[]>([]);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);

    const scan = () => {
      const added: { root: Element; host: HTMLElement }[] = [];
      document.querySelectorAll(".PodLogs").forEach((root) => {
        const host = mountHost(root);
        if (host) added.push({ root, host });
      });
      setMounts((prev) => {
        const alive = prev.filter(({ host }) => host.isConnected);
        return alive.length === prev.length && !added.length ? prev : [...alive, ...added];
      });
    };
    scan();
    const observer = new MutationObserver((mutations) => {
      // The editor churns the DOM constantly while scrolling; only tab changes matter.
      if (mutations.every((m) => (m.target as Element).closest?.(".BetterLogs"))) return;
      scan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      style.remove();
    };
  }, []);

  return <>{mounts.map(({ root, host }, i) => createPortal(<LogsView root={root} host={host} />, host, String(i)))}</>;
}
