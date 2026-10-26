import { cn } from "cn";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";

// A quick label over an icon button: shows on hover and on keyboard focus, after a short wait,
// where a native `title` takes a second. The child keeps its own aria-label for readers.
export function Tip({
  label,
  side = "top",
  className,
  children,
}: {
  label: React.ReactNode;
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"];
  className?: string;
  children: React.ReactElement;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={150}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            data-slot="tooltip-content"
            side={side}
            sideOffset={4}
            className={cn(
              "z-50 max-w-64 rounded bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0",
              className,
            )}
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
