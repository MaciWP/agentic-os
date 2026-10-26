import { type KeyboardEvent, useEffect, useState } from "react";

// The active option of a combobox: the input keeps the focus and points at one option of its
// list (`aria-activedescendant`); the arrows move round the list and Enter chooses. Shared by
// the ⌘K palette and the folder picker, styled by `.option-list` / `.option` (tokens.css).
export function useActiveOption(count: number, idPrefix: string) {
  const [active, setActive] = useState(0);
  const at = Math.min(active, Math.max(count - 1, 0));
  const optionId = (i: number) => `${idPrefix}-${i}`;
  const activeId = count > 0 ? optionId(at) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  // True when it took the key: the caller handles the rest.
  const onKeyDown = (e: KeyboardEvent, choose: (i: number) => void) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step && count > 0) {
      e.preventDefault();
      setActive((at + step + count) % count);
      return true;
    }
    if (e.key === "Enter" && count > 0) {
      e.preventDefault();
      choose(at);
      return true;
    }
    return false;
  };

  return { at, activeId, optionId, setActive, onKeyDown };
}
