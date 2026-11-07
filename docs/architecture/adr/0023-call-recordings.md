# ADR-0023: Call recordings, recorded in the browser and replayed without the vEIR

- **Status:** Accepted; amended 2026-11-07 (the screen as the picture, downloads, a viewer)
- **Date:** 2026-11-06
- **Deciders:** Platform owner. Request of **2026-11-06**: "add a record screen option in the call for me and users to
  revisit that recording without recalling vEIR". Request of **2026-11-07**: "the record button should record the
  screen in video of the conversation and download button on recorded sessions, so have section in the platform with
  the recordings and download button and native view screen for easy revisit".
- **Amends:** docs/architecture/calls.md §5 ("neither the founder's audio nor the synthesized speech is recorded"):
  still true unless the founder presses Record.

## Context and problem statement

Founders want to watch a call again (what Thomas said, how they answered) without starting another call. A call is
already a conversation with its turns stored as text; what is missing is the call as it was heard and seen: both
voices, Thomas's face on a video call, and the captions in step. The recording must work on phones (iOS Safari has no
`getDisplayMedia`, and a screen picker asks every time), stay private to the person who made it, never be made of a
private call, go when its conversation goes, and keep the CSP and IAM as tight as they are.

## Decision

1. **The browser records the screen, and the call itself where it cannot.** `MediaRecorder` on one composed stream
   (`apps/web/src/features/recordings/call-recorder.ts`):
   - **Picture, the screen:** the Record press (or the notice's Start recording: a person's gesture, which the browser
     requires) asks to share the screen with `getDisplayMedia`: this tab preferred and offered alone where the browser
     can (`preferCurrentTab`, `displaySurface: 'browser'`, `selfBrowserSurface: 'include'`,
     `surfaceSwitching: 'exclude'`, `monitorTypeSurfaces: 'exclude'`), no sound of its own (`audio: false`,
     `systemAudio: 'exclude'`), at most 1920×1080 at 15 frames a second, its track hinted `detail` (text stays sharp).
     The recording is then the call as the founder sees it: the face or the voice visual, the captions, the
     conversation lines of both speakers and the call's controls. The browser's own Stop sharing ends the track, which
     stops the recording and saves it. A whole screen or a window shared instead of the tab (Firefox offers no tabs)
     is recorded as shared, and the call screen says so ("The whole screen is recorded, not just this tab.").
   - **Picture, the call view:** where a screen cannot be shared (iOS and iPadOS Safari, most phones), or the founder
     declined (or the browser could not capture it), one 1280×720 canvas redrawn 24 times a second composes the call
     view instead: the face's own video element while a face shows (a vendor face's WebRTC track, or the stand-in's
     stream), labelled "AI avatar" as on the call tile, otherwise the call's presence (a sphere that follows the vEIR's
     measured voice, "AI voice"); the vEIR's name and the recording's time; and the conversation's latest lines from
     both speakers under their names (`CaptionRecorder.recent`: finished lines and those still being heard). A declined
     screen is said in the call screen ("The screen wasn't shared, so the call view is recorded.", with OK). Either
     way it is one video track for the whole recording, so switching between voice and video mid-recording never
     changes the recorded track.
   - **Sound:** a WebAudio mix on the call's own AudioContext into a `MediaStreamAudioDestinationNode`: the speech
     player's output (what the speakers get, after ducking), a vendor face's voice from its element's audio track, and
     the founder's microphone through a gain the call's own gating drives (`microphoneOpen`): silent while muted, on
     hold, or in push to talk while the founder is not holding to talk (the track stays live then, so what is said
     off-mic would otherwise be recorded). `CallEngine.recordingSources()` hands these over without changing the call's
     graph; the recording re-taps them when the microphone reconnects or the face comes back.
     The shared screen's own sound is never taken, so nothing is heard twice.
   - **Container:** the first `isTypeSupported` of webm (VP8/VP9 + Opus: Chromium, Firefox) or mp4 (H.264 + AAC:
     Safari), sound only (webm/Opus or mp4/AAC) where no picture can be captured (a screen shared for it is stopped at
     once); 1.5 Mbit/s video (a 30-minute call is about 340 MB, under the 512 MB cap), 96 kbit/s audio.
   - **Captions:** a timed transcript recorded from the call's own captions as they change (each validated unit of
     the vEIR's reply as it is heard, each finished line of the founder's), never from the audio, saved beside the
     recording as WebVTT with one voice span per cue (`<v.veir Thomas>`, `<v.founder Maya>`).
