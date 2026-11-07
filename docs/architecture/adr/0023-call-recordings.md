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

1. **The browser records this tab while the call is on it, and the call itself otherwise.** `MediaRecorder` on one
   canvas and one sound mix (`apps/web/src/features/recordings/call-recorder.ts`); the canvas's track is the only
   picture, so switching between voice and video, or minimizing the call, never changes the recorded track:
   - **Picture, this tab:** where the browser can share this tab and tell, once shared, that it is this tab (Chromium
     and Edge on a computer: `getDisplayMedia` and the Capture Handle API), the Record press (or the notice's Start
     recording: a person's gesture, which the browser requires) marks the page with a random capture handle
     (`setCaptureHandleConfig`, visible to this origin only) and asks to share the screen: this tab preferred
     (`preferCurrentTab`, `displaySurface: 'browser'`, `selfBrowserSurface: 'include'`, `surfaceSwitching: 'exclude'`,
     `monitorTypeSurfaces: 'exclude'`), no sound of its own (`audio: false`, `systemAudio: 'exclude'`), at most
     1920×1080 at 15 frames a second. Only a browser surface carrying that handle is recorded (`sharesThisTab`):
     another tab, a window or a whole screen is stopped at once and the call view is recorded instead ("Only this tab
     can be recorded, so the call view is recorded."), so nothing outside the call (other pages, other apps,
     notifications) can reach a recording. The tab's frames are drawn onto a canvas of its shape (this page in device
     pixels, scaled to fit the capture and 1920×1080: Chromium's track settings report the largest size asked for, not
     its frames', so a 16:10 laptop would otherwise get black bars), its track hinted `detail` (text stays sharp),
     **only while the call screen is open**: the recording
     is then the call as the founder sees it, the face or the voice visual, the captions, the conversation lines of
     both speakers and the call's controls. While the call is minimized the tab shows other pages (a private chat
     among them, which is never kept), so the composed call view below is drawn instead, from the moment the screen
     closes (before the browser paints the page under it) until half a second after it opens again (the tab's frames
     arrive a little late). The browser's own Stop sharing ends the track, which stops the recording and saves it.
   - **Picture, the call view:** while the call is minimized, and for the whole recording where this tab cannot be
     shared (iOS and iPadOS Safari, most phones; Firefox and desktop Safari, which share windows and screens but never
     just this tab, so no screen is asked for there) or was not (declined, refused, or the browser could not share
     it), a 1280×720 composition redrawn 24 times a second (15 within a shared tab's canvas, scaled to it): the face's
     own video element while a face shows (a vendor face's WebRTC track, or the stand-in's stream), labelled "AI
     avatar" as on the call tile, otherwise the call's presence (a sphere that follows the vEIR's measured voice, "AI
     voice"); the vEIR's name and the recording's time; and the conversation's latest lines from both speakers under
     their names (`CaptionRecorder.recent`: finished lines and those still being heard). It is drawn in the app's
     theme (light or dark, read every frame), as the shared tab shows it, so a take that minimizes the call does not
     flip between the two. Where this tab was asked for
     and not recorded the call screen says why, with OK: declined ("The screen wasn't shared, so the call view is
     recorded."), the browser failing ("The browser couldn't share this tab, so the call view is recorded.") or
     something else shared ("Only this tab can be recorded, …").
   - **Sound:** a WebAudio mix on the call's own AudioContext into a `MediaStreamAudioDestinationNode`: the speech
     player's output (what the speakers get, after ducking), a vendor face's voice from its element's audio track, and
     the founder's microphone through a gain the call's own gating drives (`microphoneOpen`): silent while muted, on
     hold, or in push to talk while the founder is not holding to talk (the track stays live then, so what is said
     off-mic would otherwise be recorded). `CallEngine.recordingSources()` hands these over without changing the call's
     graph; the recording re-taps them when the microphone reconnects or the face comes back.
     The shared screen's own sound is never taken, so nothing is heard twice.
   - **Container:** the first `isTypeSupported` of mp4 with H.264 + AAC (Chrome and Edge on a Mac or Windows, Safari)
     or webm (VP8/VP9 + Opus: Firefox, Chromium on Linux, which has no AAC encoder), sound only (mp4/AAC or webm/Opus)
     where no picture can be captured (a screen shared for it is stopped at once). mp4 comes first because
     `MediaRecorder` writes it with its length, and webm without one: a downloaded webm shows no length and seeks
     poorly in most players, and QuickTime, the Mac's own, opens none. A bare `video/mp4` is asked for only last
     (Chromium may fill it with Opus, which QuickTime does not play either). 96 kbit/s audio and 1.5 Mbit/s video for a shared tab (mostly still text: a 30-minute call is about 340 MB)
     or 1 Mbit/s for the composed view (about 235 MB, held in memory on the phones that record it), both under the
     512 MB cap (about 44 and 65 minutes).
   - **Captions:** a timed transcript recorded from the call's own captions as they change (each validated unit of
     the vEIR's reply as it is heard, each finished line of the founder's), never from the audio, saved beside the
     recording as WebVTT with one voice span per cue (`<v.veir Thomas>`, `<v.founder Maya>`).
2. **Controls.** Record sits in the call's dock between the microphone and End (keyboard `R`); while it records, a
   red dot, "REC" and its time show beside the call's time in the header, and the dock shows the time with Stop. While
   the browser asks which screen to share the control says Cancel (as does `R`) and nothing records; Cancel, or the
   call ending meanwhile, records nothing and offers Record again at once (a screen shared after all is stopped once it
   comes), and a screen shared after the call that Record was pressed in ended is never recorded for another call.
   Stop saves it; the browser's Stop sharing and hanging up (or the call ending any other way) stop and save it too.
   Before a person's first recording a short notice says what is recorded (this tab as they see it, with both voices;
   minimized, only the call view; and that the browser asks to share the tab first; where this tab cannot be shared,
   the call view: the AI avatar or the sphere, the conversation and both voices),
   where it is kept (privately, in the conversation and under Recordings, only they can watch it) and how to delete it
   (there, any time; with the conversation; otherwise after a year); it is remembered per person in the browser, like
   the call disclosure (version 2 since this tab is recorded, so everyone reads it again once). A
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
   whose call and when it began, in the person's time zone (`name` and `timeZone` from the browser: "Thomas call
   2026-11-07 14-22.webm", "… transcript.vtt"; "Call …" in UTC without them; characters a file system refuses and
   invisible formatting characters such as a right-to-left override removed). It is signed only once the file is
   confirmed stored (HeadObject), and audited only once signed, so a download that could not be issued is never
   recorded as one (a replay likewise). The browser loads it in a hidden frame (`saveDownload`: sandboxed to
   `allow-downloads`, so an error page from the store runs nothing, and removed after a minute), which saves the
   attachment; the page itself never navigates. Following it as a link would: the bucket's origin ignores a link's
   `download` attribute, and in Firefox and Safari starting that navigation breaks what the page has open even though
   the answer turns out to be an attachment (a take's upload, the call's streamed replies, its Transcribe socket), and
   it would meet the leave-the-page prompt (§2's `beforeunload`). A frame needs no CORS, and one origin in `frame-src`
   (§8). When a recording
   began (`startedAt`) is its registration, made as its save begins, less its length: what the lists show and a
   download is named after. `GET /recordings` lists one conversation's, one venture's or all of the caller's ready
   recordings, latest first, a page at a time (`limit`, at most 100; `nextCursor` → `cursor`, a keyset on the
   registration and id). `DELETE /recordings/:id` deletes it.
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
   (uploads, the captions file), `media-src` (the player) and `frame-src` (a download's hidden frame):
   `media-src 'self' blob: https://<bucket>.s3.<region>.amazonaws.com`,
   `frame-src 'self' https://<bucket>.s3.<region>.amazonaws.com` (`'self'` is what frames had from `default-src`).
   S3 sends no `X-Frame-Options`; `frame-ancestors 'none'` stays on the app's own pages.
   `scripts/smoke.mjs` checks it after each deploy (exactly two bucket origins in `connect-src`, the recordings one in
   both). The API role may Get/Put/Delete recording keys only (`tenants/*/recordings/*`; its GetObject allow-list now
   names venture documents and recordings); the worker may only delete them (an explicit deny on Get and Put). Neither
   may list the bucket, so a HEAD of a key not uploaded yet is answered 403: the API takes it as not uploaded and logs
   `recordings.head_denied`, so a real denial shows. The runtime contract adds
   `RECORDINGS_BUCKET` to the api and worker functions.
9. **Local development and the end-to-end suite** use `LocalRecordingStore` behind the same port: HMAC-signed tokens
   standing in for presigned URLs (`PUT|GET /api/v1/_local/recordings/:token`, development only, byte ranges
   answered, a download's token naming the file it is sent as, `Content-Disposition: attachment`, and that attachment
   sent without the API's frame denial, as S3 sends it: Safari downloads nothing from a frame under `X-Frame-Options`), at the API's own
   origin in the suite, so the recording is uploaded, replayed and downloaded cross-origin under the production CSP as
   it is from S3. A headless browser has no screen to share: the suite's founder shares a stand-in (`getDisplayMedia`
   answering with a canvas "tab" that carries the page's capture handle, or a window, or refusing as a founder who
   declines), and the suite counts the frames drawn from it (none while the call is minimized). Real tab capture was
   checked in Chromium's new headless mode (`--auto-accept-this-tab-capture`): the shared track reports
   `displaySurface: 'browser'`, the tab's size, and the page's capture handle at once.
10. **Recordings, a section with a viewer.** Recordings in the venture's side panel (`g r`, `/v/:id/recordings`) lists
    the person's recordings latest first, 50 at a time with Show older recordings until every kept one is reached:
    date, conversation, length, video or sound only, size, with Watch, Download (the recording, or its transcript when
    it has one) and Delete; a conversation lists its own the same way at the end of its transcript. Watch opens the
    viewer (`/v/:id/recordings/:recordingId`, its own route chunk, off the first page load): the player large, the
    transcript beside it (below it on a phone) marking the line being heard and keeping it in view unless the person
    scrolls it, a line seeking to it, `K` play or pause, `J` and `L` ten seconds back or forward; captions over the
    picture of a sound-only recording (a video already shows the call's own lines, so there they are off until turned
    on); Download, Open conversation and Delete. The call screen's Watch after a save opens it too.

## Options rejected

- **`getDisplayMedia` alone (2026-11-06; amended 2026-11-07):** unavailable on iOS, so a phone could not record at all.
  The first decision recorded only the composed call (face or presence) for that reason; the owner asked for the screen
  (what the founder sees, the conversation with it), so this tab is now the picture where it can be shared, without
  its sound (the call's own mix is the sound, so nothing is doubled), and the composed call view, now with the
  conversation's lines, where it cannot.
- **The shared track recorded as it is:** it records whatever the tab shows, so minimizing the call and opening a
  private chat would burn that chat into a kept recording of another conversation. Drawing the tab through the canvas
  only while the call screen is open keeps the recording to the call, and keeps it going while minimized.
- **Recording any surface the person picks** (a window, a whole screen; Firefox and desktop Safari offer nothing else):
  it records other apps and notifications, and a notice could not honestly promise less. Only a capture known to be
  this tab is recorded; elsewhere the call view is.
- **Stopping the recording when the call is minimized:** the call carries on minimized (Watch after a save relies on
  it), and so does its recording, as the call view.
- **Following a download as a link** (a top-level navigation answered as an attachment, which needs no CSP change; the
  first version of this amendment): in Firefox and WebKit starting the navigation breaks the page's open requests (an
  upload in flight fails or hangs, a streamed fetch fails, a WebSocket stops receiving), so a download during a call or
  a save could lose the save or the call's live connections, and it had to be let past the leave-the-page prompt.
  Checked in Chromium, Firefox and WebKit: a hidden frame downloads in all three with everything kept.
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
  and audited, without the page navigating (a call or a save goes on), with one exact origin in `frame-src` and no
  change to the bucket's CORS. Where the browser can, the file is an mp4 that states its length and opens in the
  computer's own player.
- Good: privacy holds in the database itself: owner-only rows, no private calls, gone with the conversation.
- Bad: the browser holds the recording in memory until it is saved; closing the tab before the save finished loses it
  (nothing is kept anywhere else). While it records, saves or waits for Try again, leaving the page asks first
  (`beforeunload`). A save that fails keeps it in the page with Try again.
- Bad: a WebM from `MediaRecorder` (Firefox, Chromium on Linux, and recordings made before mp4 came first) has no
  duration in its header; the player seeks to the end once to measure it, and a downloaded one shows no length.
- Bad: the browser asks which screen to share every time Record is pressed. Drawing the tab onto a canvas (up to
  1920×1080 at 15 fps) or composing the call view (1280×720 at 24 fps) costs a little CPU, and a hidden tab's timers
  may be slowed by the browser, freezing the picture (never the sound) until it is shown again. Firefox and desktop
  Safari record the call view, never the screen.

## Revisit when

- The owner wants recordings shared with a team member or an EIR (a consent and a sharing model, not a policy tweak).
- A recording longer than about 44 minutes of a shared tab is needed (the 512 MB cap), or storage cost per month passes
  USD 5 (`RecordingsBucket` size in the cost runbook).
