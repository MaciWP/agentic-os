import { useState } from "react";
import { Tip } from "@/components/ui/tooltip";
import { isClean } from "../../../shared/envs.ts";
import { Icon } from "../../icons.tsx";
import { Modal } from "../../ui.tsx";
import { type RemovePreview, useRemovePreview, useStartJob } from "./env-jobs.ts";
import {
  RemoveIntro,
  RemoveLastCall,
  RemoveLosses,
  type RemoveStep,
  Stepper,
} from "./env-remove-steps.tsx";

// The remove request for the losses the user approved: their fingerprint goes along only when
// there were any, so the server forces away exactly those and nothing that showed up later.
// Likewise it closes only the open terminals listed to the user. `confirm` is the env's name:
// the ticked last call stands for it.
export const removeRequest = (name: string, approved: RemovePreview) =>
  ({
    action: "remove",
    name,
    confirm: name,
    ...(!isClean(approved) && { seen: approved.fingerprint }),
    ...(approved.open.length > 0 && { close: approved.open.map((t) => t.id) }),
  }) as const;

// The modal: it reads the dry run on open. Leaving step 1 freezes what it said; steps 2 and 3
// show that copy and the remove sends its fingerprint, so a later read (the window regaining
// focus) never changes what is being confirmed. "Volver a revisar" reads it again.
function RemoveEnvDialog({
  name,
  onClose,
  onStarted,
}: {
  name: string;
  onClose: () => void;
  onStarted?: () => void;
}) {
  const preview = useRemovePreview(name, true);
  const removal = useStartJob();
  const [step, setStep] = useState<RemoveStep>("intro");
  const [approved, setApproved] = useState<RemovePreview | null>(null);
  const live = preview.data?.preview ?? null;
  const p = approved ?? live;
  const steps: RemoveStep[] = !p || isClean(p) ? ["intro", "last"] : ["intro", "losses", "last"];
  const back = () => {
    const to = steps[Math.max(0, steps.indexOf(step) - 1)] ?? "intro";
    if (to === "intro") setApproved(null);
    setStep(to);
  };
  const leaveIntro = () => {
    if (!live) return;
    setApproved(live);
    setStep(isClean(live) ? "last" : "losses");
  };
  const recheck = () => {
    setApproved(null);
    setStep("intro");
    void preview.refetch().then((r) => {
      const fresh = r.data?.preview;
      if (fresh && !isClean(fresh)) {
        setApproved(fresh);
        setStep("losses");
      }
    });
  };
  const remove = () => {
    if (!approved) return;
    void removal.start(removeRequest(name, approved)).then((ok) => {
      if (!ok) return;
      onClose();
      onStarted?.();
    });
  };
  return (
    <Modal title={`Borrar ${name}`} onClose={onClose}>
      <div className="space-y-4 px-4 py-3 text-[12px]">
        <Stepper steps={steps} current={step} />
        {step === "intro" || !approved ? (
          <RemoveIntro
            name={name}
            checking={preview.isFetching}
            error={preview.isError ? preview.error.message : null}
            onRecheck={recheck}
            onCancel={onClose}
            onNext={leaveIntro}
          />
        ) : step === "losses" ? (
          <RemoveLosses preview={approved} onBack={back} onNext={() => setStep("last")} />
        ) : (
          <RemoveLastCall
            name={name}
            preview={approved}
            pending={removal.pending}
            error={removal.error}
            onBack={back}
            onRecheck={recheck}
            onRemove={remove}
          />
        )}
      </div>
    </Modal>
  );
}

// "Borrar entorno…" as a bin, and its modal; `onStarted` once the remove is running (its
// output tile).
export function RemoveEnv({
  name,
  busy,
  onStarted,
}: {
  name: string;
  busy: boolean;
  onStarted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tip label={`Borrar ${name}: sus repos, contenedores y datos`}>
        <button
          type="button"
          className="btn-ghost px-1"
          disabled={busy}
          aria-label="Borrar entorno…"
          // A disabled button shows no tooltip, so it says why in its title.
          title={busy ? "Espera a que termine lo que está en curso" : undefined}
          onClick={() => setOpen(true)}
        >
          <Icon name="trash" size={13} />
        </button>
      </Tip>
      {open && <RemoveEnvDialog name={name} onClose={() => setOpen(false)} onStarted={onStarted} />}
    </>
  );
}
