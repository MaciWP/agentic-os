import { z } from "zod";

// The exact HTTPS origin `tailscale serve` publishes a machine on.
export const TailscaleOrigin = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/" &&
      !u.port &&
      u.hostname.endsWith(".ts.net")
    );
  }, "must be the exact HTTPS Tailscale origin");

export const RemoteConfig = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1024).max(65535).default(4319),
    origin: TailscaleOrigin.optional(),
    login: z
      .string()
      .min(1)
      .max(320)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .superRefine((r, c) => {
    if (r.enabled && (!r.origin || !r.login))
      c.addIssue({ code: "custom", message: "remote access needs origin and login" });
  });
export type RemoteConfig = z.infer<typeof RemoteConfig>;

// Another machine this hub drives (a worker), reached on its own remote ingress.
export const MachineConfig = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(40),
  origin: TailscaleOrigin,
});
export type MachineConfig = z.infer<typeof MachineConfig>;
