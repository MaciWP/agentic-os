// To this viewer's clipboard, the one the user sits at. The clipboard API exists only on a
// secure origin (https, localhost); elsewhere this fails with the reason.
export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("el portapapeles pide https");
  await navigator.clipboard.writeText(text);
}
