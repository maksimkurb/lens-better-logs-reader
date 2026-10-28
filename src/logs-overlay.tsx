import React, { useEffect, useRef, useState } from "react";
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
  timestamps: boolean;
  previous: boolean;
}

interface View {
  target: Target | null;
  wrap: boolean;
}

const text = (root: Element, selector: string) =>
  root.querySelector(selector)?.textContent?.trim() ?? "";

const checked = (root: Element, selector: string) =>
  root.querySelector<HTMLInputElement>(`${selector} input`)?.checked ?? false;

/** The built-in tab owns pod/container selection and the toggles; we read them from its DOM. */
function readView(root: Element): View {
  const namespace = text(root, '[data-testid="namespace-badge"]');
  const pod = text(root, ".pod-selector");
  const container = text(root, ".container-selector");
  return {
    target:
      namespace && pod && container
        ? {
            namespace,
            pod,
            container,
            timestamps: checked(root, ".show-timestamps"),
            previous: checked(root, ".show-previous"),
          }
        : null,
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

/** Monaco exposes no editor handle, so read the scroll position off its vertical scrollbar. */
function isAtBottom(host: HTMLElement) {
  const track = host.querySelector<HTMLElement>(".scrollbar.vertical");
  const slider = track?.querySelector<HTMLElement>(".slider");
  if (!track || !slider) return true;
  return slider.offsetTop + slider.offsetHeight >= track.clientHeight - 2;
}

function scrollToEnd(host: HTMLElement) {
  // Pressing the bottom of the vertical scrollbar jumps there without touching focus or selection.
  const track = host.querySelector<HTMLElement>(".scrollbar.vertical");
  if (track) {
    const { left, bottom } = track.getBoundingClientRect();
    const init = { clientX: left + 1, clientY: bottom - 1, bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1 };
    track.dispatchEvent(new PointerEvent("pointerdown", init));
    track.dispatchEvent(new MouseEvent("mousedown", init));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return;
  }
  // Fallback: Monaco's own Ctrl+End, which needs the edit element focused.
  const input = host.querySelector<HTMLElement>(".native-edit-context, textarea.inputarea");
  if (!input || host.contains(document.activeElement)) return;
  input.focus({ preventScroll: true });
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", code: "End", keyCode: 35, ctrlKey: true, bubbles: true }),
  );
  input.blur();
}

function LogsView({ root, host }: { root: Element; host: HTMLElement }) {
  const [logs, setLogs] = useState("");
  const [view, setView] = useState<View>(() => readView(root));
  const [ready, setReady] = useState(false);
  const stickToBottom = useRef(true);
  const detachHighlight = useRef<() => void>();

  useEffect(() => {
    const timer = setInterval(() => {
      const next = readView(root);
      setView((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }, 500);
    return () => clearInterval(timer);
  }, [root]);

  // The editor wrapper reports a model only on *changes*, so switch ids once after mount to receive the first one.
  useEffect(() => {
    setReady(true);
    return () => detachHighlight.current?.();
  }, []);

  const key = JSON.stringify(view.target);

  useEffect(() => {
    setLogs("");
    stickToBottom.current = true;
    const target: Target | null = JSON.parse(key);
    if (!target) return;
    let cancelled = false;

    const load = async () => {
      try {
        const result = await podsApi.getLogs(
          { name: target.pod, namespace: target.namespace },
          {
            container: target.container,
            timestamps: target.timestamps,
            previous: target.previous,
            tailLines: TAIL_LINES,
          },
        );
        if (cancelled) return;
        // Remember where the view was before the update; the editor follows once it has laid out.
        stickToBottom.current = isAtBottom(host);
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
  }, [key, host]);


  return (
    <MonacoEditor
      id={ready ? `better-logs-${view.target?.pod ?? "none"}` : "better-logs-init"}
      onModelChange={(model: HighlightModel) => {
        detachHighlight.current?.();
        detachHighlight.current = attachHighlighting(model);
      }}
      readOnly
      value={logs}
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
      onDidContentSizeChange={() => {
        // Fires once the new text is laid out, which is also what happens on first open.
        if (stickToBottom.current) requestAnimationFrame(() => scrollToEnd(host));
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
      document.querySelectorAll(".PodLogs").forEach((root) => {
        const host = mountHost(root);
        if (host) setMounts((prev) => [...prev, { root, host }]);
      });
      setMounts((prev) => prev.filter(({ host }) => host.isConnected));
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      style.remove();
    };
  }, []);

  return <>{mounts.map(({ root, host }, i) => createPortal(<LogsView root={root} host={host} />, host, String(i)))}</>;
}
