import { type Context, Hono } from "hono";
import { ApplyBody, MailAccount, NewProposal } from "../../../shared/mail-sort.ts";
import type { Config } from "../../config.ts";
import { holdOpen } from "../../deadline.ts";
import type { mailSorter } from "./sort.ts";
import { MailSortError, type ProposalStore } from "./store.ts";

// How far back the categorizer learns from the user's ticks.
const LEARN_DAYS = 90;
const DAY_MS = 86_400_000;

const id = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// The categorizer's proposals: the agent posts one through `aos mail propose`, the user reviews
// it in Inicio and applies what they kept. Applying needs the user's click in a dialog on the
// Mac, so it is a desktop route.
export function mailRoutes({
  config,
  proposals,
  sorter,
}: {
  config: Config;
  proposals: ProposalStore;
  sorter: ReturnType<typeof mailSorter>;
}) {
  const account = (c: Context) => {
    const parsed = MailAccount.safeParse(c.req.param("account"));
    if (!parsed.success) throw new MailSortError("not_found", "the account is work or personal");
    return parsed.data;
  };
  const proposalId = (c: Context) => {
    const n = id(c.req.param("id") ?? "");
    if (n === null) throw new MailSortError("not_found", "a proposal id is a whole number");
    return n;
  };

  return new Hono()
    .get("/:account/proposal", (c) => c.json({ proposal: proposals.pending(account(c)) }))
    .get("/:account/decisions", (c) =>
      c.json({
        decisions: proposals.decisions(account(c), new Date(Date.now() - LEARN_DAYS * DAY_MS)),
      }),
    )
    .get("/:account/outside", async (c) => {
      const to = account(c);
      if (!(to === "work" ? config.providers.outlook : config.providers.google))
        throw new MailSortError("provider_disabled", "Google is off");
      return c.json(await sorter.outside(to, c.req.query("page") || undefined));
    })
    .post("/:account/proposals", async (c) => {
      const to = account(c);
      if (!(to === "work" ? config.providers.outlook : config.providers.google))
        throw new MailSortError(
          "provider_disabled",
          `${to === "work" ? "Outlook" : "Google"} is off`,
        );
      const body = NewProposal.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      return c.json({ proposal: await sorter.propose(to, body.data) });
    })
    .post("/proposals/:id/discard", (c) => c.json({ proposal: proposals.discard(proposalId(c)) }))
    .post("/proposals/:id/apply", async (c) => {
      // Attribution, not authentication: the real gate is the dialog only the user can click.
      if (c.req.header("x-aos-agent-id"))
        throw new MailSortError(
          "user_approval_required",
          "Only the user applies a proposal, from Inicio",
        );
      const n = proposalId(c);
      const body = ApplyBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      // A fresh inbox read, then up to two minutes for the click: past Bun's idle timeout the
      // page would report a failure while the click still moves mail.
      holdOpen(c.env, c.req.raw);
      return c.json({ proposal: await sorter.apply(n, body.data.keep) });
    });
}
