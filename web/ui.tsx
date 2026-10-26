import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { useAccess } from "./access.ts";
import { ApiError } from "./api.ts";
import { Icon } from "./icons.tsx";
import { storageKey } from "./storage.ts";

const PROVIDER_ERROR: Record<string, string> = {
  jira: "Jira ha devuelto un error",
  envs: "El proveedor de entornos ha fallado",
};

const providerTitle = (error: unknown) =>
  error instanceof ApiError && error.code === "provider_error"
    ? (PROVIDER_ERROR[error.provider ?? ""] ?? "Un servicio externo ha devuelto un error")
    : null;

// An inline error line that, like ErrorState, says which provider failed.
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const title = providerTitle(error);
  return title ? `${title}: ${message}` : message;
}

// `provider` names who failed when the error is a provider's message inside a good answer;
// `title` replaces the heading when the caller knows better (a view that crashed).
export function ErrorState({
  error,
  onRetry,
  provider,
  title: heading,
}: {
  error: unknown;
  onRetry?: () => void;
  provider?: string;
  title?: string;
}) {
  const reconnect = error instanceof ApiError && error.code === "reconnect_required";
  const google = error instanceof ApiError && error.provider === "google";
  const title =
    heading ??
    (reconnect
      ? google
        ? "Google necesita conectarse"
        : "Jira necesita reconectarse"
      : ((provider && PROVIDER_ERROR[provider]) ??
        providerTitle(error) ??
        "No se han podido cargar los datos"));
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="m-4 rounded-md border border-bad/40 bg-bad/5 px-4 py-3">
      <p className="font-medium text-bad">{title}</p>
      <p className="mt-1 break-words font-mono text-[12px] text-ink-2">{detail}</p>
      {error instanceof ApiError && error.requestId && (
        <p className="mt-1 select-all font-mono text-[11px] text-ink-2">
          ID de la petición: {error.requestId}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {reconnect && (
          <Reconnect provider={google ? "google" : "atlassian"} className="btn btn-primary">
            {google ? "Conectar Google" : "Reconectar Jira"}
          </Reconnect>
        )}
        {onRetry && (
          <button type="button" className="btn" onClick={onRetry}>
            Reintentar
          </button>
        )}
      </div>
    </div>
  );
}

// OAuth runs on the Mac: the remote ingress refuses /auth/* (local_desktop_required), so a
// remote device gets where to do it instead of a link to a 409 page. A failed access read keeps
// the link: the Mac is the usual case, and the worst a remote device meets is that 409.
export function Reconnect({
  provider,
  className,
  children,
}: {
  provider: "atlassian" | "google";
  className: string;
  children: ReactNode;
}) {
  const access = useAccess();
  if (access.isPending) return null;
  if (access.data?.desktop === false)
    return <span className="text-[12px] text-ink-2">Reconéctalo desde el Mac</span>;
  return (
    <a href={`/auth/${provider}/start`} className={className}>
      {children}
    </a>
  );
}

// An error said where it happened, read out at once. Spacing and size are the caller's.
export function InlineError({
  children,
  className = "",
  as: Tag = "p",
}: {
  children: ReactNode;
  className?: string;
  as?: "p" | "span" | "div";
}) {
  return (
    <Tag role="alert" className={className ? `text-bad ${className}` : "text-bad"}>
      {children}
    </Tag>
  );
}

// A later read failed while earlier data is still on screen: the data stays, with this above it,
// so nothing the user was doing there is unmounted.
export function StaleNotice({
  error,
  onRetry,
  children = "No se ha podido actualizar; lo que ves puede estar desfasado",
  className = "",
}: {
  error: unknown;
  onRetry?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={`rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] text-ink ${className}`}
    >
      {children}: {errorText(error)}
      {onRetry && (
        <>
          {" "}
          <button type="button" className="underline" onClick={onRetry}>
            Reintentar
          </button>
        </>
      )}
    </p>
  );
}

// A provider turned off in data/config.json answers this instead of its data.
export type Off = { disabled: true };
export const isOff = <T extends object>(data: T | Off): data is Off => "disabled" in data;

export function DisabledState({ provider }: { provider: string }) {
  return (
    <p className="px-4 py-3 text-[12px] text-ink-2">{provider} está desactivado en este perfil.</p>
  );
}

export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="Cargando" className="space-y-px p-2">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="h-9 rounded bg-line/60 motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

// One titled block inside a dashboard column; "pronto" marks a panel whose data lands later.
// Which sections and tree nodes are open, kept on this browser under one key. Storage may be
// off or hold anything; then each starts at its default.
const openKey = storageKey("aos.tree.open", {
  schema: z.record(z.string(), z.unknown()),
  fallback: {},
  codec: "json",
});

// `reveal` opens it whatever was kept (a node a link points at): on the first render, and
// again each time it turns true, so the user can still fold it meanwhile. The setter keeps
// what it is given.
export function useOpen(
  id: string,
  fallback: boolean,
  reveal = false,
): [boolean, () => void, (next: boolean) => void] {
  const [open, setOpen] = useState(() => {
    if (reveal) return true;
    const v = openKey.get()[id];
    return typeof v === "boolean" ? v : fallback;
  });
  const set = (next: boolean) => {
    setOpen(next);
    openKey.set({ ...openKey.get(), [id]: next });
  };
  const was = useRef(reveal);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new mark unfolds it
  useEffect(() => {
    if (reveal && !was.current) set(true);
    was.current = reveal;
  }, [reveal]);
  return [open, () => set(!open), set];
}

// The chevron that folds a section or a tree node; `label` names what it folds.
export function Fold({
  open,
  onToggle,
  label,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  controls: string;
}) {
  return (
    <button
      type="button"
      className="grid size-5 shrink-0 place-items-center rounded text-ink-2 hover:bg-[var(--hover)] hover:text-ink"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${open ? "Plegar" : "Desplegar"} ${label}`}
      onClick={onToggle}
    >
      <span className={`grid transition-transform ${open ? "rotate-90" : ""}`}>
        <Icon name="chevron" size={14} />
      </span>
    </button>
  );
}

export function Block({
  title,
  count,
  action,
  soon,
  collapsible = false,
  reveal = false,
  nested = false,
  plain = false,
  mark,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  soon?: boolean;
  // A chevron in the header folds the section; its state is kept per browser.
  collapsible?: boolean;
  // Unfolds a folded section that holds what a link points at.
  reveal?: boolean;
  // A section inside another one: no rule of its own, its head indented and a size smaller.
  nested?: boolean;
  // A list's group rather than a page's section: no rule, 12px of air above, a 28px head with
  // its title in sentence case.
  plain?: boolean;
  // Before the title, such as a project's colour dot.
  mark?: ReactNode;
  children: ReactNode;
}) {
  const body = useId();
  const [open, toggle] = useOpen(`block:${title}`, true, reveal);
  const Title = nested ? "h4" : "h3";
  return (
    <section
      aria-label={title}
      className={nested ? "" : plain ? "mt-3" : "border-b border-line last:border-b-0"}
    >
      <div
        className={`flex items-center gap-2 ${nested ? `${plain ? "h-7" : "h-8"} pr-4 pl-5` : `${plain ? "h-7" : "h-9"} ${collapsible ? "pr-4 pl-2" : "px-4"}`}`}
      >
        {collapsible && <Fold open={open} onToggle={toggle} label={title} controls={body} />}
        {mark}
        <Title
          className={
            plain
              ? `font-semibold text-ink-2 ${nested ? "text-[11px]" : "text-[12px]"}`
              : `section-title ${nested ? "text-[11px]" : ""}`
          }
        >
          {title}
        </Title>
        {count !== undefined && (
          <span className="text-[11px] text-ink-2 tabular-nums">{count}</span>
        )}
        {soon && <span className="pill">pronto</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {collapsible ? (
        <div id={body} hidden={!open}>
          {open && children}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

// Which width splits a page into side-by-side panels; below it, one panel shows at a time.
const SPLIT = { md: "hidden md:flex", lg: "hidden lg:flex", xl: "hidden xl:flex" } as const;

// One bordered panel of a page: the home columns, the workspace's tree and pane.
export function Panel({
  id,
  title,
  hint,
  active,
  split,
  children,
}: {
  id: string;
  title: ReactNode;
  hint?: ReactNode;
  active: boolean;
  split: keyof typeof SPLIT;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`col-${id}`}
      className={`min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel ${active ? "flex" : SPLIT[split]}`}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 id={`col-${id}`} className="truncate font-semibold">
          {title}
        </h2>
        {hint && <span className="truncate text-[12px] text-ink-2">{hint}</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

// A modal over the page: the browser's own dialog, so Esc, the focus trap and the inert page
// come with it. Mount it only while open; closing gives the focus back to what had it.
// Opening focuses the element marked `data-autofocus`, if any: React's autoFocus fires while
// the dialog is still closed, and `showModal` then moves the focus to its first control.
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const back = document.activeElement;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Esc is the dialog's own.
    <dialog
      ref={dialog}
      aria-label={title}
      className="m-auto max-h-[min(720px,85vh)] w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-[var(--shadow-2)] backdrop:bg-[oklch(0.2_0.02_270/0.35)] open:flex open:flex-col"
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && dialog.current?.close()}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="font-semibold text-[13px]">{title}</h2>
        <button
          type="button"
          className="btn-ghost ml-auto"
          aria-label="Cerrar"
          title="Cerrar (Esc)"
          onClick={() => dialog.current?.close()}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </dialog>
  );
}
