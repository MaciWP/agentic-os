import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { useServerEvents } from "./events.ts";
import { useAlerts } from "./features/alerts/alerts.ts";
import { Alerts, pending, Signals } from "./features/alerts/signals.tsx";
import { useReveal } from "./features/code/reveal.ts";
import { MachineSwitch } from "./features/machines/switch.tsx";
import { PAGES } from "./features/palette/items.ts";
import { PaletteButton, PaletteProvider } from "./features/palette/palette.tsx";
import { SystemIndicator } from "./features/system/indicator.tsx";
import { Attention } from "./features/terminals/attention.tsx";
import { useBlockAccent } from "./features/terminals/block-accent.ts";
import { AppImages } from "./features/terminals/images.tsx";
import { LaunchRecovery } from "./features/terminals/launch-recovery.tsx";
import {
  useWorkspaceSync,
  WorkspaceNotice,
  WorkspaceReady,
} from "./features/terminals/workspace-sync.tsx";
import { useTickets } from "./features/tickets/queries.ts";
import { Icon } from "./icons.tsx";
import { PageBarSlot } from "./page-bar.tsx";
import { StatusBar } from "./status-bar.tsx";
import { isOff } from "./ui.tsx";

export function Shell() {
  const offline = useServerEvents();
  useReveal();
  useBlockAccent();
  const workspaceReady = useWorkspaceSync();
  const tickets = useTickets();
  // The same count as the tab's title and «Siguiente».
  const waiting = pending(useAlerts());
  // Set from a callback ref, so a page's bar moves into it before the first paint.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <PaletteProvider>
      {/* One bar across the top: the main menu, then the page's own bar. Below md the page's
            bar takes a second line, and a page's controls wrap when its bar is too narrow. */}
      <Attention />
      <Alerts />
      {/* The page never scrolls: each page and rail scrolls inside itself. `clip`, not
            `hidden`, so nothing (a focus, a scrollIntoView) can scroll this box either. */}
      <div className="flex h-dvh flex-col overflow-clip">
        <header
          className={`flex shrink-0 flex-wrap items-center gap-x-2 border-b border-line bg-panel pr-2 md:flex-nowrap`}
        >
          <Link to="/" className="flex h-11 shrink-0 items-center gap-2 pl-3 text-ink no-underline">
            <span aria-hidden className="brand-mark">
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="currentColor"
                className="drop-shadow-[0_1px_0_oklch(0_0_0/0.25)]"
              >
                <circle
                  cx="12"
                  cy="12.6"
                  r="6.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  opacity="0.6"
                />
                <circle cx="12" cy="6" r="2.9" />
                <circle cx="6.3" cy="15.9" r="2.9" />
                <circle cx="17.7" cy="15.9" r="2.9" />
              </svg>
            </span>
            <span className="sr-only font-semibold lg:not-sr-only">Agentic OS</span>
          </Link>
          {/* From md the machine goes in the status bar; a phone keeps it here. */}
          <span className="contents md:hidden">
            <MachineSwitch />
          </span>
          {/* Icons until 2xl, each named by its word; scrolls sideways if it still does not fit. */}
          <nav
            aria-label="Principal"
            className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto md:flex-none [&>a]:shrink-0"
          >
            {PAGES.map((p) => (
              <Link
                key={p.to}
                to={p.to}
                title={
                  p.to === "/terminales" && waiting
                    ? `${p.label} · ${waiting} te ${waiting === 1 ? "necesita" : "necesitan"}`
                    : p.label
                }
                className="nav-item relative [&>svg]:mr-0 2xl:[&>svg]:mr-2"
                activeOptions={{ exact: p.to === "/" }}
                activeProps={{ "aria-current": "page" }}
              >
                <Icon name={p.icon} />
                <span className="sr-only 2xl:not-sr-only">{p.label}</span>
                {p.to === "/tickets" && tickets.data && !isOff(tickets.data) && (
                  <span className="absolute -top-0.5 right-0 rounded-full bg-panel px-0.5 text-[10px] leading-3 text-ink-2 tabular-nums 2xl:static 2xl:ml-1.5 2xl:px-0 2xl:text-[11px]">
                    {tickets.data.tickets.length}
                  </span>
                )}
              </Link>
            ))}
          </nav>
          <div
            ref={setSlot}
            className="order-last flex min-h-11 w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 empty:hidden md:order-none md:w-auto md:flex-1 md:self-stretch md:border-t-0 md:border-l"
          />
          <Signals />
          <div className="ml-auto hidden shrink-0 items-center gap-2 md:flex">
            <SystemIndicator />
          </div>
          <AppImages>
            <PaletteButton />
          </AppImages>
        </header>
        {offline && (
          <p
            role="alert"
            className="shrink-0 border-b border-line bg-warn/10 px-3 py-2 text-[12px] text-ink"
          >
            Sin conexión con el servidor: lo que ves puede estar desfasado. Se reconecta solo.
          </p>
        )}
        <WorkspaceNotice />
        <LaunchRecovery />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <PageBarSlot.Provider value={slot}>
            <WorkspaceReady.Provider value={workspaceReady}>
              <Outlet />
            </WorkspaceReady.Provider>
          </PageBarSlot.Provider>
        </main>
        <StatusBar />
      </div>
    </PaletteProvider>
  );
}
