import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Renderer } from "@freelensapp/extensions";

const { MonacoEditor } = Renderer.Component;
const { podsApi } = Renderer.K8sApi;

const POLL_MS = 2000;
const TAIL_LINES = 20000;

interface Target {
  namespace: string;
  pod: string;
  container: string;
}

const text = (root: Element, selector: string) =>
  root.querySelector(selector)?.textContent?.trim() ?? "";

/** The built-in logs tab owns pod/container selection; we read the choice from its DOM. */
function readTarget(root: Element): Target | null {
  const namespace = text(root, '[data-testid="namespace-badge"]');
  const pod = text(root, ".pod-selector");
  const container = text(root, ".container-selector");
  return namespace && pod && container ? { namespace, pod, container } : null;
}

/** Hides the built-in virtual list and returns a host element in its place. */
function mountHost(root: Element): HTMLElement | null {
  const list = root.querySelector<HTMLElement>(".LogList");
  if (!list || list.dataset.betterLogs) return null;
  list.dataset.betterLogs = "1";
  list.style.display = "none";
  const host = document.createElement("div");
  host.className = "BetterLogs";
  host.style.cssText = "flex: 1 1 auto; min-height: 0; position: relative;";
  list.after(host);
  return host;
}

function scrollToEnd(host: HTMLElement) {
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!input) return;
  // Monaco exposes no editor handle, so drive it with its own Ctrl+End binding.
  input.focus({ preventScroll: true });
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", code: "End", keyCode: 35, ctrlKey: true, bubbles: true }),
  );
  input.blur();
}

function LogsView({ root, host }: { root: Element; host: HTMLElement }) {
  const [logs, setLogs] = useState("");
  const [target, setTarget] = useState<Target | null>(() => readTarget(root));

  useEffect(() => {
    const timer = setInterval(() => {
      const next = readTarget(root);
      setTarget((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    }, 500);
    return () => clearInterval(timer);
  }, [root]);

  useEffect(() => {
    setLogs("");
    if (!target) return;
    let cancelled = false;

    const load = async () => {
      try {
        const result = await podsApi.getLogs(
          { name: target.pod, namespace: target.namespace },
          { container: target.container, tailLines: TAIL_LINES },
        );
        if (cancelled) return;
        setLogs((prev) => (prev === result ? prev : result));
        // Follow the tail unless the user is working in the editor (selecting/copying).
        if (!host.contains(document.activeElement)) requestAnimationFrame(() => scrollToEnd(host));
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
  }, [target?.namespace, target?.pod, target?.container, host]);

  return (
    <MonacoEditor
      id={`better-logs-${target?.pod ?? "none"}`}
      readOnly
      value={logs}
      language={"plaintext" as "yaml"}
      options={{
        minimap: { enabled: false },
        lineNumbers: "on",
        wordWrap: "off",
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        automaticLayout: true,
        contextmenu: false,
      }}
      style={{ position: "absolute", inset: 0 }}
    />
  );
}

/** Watches for the built-in logs tab and swaps its list for a Monaco editor. */
export function LogsOverlay() {
  const [mounts, setMounts] = useState<{ root: Element; host: HTMLElement }[]>([]);

  useEffect(() => {
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
    return () => observer.disconnect();
  }, []);

  return <>{mounts.map(({ root, host }, i) => createPortal(<LogsView root={root} host={host} />, host, String(i)))}</>;
}
