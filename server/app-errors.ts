import { COMMON_ERRORS } from "./common-errors.ts";
import { coded, type ErrorRule, rule } from "./errors.ts";
import { FileError } from "./features/files/browse.ts";
import { GitError } from "./features/git/run.ts";
import { GitRefusal } from "./features/git/sync.ts";
import { ImageError } from "./features/images/store.ts";
import { KickoffBusy } from "./features/kickoff/run.ts";
import { MacError } from "./features/mac/run.ts";
import { MailSortError } from "./features/mail/store.ts";
import { MeetingError } from "./features/meetings/store.ts";
import { MemoryError } from "./features/memory/store.ts";
import { ObjectiveError } from "./features/objectives/store.ts";
import { HostUnavailable } from "./features/terminals/host-client.ts";
import { TranscriptError } from "./features/transcripts/store.ts";
import { JudgeError } from "./features/usage/judge.ts";
import { VoiceError } from "./features/voice/engine.ts";
import { WorkspaceConflict } from "./features/workspace/store.ts";
import { ReconnectError } from "./oauth.ts";

const IMAGE_STATUS = {
  bad_image: 400,
  unknown_image: 404,
  image_gone: 410,
  not_pasted: 409,
  capture_busy: 409,
  capture_denied: 403,
  capture_unavailable: 503,
  capture_failed: 500,
} as const;

// The one place the server maps its errors to HTTP; no route answers an error class itself
// (`server/errors.test.ts`).
export const SERVER_ERRORS: readonly ErrorRule[] = [
  rule(ImageError, (e) => ({
    status: IMAGE_STATUS[e.code],
    body: { error: e.code, detail: e.message },
  })),
  rule(FileError, coded),
  rule(MemoryError, coded),
  rule(MacError, coded),
  rule(MailSortError, coded),
  rule(MeetingError, coded),
  rule(TranscriptError, coded),
  rule(ObjectiveError, coded),
  rule(JudgeError, coded),
  rule(KickoffBusy, (e) => ({ status: 409, body: { error: "busy", detail: e.message } })),
  rule(WorkspaceConflict, (e) => ({
    status: 409,
    body: { error: e.message, detail: e.message, current: e.current },
  })),
  rule(GitRefusal, (e) => ({
    status: 409,
    body: { error: "refused", reason: e.reason, detail: e.message },
  })),
  rule(GitError, (e) => ({ status: 502, body: { error: "git_error", detail: e.message } })),
  rule(HostUnavailable, (e) => ({
    status: 503,
    body: { error: "pty_host_unavailable", detail: e.message },
  })),
  rule(VoiceError, (e) => ({ status: 500, body: { error: "voice_failed", detail: e.message } })),
  // Before ProviderError: it is one.
  rule(ReconnectError, (e) => ({
    status: 401,
    body: { error: "reconnect_required", provider: e.provider, detail: e.message },
  })),
  ...COMMON_ERRORS,
];
