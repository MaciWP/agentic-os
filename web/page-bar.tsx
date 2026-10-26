import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

// The element in the app's top bar, right of the main menu, that holds the page's own bar.
export const PageBarSlot = createContext<HTMLElement | null>(null);

// A page's title and controls, shown in the app's top bar so the page keeps the height of a
// row. Outside the Shell (unit tests) there is no slot and the bar shows in place.
export function PageBar({ children }: { children: ReactNode }) {
  const slot = useContext(PageBarSlot);
  if (!slot)
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        {children}
      </div>
    );
  return createPortal(children, slot);
}
