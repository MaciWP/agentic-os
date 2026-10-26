# ADR 0004 — Agent access to terminals (`aos`)

Status: accepted (2026-10-02).

## Context

The Lead agent drives Codex, Claude and Grok sessions and runs long commands in a
visible terminal. Until now that went through Orca. The app already owns the
terminals (ADR 0003), so the Lead should drive them through the app: start one,
type into it, wait for it to settle and read its screen, while the user watches
the same terminal in the browser.

## Decision

- **Same API, no token.** `aos` (`scripts/aos.ts`) calls the app's HTTP routes
  on `localhost:4317` with the app's own `Origin` and a JSON body type, exactly
  as the page does. A token file would add nothing: any process that could
  read it runs as the user and can already reach the port.
- **Routes** (behind `localGuard`, proxied to the PTY host):
  - `POST /api/terminals` takes an optional `prompt` (one source only: not with
    a ticket, a PR or a saved prompt), `model` (`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$`,
    so never an option or a `key=value`) and `effort` (an enum per harness). The
    server turns `model` and `effort` into each CLI's own flags; `effort` for
    Codex becomes `-c model_reasoning_effort=<e>`, built by the server, never
    from raw input. A shell takes none of the three.
  - `GET /api/terminals/:id/text?lines=` returns the rendered screen (scrollback
    and visible rows, wrapped rows joined, trailing blank rows dropped), with
    `seq` (bytes of output so far) and the state. 200 lines by default, 2 000 at most.
  - `POST /api/terminals/:id/send` `{ text?, enter?, interrupt? }`: Ctrl+C first,
    then the text, then Enter as its own write 150 ms later. A TUI that gets text
    and Enter in one chunk may read both as a paste and keep the Enter as a
    newline. When the program enabled bracketed paste, the text goes wrapped as
    a paste, with any end marker inside it removed. Text at most 16 KB, no NUL.
    It returns the screen's `seq` from before the write, the `after` for the next wait.
  - `POST /api/terminals/:id/wait` `{ after?, quietMs?, timeoutMs? }` resolves on
    exit, once output newer than `after` has been quiet for `quietMs` (1.5 s by
    default), or at `timeoutMs` (100 s at most, under the server's 120 s idle
    reset). `aos wait` chains waits for longer timeouts.
- **Quiet is not done.** `idle` only means no output for `quietMs`; a command that
  pauses (a build between steps, `sleep`) reads as idle before it ends. `--until`
  keeps waiting past quiet spells until its text is on the screen (exit 0), the
  terminal exits or the time runs out (exit 3). It matches the whole rendered
  screen, scrollback included; `--after` only decides when each wait returns. So
  to know a command finished, give each command a fresh tag and split the marker
  in the typed line, so only the output line matches it:

  ```sh
  aos send <id> --text 'make; echo AOS_""DONE_7f3a $?' --enter   # prints {"seq": N}
  aos wait <id> --after N --until AOS_DONE_7f3a
  aos read <id> --lines 5   # the number after the tag is the exit status
  ```

  A fixed marker such as `AOS_DONE_0` would match an earlier command's line at
  once, and a failing command would never print it.
- **The window stays.** None of the three calls attaches: the open window keeps
  its place and keeps taking keys. A test and an e2e fail if read attaches.
- **No raw stream.** There is no output stream with cursors. Scrollback trims at
  5 000 lines, so `seq` only answers "anything new since"; content always comes
  from the rendered screen.
- **Every agent starts with permission bypass,** with or without a prompt
  (ADR 0003), including a bare launch whose first message comes from `send`.
- **`PROTOCOL` bumped** for the host routes (the current value lives in
  `server/host/files.ts`). The host is replaced only when it runs nothing, so the
  rollout stops running terminals first.

## Consequences

- `localGuard` blocks web pages: a foreign Host (DNS rebinding), a foreign
  Origin on a write, and a form post. A page can send a GET without an Origin,
  but it cannot read the reply (no CORS headers), and GETs change nothing.
- **Accepted residual risk:** any process running as the user can list, start,
  read and type into terminals, including agents the app launched. This was
  already true through `pty-host.json`; `aos` makes it a supported path. An
  agent running inside an app terminal can therefore drive its siblings.
- `send` is a silent input path. The server log records each one (terminal id,
  byte count, Enter and interrupt), never the text; the open window shows the
  echo.
- What stays closed: no command and no path from the caller, only harness and
  location ids; prompt and text limits. Permission bypass is fixed by the server,
  not supplied by the caller. Every
  agent `aos create` is an agent launch under Poneglyph's spawn gate (approval
  and an explicit model).
- `aos` exit codes: 0 ok, 1 error, 2 usage, 3 the wait ended without its condition.
