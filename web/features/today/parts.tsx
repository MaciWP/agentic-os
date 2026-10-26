import type { ReactNode } from "react";
import { DisabledState, ErrorState, isOff, SkeletonRows } from "../../ui.tsx";

// The pieces of «Hoy»: a section that says how its source was read.

type Read<T> = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data?: T | { disabled: true };
  refetch: () => unknown;
};

export function Section<T>({
  title,
  q,
  count,
  children,
  provider = "Google",
  errorTitle,
}: {
  title: string;
  q: Read<T>;
  count: (data: T) => string;
  children: (data: T) => ReactNode;
  provider?: string;
  // The heading for a failure the provider names (Mail closed, a missing grant).
  errorTitle?: (error: unknown) => string | undefined;
}) {
  const data = q.data && !isOff(q.data) ? q.data : undefined;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <header className="flex items-baseline justify-between gap-2 px-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {data && <span className="text-[12px] text-ink-2">{count(data)}</span>}
      </header>
      {q.isPending ? (
        <SkeletonRows count={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} title={errorTitle?.(q.error)} onRetry={() => q.refetch()} />
      ) : q.data && isOff(q.data) ? (
        <DisabledState provider={provider} />
      ) : data ? (
        children(data)
      ) : null}
    </section>
  );
}

export const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="px-1 py-2 text-[13px] text-ink-2">{children}</p>
);