2. **Controls.** Record sits in the call's dock between the microphone and End (keyboard `R`); while it records, a
   red dot, "REC" and its time show beside the call's time in the header, and the dock shows the time with Stop. While
   the browser asks which screen to share the control says Starting… and nothing records; Stop or the call ending
   meanwhile records nothing (a screen shared after all is stopped at once). Stop saves it; the browser's Stop sharing
   and hanging up (or the call ending any other way) stop and save it too. Before a person's first recording a short
   notice says what is recorded (this tab as they see it, with both voices, and that the browser asks to share it
   first; where no screen can be shared, the call view: the AI avatar or the sphere, the conversation and both voices),
   where it is kept (privately, in the conversation and under Recordings, only they can watch it) and how to delete it
   (there, any time; with the conversation; otherwise after a year); it is remembered per person in the browser, like
   the call disclosure (version 2 since the screen is recorded, so everyone reads it again once). A
   private call keeps the control, disabled, with "Private calls aren't recorded." as its description. The save is
   shown in the call screen above the controls while the screen is open (Saving with its progress; "Recording saved"
   with Watch, which opens it while the call goes on minimized, waiting to be played; or why it failed, with Try
   again and Discard): the
   screen is a modal, and a toast over it could not be clicked and would pass its clicks to End. A toast says it only
   once the screen is closed. A take whose save failed stays in the page until it is saved or discarded, and Record
   waits until then, so no take is lost without the founder's say.
