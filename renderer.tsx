import React from "react";
import { computed } from "mobx";
import { Renderer } from "@freelensapp/extensions";
import { LogsOverlay } from "./src/logs-overlay";

export default class BetterLogsRenderer extends Renderer.LensExtension {
  clusterFrameComponents = [
    {
      id: "better-logs-overlay",
      shouldRender: computed(() => true),
      Component: () => <LogsOverlay />,
    },
  ];
}
