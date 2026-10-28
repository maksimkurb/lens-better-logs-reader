import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Renderer } from "@freelensapp/extensions";
import { attachHighlighting, HIGHLIGHT_CSS, type HighlightModel } from "./highlight";

const { MonacoEditor } = Renderer.Component;
const { podsApi } = Renderer.K8sApi;

const POLL_MS = 2000;
const TAIL_LINES = 20000;

// Hide everything the built-in tab renders inside its log list, and its search box
// (the editor has its own, Ctrl+F). The built-in controls row stays and drives us.
const STYLE = `
.PodLogs .LogList > :not(.BetterLogs) { display: none !important; }
.PodLogs .LogSearch { display: none !important; }
/* Keep native selection out of the gutter, so double-click selects words only. */
.BetterLogs .margin, .BetterLogs .margin * { user-select: none !important; -webkit-user-select: none !important; }
${HIGHLIGHT_CSS}`;

interface Target {
  namespace: string;
  pod: string;
  container: string;
  previous: boolean;
}

interface View {
  target: Target | null;
  timestamps: boolean;
  wrap: boolean;
}

/** The slice of Monaco's editor API used here. */
interface Editor {
  getModel(): HighlightModel | null;
  onDidChangeModel(listener: () => void): { dispose(): void };
  onDidContentSizeChange(listener: () => void): { dispose(): void };
  getScrollTop(): number;
  getScrollHeight(): number;
  getLayoutInfo(): { height: number };
  setScrollTop(top: number): void;
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
  const element = host.querySelector('[data-test-id="monaco-editor"]');
  const key = element && Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fiber: any = key ? (element as any)[key] : null;
  while (fiber && !fiber.stateNode?.editor?.getScrollTop) fiber = fiber.return;
  return fiber?.stateNode.editor ?? null;
}

const atBottom = (editor: Editor) =>
  editor.getScrollTop() + editor.getLayoutInfo().height >= editor.getScrollHeight() - 2;

// kubectl-style RFC3339 prefix added when asking the API for timestamps.
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}) /gm;

function LogsView({ root, host }: { root: Element; host: HTMLElement }) {
  const [logs, setLogs] = useState("");
  const [view, setView] = useState<View>(() => readView(root));
  const stickToBottom = useRef(true);
  const editorRef = useRef<Editor | null>(null);

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
  useEffect(() => {
    const editor = findEditor(host);
    editorRef.current = editor;
    if (!editor) return;
    let detach: (() => void) | undefined;
    const attach = () => {
      detach?.();
      const model = editor.getModel();
      detach = model ? attachHighlighting(model) : undefined;
    };
    attach();
    const subscriptions = [
      editor.onDidChangeModel(attach),
      // Fires once new text is laid out, which is also the first open.
      editor.onDidContentSizeChange(() => {
        if (stickToBottom.current) editor.setScrollTop(editor.getScrollHeight());
      }),
    ];
    return () => {
      subscriptions.forEach((s) => s.dispose());
      detach?.();
    };
  }, [host]);

  const key = JSON.stringify(view.target);

  useEffect(() => {
    setLogs("");
    stickToBottom.current = true;
    const target: Target | null = JSON.parse(key);
    if (!target) return;
    let cancelled = false;

    const load = async () => {
      try {
        // Always fetch timestamps, so toggling them is a local change rather than a refetch.
        const result = await podsApi.getLogs(
          { name: target.pod, namespace: target.namespace },
          { container: target.container, timestamps: true, previous: target.previous, tailLines: TAIL_LINES },
        );
        if (cancelled) return;
        // Remember where the view was before the update; the editor follows once it has laid out.
        const editor = editorRef.current;
        stickToBottom.current = editor ? atBottom(editor) : true;
        setLogs((prev) => (prev === result ? prev : result));
      } catch (error) {
        if (!cancelled) setLogs(`Failed to load logs: ${error}`);
      }
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);

  const shown = useMemo(() => (view.timestamps ? logs : logs.replace(TIMESTAMP_PREFIX, "")), [logs, view.timestamps]);

  return (
    <MonacoEditor
      id={`better-logs-${view.target?.pod ?? "none"}`}
      readOnly
      value={shown}
      language={"plaintext" as "yaml"}
      options={{
        minimap: { enabled: false },
        lineNumbers: "on",
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
