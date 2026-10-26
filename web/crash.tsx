import type { ErrorComponentProps } from "@tanstack/react-router";
import { Component, type ReactNode, useEffect } from "react";
import { reportError } from "./report.ts";
import { ErrorState } from "./ui.tsx";

// What a view shows when its own code throws while rendering: what failed and a retry, in place
// of the view, so the rest of the page keeps working. Reintentar renders it again from scratch.
// The crash also goes to data/server.log.
export function Crash({ error, reset, what }: { error: unknown; reset: () => void; what: string }) {
  useEffect(() => reportError("render", error, what), [error, what]);
  return <ErrorState error={error} onRetry={reset} title={`${what} ha fallado`} />;
}

// The router's error component: a page that throws is replaced by this inside the Shell, which
// keeps its navigation; the terminal window gets it on its own.
export const RouteCrash = ({ error, reset }: ErrorComponentProps) => (
  <Crash error={error} reset={reset} what="Esta página" />
);

// Wraps one tile or panel: when it throws, only it shows the Crash; its neighbours stay.
export class CrashBoundary extends Component<
  { what: string; children: ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error("error desconocido") };
  }
  reset = () => this.setState({ error: null });
  render() {
    if (this.state.error === null) return this.props.children;
    return <Crash error={this.state.error} reset={this.reset} what={this.props.what} />;
  }
}
