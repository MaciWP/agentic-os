import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { DraftShelf } from "./draft-strip.tsx";
import { useFileDropGuard } from "./images.tsx";
import { usePhone } from "./mobile.tsx";
import { terminalLabel, useTerminals } from "./queries.ts";
import { TerminalView } from "./window.tsx";

// The popped-out window: opened by an explicit click, so it takes the terminal. On a phone (a
// narrow desktop window still takes) it is the terminal's page, opened from the list: it reads
// and answers without taking the terminal from the desktop, and goes back to the list.

export function TerminalWindow() {
  const { id } = useParams({ from: "/terminal/$id" });
  const info = useTerminals().data?.terminals.find((t) => t.id === id);
  const navigate = useNavigate();
  const phone = usePhone();
  // Outside the Shell, so it keeps a dropped file from replacing the page itself.
  useFileDropGuard();
  useEffect(() => {
    document.title = info ? `${terminalLabel(info)} · ${info.cwd}` : "Terminal";
  }, [info]);
  return (
    <div className="h-dvh">
      <TerminalView
        id={id}
        take={!phone}
        expand={false}
        lead={
          phone && (
            // In the app, not a page load: a dictation on its way lands in the draft meanwhile.
            <Link
              to="/terminales"
              className="btn min-h-10 shrink-0 px-2"
              aria-label="Volver a las terminales"
            >
              ←
            </Link>
          )
        }
        onOpen={(t) => {
          // Named like any other terminal window, so a later "Ventana aparte" finds it.
          window.name = `aos-terminal-${t.id}`;
          void navigate({ to: "/terminal/$id", params: { id: t.id } });
        }}
      />
      <DraftShelf floating />
    </div>
  );
}
