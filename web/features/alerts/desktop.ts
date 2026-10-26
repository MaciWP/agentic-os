import type { Alert } from "./alerts.ts";

// The system's notifications, through the browser: only while the app is not in front, since
// the cards already show there. The tag is the alert's key, so two open tabs show one, and a
// newer alert of a terminal replaces its older one with a fresh sound (`renotify`).

export type DesktopPermission = NotificationPermission | "unsupported";

export const desktopPermission = (): DesktopPermission =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

// Asked from a click only: the browser ignores a request made without one.
export async function askDesktop(): Promise<DesktopPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.requestPermission();
}

export const inFront = () => document.visibilityState === "visible" && document.hasFocus();

// Returns whether it was shown.
export function notifyDesktop(alert: Alert, open: () => void): boolean {
  if (desktopPermission() !== "granted" || inFront()) return false;
  const n = new Notification(alert.title, {
    body: alert.detail,
    tag: alert.key,
    renotify: true,
    requireInteraction: alert.tone !== "ok",
  } as NotificationOptions);
  n.onclick = () => {
    window.focus();
    open();
    n.close();
  };
  return true;
}
