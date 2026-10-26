import type { DragEvent, ReactNode } from "react";

export type HeaderDrag = {
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

// The header of a panel tile (a checkout's git, an env's output), dressed like a terminal's:
// the tile's number, the kind as a chip in its colour, what it shows, then its own controls.
// Its fill takes the kind's colour like a terminal's (window.tsx headerFill). Dragged by the
// Mesa to move the tile.
export function TileHeader({
  lead,
  harness,
  chip,
  label,
  title,
  drag,
  children,
}: {
  lead?: ReactNode;
  // The colour key of the chip (tokens.css `[data-harness]`).
  harness: string;
  chip: string;
  label: ReactNode;
  title?: string;
  drag?: HeaderDrag;
  children?: ReactNode;
}) {
  return (
    <header
      className={`flex h-9 shrink-0 items-center gap-1.5 border-b border-white/10 bg-[color-mix(in_oklab,var(--h,var(--term-header))_24%,var(--term-header))] px-2 text-term-ink text-[12px] ${
        drag ? "cursor-grab active:cursor-grabbing" : ""
      }`}
      {...(drag && { draggable: true, ...drag })}
    >
      {lead}
      <span className="harness-chip" data-harness={harness}>
        <span className="truncate">{chip}</span>
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-white/55" title={title}>
        {label}
      </span>
      {children}
    </header>
  );
}