3. **Storage: a private recordings bucket** in the Data stack (`RecordingsBucket`): all public access blocked,
   owner-enforced objects, SSE-S3, TLS 1.2+ only, server access logs, no versioning, retained on stack deletion.
   Lifecycle: unfinished multipart uploads abort after a day; anything under `tenants/` expires
   `RECORDING_LIMITS.retentionDays` (365, infra `RECORDINGS_RETENTION_DAYS`, which a test ties to it; not a setting)
   plus 7 days after it was written, a backstop behind the app's own retention. CORS
   allows `PUT` and `GET` from the **exact** app origins in `config/production.json` `recordings.corsOrigins` (the
   distribution's own origin, plus a custom site domain when one is set), headers `content-type` and `range`.
   Keys: `tenants/{tenant}/ventures/{venture}/sessions/{conversation}/recordings/{id}/call.{webm|mp4|m4a}` and
   `…/captions.vtt`.
4. **Nothing of a recording passes through the API.** `POST /calls/:id/recordings` (the caller's own call, in a
   remembered conversation that still exists, founder or team of a live venture; at most 40 a day, counting those
   saved or still uploading, not those deleted; past it the save says so and is not offered again) registers it and
   returns presigned PUTs that bind the exact content type and size (5 minutes to start; 512 MB at most, a duration
   within the call's own limit plus a minute). The browser uploads the small captions file first and then the
   recording, so neither upload starts after its URL expired however long the recording takes to send.
   `POST /recordings/:id/complete` checks the sizes that arrived
   (HeadObject) and marks it ready. `GET /recordings/:id/playback` returns presigned GETs that last the recording's
   length twice plus 10 minutes (15 minutes to 4 hours), so the player can stream and seek it with range requests;
   the player asks again if a long replay outlives them. `GET /recordings/:id/download?file=recording|transcript`
   returns one presigned GET (5 minutes) whose response is `Content-Disposition: attachment` with a readable name:
   whose call and when, in the person's time zone (`name` and `timeZone` from the browser: "Thomas call 2026-11-07
   14-22.webm", "… transcript.vtt"; "Call …" in UTC without them; characters a file system refuses removed). The
   browser follows it as a link, a navigation the bucket answers with the file, so it needs no CORS and the CSP no new
   origin. `GET /recordings` lists one conversation's, one venture's or all of the caller's ready recordings.
   `DELETE /recordings/:id` deletes it.
5. **Only the person who recorded it.** `call_recordings` (migration 0031) is visible and writable only where
   `recorded_by = app.current_principal()`: not the venture's team, not its EIR, not a program lead or platform admin.
   Listing, replaying, downloading and completing it also need the venture still (a revoked or expired membership loses its
   recordings at once, as it loses the rest of the venture: they carry the vEIR's advice about it); deleting one's own
   recording does not.
   Its insert policy also requires the call to be the caller's own and the conversation to be `standard` and not
   deleted, so a private call cannot be recorded even by a modified client. A guard trigger keeps the identity, keys
   and sizes immutable, a ready recording ready and a deleted one deleted. An insert locks its conversation row
   first, as `app.soft_delete_session` does (`call_recordings_require_live_session`, migration 0032, the same lock
   0009 takes for turns), so an insert and a delete of the conversation serialise: one that comes while the delete is
   uncommitted waits and is then refused, and a delete that comes after it deletes the new recording too.
6. **Deletion.** Deleting a recording marks it deleted and removes its files after the commit. Deleting a conversation
   marks every recording of it deleted in the same transaction, whoever made it (`call_recordings_follow_session`, a
   `SECURITY DEFINER` trigger on `coaching_sessions.deleted_at`, the column every conversation deletion path sets), and
   the API removes the files after the commit. The daily maintenance abandons uploads nobody finished (24 hours),
   expires recordings past `RECORDING_LIMITS.retentionDays`, and removes the files of any deleted recording still in
   the bucket (`purged_at` records it). A recording deleted while its upload may still be arriving (pending, younger
   than those 24 hours) is not marked purged: each purge deletes its files again until no upload can land, so a file
   that arrives after the conversation was deleted is removed too. There is no account or venture deletion path that deletes conversations
   today; one that is added must set `coaching_sessions.deleted_at`, which brings the recordings with it.
7. **Audit and insights, no content.** `recording.requested` (or `blocked`/`denied` with its reason),
   `recording.saved`, `recording.played`, `recording.downloaded` (which file: `recording` or `transcript`, never the
   name it was saved under), `recording.deleted`, `recording.access` (denied) and `maintenance.recordings` carry ids,
   sizes, durations and cue counts only; the operator's insights report counts a
   call's kept recordings (`recordings`), and its export carries the audit trail. Logs never carry a URL, a key or a
   caption.
8. **CSP and IAM stay exact.** The recordings bucket's regional endpoint is the one origin added, to `connect-src`
   (uploads, the captions file) and `media-src` (the player): `media-src 'self' blob: https://<bucket>.s3.<region>.amazonaws.com`.
   A download is a navigation, which no directive of the policy governs, and its response is an attachment, so the
   page stays where it is.
   `scripts/smoke.mjs` checks it after each deploy (exactly two bucket origins in `connect-src`, the recordings one in
   both). The API role may Get/Put/Delete recording keys only (`tenants/*/recordings/*`; its GetObject allow-list now
   names venture documents and recordings); the worker may only delete them (an explicit deny on Get and Put). Neither
   may list the bucket, so a HEAD of a key not uploaded yet is answered 403: the API takes it as not uploaded and logs
   `recordings.head_denied`, so a real denial shows. The runtime contract adds
   `RECORDINGS_BUCKET` to the api and worker functions.
9. **Local development and the end-to-end suite** use `LocalRecordingStore` behind the same port: HMAC-signed tokens
   standing in for presigned URLs (`PUT|GET /api/v1/_local/recordings/:token`, development only, byte ranges
   answered, a download's token naming the file it is sent as, `Content-Disposition: attachment`), at the API's own
   origin in the suite, so the recording is uploaded, replayed and downloaded cross-origin under the production CSP as
   it is from S3. A headless browser has no screen to share: the suite's founder shares a stand-in (`getDisplayMedia`
   answering with a canvas "tab", or refusing as a founder who declines).
10. **Recordings, a section with a viewer.** Recordings in the venture's side panel (`g r`, `/v/:id/recordings`) lists
    the person's recordings latest first: date, conversation, length, video or sound only, size, with Watch, Download
    (the recording, or its transcript when it has one) and Delete; a conversation lists its own the same way at the
    end of its transcript. Watch opens the viewer (`/v/:id/recordings/:recordingId`, its own route chunk, off the first
    page load): the player large, the transcript beside it (below it on a phone) marking the line being heard and
    keeping it in view unless the person scrolls it, a line seeking to it, `K` play or pause, `J` and `L` ten seconds
    back or forward; Download, Open conversation and Delete. The call screen's Watch after a save opens it too.

## Options rejected

- **`getDisplayMedia` alone (2026-11-06; amended 2026-11-07):** unavailable on iOS, so a phone could not record at all.
  The first decision recorded only the composed call (face or presence) for that reason; the owner asked for the screen
  (what the founder sees, the conversation with it), so the screen is now the picture where it can be shared, the
  tab preferred and without its sound (the call's own mix is the sound, so nothing is doubled), and the composed call
  view, now with the conversation's lines, where it cannot.
- **The screen's own sound (`audio: true`):** tab audio would carry the vEIR's voice a second time beside the mix, and
  never the microphone; the mix has both, gated as the call hears them.
- **Server-side recording** (the API or a media server joining the call): the founder's audio never passes through
  this platform (ADR-0010), and the face's room is the vendor's; recording there would add a party to every call.
- **The documents bucket** with another prefix: its CORS is a wildcard of CloudFront origins (the documents bucket
  predates a known app origin) and its lifecycle and IAM are the documents'; recordings get their own exact CORS,
  retention and policy.
- **Recording the whole conversation's transcript as captions from the server:** the client's own captions are in
  step with what was recorded; the turns are already stored as text.

## Consequences

- Good: on a laptop the recording is the screen as the founder saw it; on phones and tablets that cannot share a
  screen it is the composed call view with the conversation, and a voice call switching to video mid-recording stays
  one recording either way.
- Good: a recording or its transcript downloads under a readable name, from a short-lived link signed when asked for
  and audited, with no change to the CSP or the bucket's CORS.
- Good: privacy holds in the database itself: owner-only rows, no private calls, gone with the conversation.
- Bad: the browser holds the recording in memory until it is saved; closing the tab before the save finished loses it
  (nothing is kept anywhere else). While it records, saves or waits for Try again, leaving the page asks first
  (`beforeunload`). A save that fails keeps it in the page with Try again.
- Bad: a WebM from `MediaRecorder` has no duration in its header; the player seeks to the end once to measure it.
- Bad: the browser asks which screen to share every time Record is pressed, and records whatever that tab shows (a
  replay opened there, another page if the founder navigates away in that tab). Drawing the call view where no screen
  is shared costs a little CPU (1280×720 at 24 fps).

## Revisit when

- The owner wants recordings shared with a team member or an EIR (a consent and a sharing model, not a policy tweak).
- A recording longer than about 70 minutes is needed (the 512 MB cap), or storage cost per month passes USD 5
  (`RecordingsBucket` size in the cost runbook).
