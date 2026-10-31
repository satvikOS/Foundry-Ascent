# The vEIR's face and voice (HeyGen LiveAvatar, ElevenLabs)

The vEIR can appear on calls as a video of its EIR (HeyGen LiveAvatar, LITE mode) and speak with the EIR's own
cloned voice (ElevenLabs). Until the EIR's own avatar exists, a HeyGen **stock avatar speaking in its own stock
voice** (LiveAvatar FULL mode, platform admins and the people they choose, labelled "AI avatar") can stand in for
presentations: §9; giving the demo account the face: §9.8.
Everything ships **off**. This runbook is what the owner does to turn it on, what it costs, how to stop it, and
what the first live session must check. How it works:
[docs/architecture/calls.md §4](../architecture/calls.md#4-the-face-and-the-voice-of-a-call-the-digital-twin).

Who may act: the **owner** (vendor accounts, AWS secrets, deploys, Admin › Settings), each **EIR** (recordings,
vendor consent steps, their own consent in the studio), a **program lead** (vendor IDs in the studio; consent only
for a fictional EIR).

## What stays true whatever is switched on

- Our checks still decide every word: only units that passed the identity guard, the meta-narration gate and
  the sentence gate (signed units) are ever said. **LITE** (the EIR's own face): the face only renders audio our
  server made from such a unit. **FULL** (a stock avatar, §9): the face only says text our server admitted from
  such a unit, once and in order, and the server reconciles what the vendor says it spoke against what it admitted
  (the vendor's session transcript) and ends the face on any difference. The cloned voice is only ever called by
  our server with such a unit. Anything else is refused before the vendor sees it.
- The founder's voice still goes only to Amazon Transcribe. ElevenLabs receives the vEIR's validated words;
  HeyGen receives the vEIR's synthesized audio (LITE) or its validated words (FULL). No founder audio, transcript,
  memory or document leaves AWS.
- No vendor key reaches a browser. In LITE the face's speak channel stays on our server and the browser only
  watches. In FULL the vendor takes commands only from the browser's room connection, so a modified page could make
  the face say other text **on its own screen** until the transcript check ends the face (within one 15 s
  heartbeat): that is why FULL is for platform admins and the people they name only (§9.8), and never for an EIR's
  likeness (§9).
- A face or voice that fails costs the call nothing: the presence tile takes over from a face silently, and a
  standard voice speaks the same sentence when the cloned voice fails (that clone is then skipped for a minute).
- The crisis line is never said by the face or the cloned voice.

## 1. Accounts and plans (owner)

1. **HeyGen LiveAvatar** — https://www.liveavatar.com (separate from HeyGen Studio).
   - Plan **Essential, $99 a month** for the pilot (1,100 credits, 1 custom avatar at 720p, 20-minute sessions).
     **Business, $475** for 1080p or calls over 20 minutes. Each extra EIR avatar is **$49 a month**.
   - Billing: **auto top-up off**. When credits run out, faces end and calls go on with the presence.
   - Ask HeyGen for the DPA, an opt-out from training on our content, and written confirmation that LITE mode
     keeps no session data.
   - Create an API key.
2. **ElevenLabs** — https://elevenlabs.io
   - **Creator, $22 a month** for one EIR (one professional voice clone); **Scale, $299** for two or three.
   - Before real students: ask for **Enterprise** terms (zero retention, DPA, US data residency).
   - Create an API key **restricted to Text to Speech and Voices**.
3. **AWS** (account administrator): turn on the AI services opt-out policy for Amazon Transcribe and Polly
   ([owner actions](owner-actions.md)).

## 2. Keys into AWS Secrets Manager (owner, us-east-1)

Each secret is the JSON `{"apiKey": "<key>"}` under exactly this name (the API role can read only these two, and
only once the deployment wires that vendor):

| Secret                            | Key                |
| --------------------------------- | ------------------ |
| `foundry-ascent/media/heygen`     | LiveAvatar API key |
| `foundry-ascent/media/elevenlabs` | ElevenLabs API key |

**The HeyGen key, from GitHub (no shell needed):**

1. GitHub → the repository → **Settings › Secrets and variables › Actions › New repository secret**: name
   `HEYGEN_LIVEAVATAR_API`, value the LiveAvatar API key. (Already set? Skip to 2. To rotate, update it here.)
2. **Actions › Ops - sync HeyGen key › Run workflow** (branch `main`). It runs in the `production` environment
   (approve it if the environment asks) as the deploy role, and creates `foundry-ascent/media/heygen` the first time
   or stores the new value after that. The job summary says _created_, _updated_ or _skipped_ (the repository
   secret is empty). Run it again after every rotation; re-running with the same key changes nothing that matters
   (the same value becomes the current version again).

The key is never printed: the workflow masks it, never puts it on a command line, writes it to Secrets Manager from
a file only the runner's user can read and deletes that file, and installs or runs no project code. The deploy role
may create and write that one secret and nothing else of Secrets Manager; it cannot read the key (or even its
metadata) back
(`infra/cdk/src/stacks/foundation-stack.ts`, `GitHubDeployMediaKeyPolicy`). Giving the deploy role this one write
adds nothing it could not already reach: it deploys the code that reads the key. A key that leaked or was abused is
revoked at HeyGen first (§7), then replaced the same way.

**The ElevenLabs key** (or the HeyGen key without GitHub), in AWS CloudShell (us-east-1), without the key in your
shell history:

```bash
read -rs KEY && printf '{"apiKey":"%s"}' "$KEY" > /tmp/k.json && unset KEY
aws secretsmanager create-secret --name foundry-ascent/media/heygen --secret-string file:///tmp/k.json
rm /tmp/k.json
# again for foundry-ascent/media/elevenlabs
```

Rotate later with `aws secretsmanager put-secret-value --secret-id <name> --secret-string file:///tmp/k.json`
(the HeyGen key: the workflow above); every API container picks the new key up within 5 minutes. Keep the default
AWS-managed encryption.

## 3. Recordings from each EIR

**Face (LiveAvatar): one continuous take of about 2 minutes, no cuts.**

- 15 s listening (relaxed, small nods, a smile), 90 s speaking naturally as if coaching a founder (pauses with the
  mouth closed), 15 s idle looking at the camera.
- 1080p, at least 25 fps, landscape, camera at eye level on a tripod, chest-up, head centred with room above.
- Soft even light from the front (a window in front, or a soft light at 45°); no backlight, hard shadows or
  flicker. A plain or tidy real office background with nothing moving; a quiet room.
- Usual coaching clothes (no fine stripes, hats or sunglasses); hands below the frame; little head movement.
- Then the EIR does HeyGen's **live webcam consent** (the link is valid 24 h; they read the statement with the
  spoken passcode).

**Voice (ElevenLabs professional clone): at least 30 minutes, ideally 1–2 hours, the EIR alone.**

- Natural coaching talk: walking through founder cases, reading their own notes aloud, asking questions.
- Same microphone and room every session: a decent USB or XLR microphone 15–30 cm away with a pop filter, a soft
  quiet room, no music or other voices, no heavy processing. WAV 44.1/48 kHz (or MP3 ≥ 192 kbps).
- Then the EIR **reads ElevenLabs' voice CAPTCHA live** (only the person themselves can verify a clone).

**Portrait** (for the presence tile and as a fallback): square, ≥ 1152 px, neutral background, natural light,
neutral expression, mouth closed.

## 4. Our consent (each EIR, in the studio)

The EIR signs our consent in addition to the vendors' steps (draft wording below, for counsel to review), then
records it on their vEIR's **Consent** tab with the scopes it covers. The twin needs:

- **Likeness** for the video face, **Voice** for the cloned voice, **First-person twin** to appear as
  "Corin · vEIR" (and **Doctrine**, which every vEIR needs).
- Each scope can be withdrawn alone (Consent tab › Digital twin › Withdraw…): the rest of the consent stays, the
  vEIR keeps coaching, and the face ends or the voice switches to a standard one **at once**.

> **Digital twin consent: [full name]**
>
> I agree that Foundry Ascent may create and use a digital twin of me for the [program name] program:
>
> - **My likeness:** a video avatar made from the recording I provide, rendered by HeyGen.
> - **My voice:** a voice model made from the audio I provide, by ElevenLabs. If it is unavailable, the platform
>   uses a standard voice instead.
>
> The twin appears to founders in this program in calls and chat under my first name with a "vEIR" label, and
> speaks in the first person as my digital twin. When someone sincerely asks, it says it is my digital twin. It
> never claims to be me in person, to be human, or that I said or approved something.
>
> It only says words the platform's checks have approved. It is not used for marketing, for other programs or for
> anything else without my separate written consent.
>
> I understand that founders see and hear the twin on their own devices and could record their screen.
>
> I can withdraw this consent, or any part of it, at any time in the studio. The twin's face or voice stops at
> once, and the avatar and voice models are deleted at the vendors within 30 days. This consent ends on [date]
> unless I renew it.
>
> Signed, dated.

## 5. Turning it on

1. **Sandbox first.** In `infra/cdk/config/production.json` → `media`: `face.provider: "heygen-liveavatar"`,
   `face.sandbox: true`, `face.csp.connect: ["wss://heygen-feapbkvq.livekit.cloud",
"https://heygen-feapbkvq.livekit.cloud"]` (LiveAvatar's LiveKit project, from its firewall documentation; §8.2
   confirms it), `voice.provider: "elevenlabs"`. Deploy ([deploy and rollback](deploy-and-rollback.md)). The deploy
   adds the two secret grants, the `MEDIA_*` variables and those two CSP origins; synth refuses a wired face
   without both origins (the room would be blocked and the face would never show). Nothing changes for founders:
   while `sandbox` is true a face is offered only to **platform admins** and the people a platform admin gave
   **Video face** (§9.8; the sandbox shows the vendor's stock avatar, whatever the EIR).
2. **Admin › Settings**: turn on **Video faces** and **Cloned voices** (each asks first and says the price). Set
   **Video minutes per person per month** (60) and **per call** (20 on Essential).
3. **Studio › the vEIR › Consent › Digital twin** (program lead or the EIR): paste the **HeyGen avatar ID** (the
   sandbox uses the vendor's sandbox avatar whatever is entered) and the **ElevenLabs voice ID**, status **Ready**.
   Ready needs the matching scope in the consent in force.
4. Run the **first live session checks** (§8) signed in as a founder of a test venture who is a platform admin or
   has **Video face** (§9.8; founders and team members are the only people who can call).
5. **Production:** keep or correct the LiveKit origins in `media.face.csp.connect` from §8.2, set
   `face.sandbox: false`, enter the EIR's real avatar ID, deploy. Pilot with named EIRs and founders first.

Per persona: a vEIR without a ready face shows the presence; one without a ready voice speaks with its standard
voice. A call that started with the stock voice keeps it until it ends.

## 6. Costs

The app meters every face second and clone character into the usage ledger at list price
(`packages/core/media-vendors.json`): **$0.093 a minute** of face (LiveAvatar LITE on Essential: $99 + $0.095 a
credit beyond 1,100, one credit a minute, billed while the session is open, silence included) and **$0.04 per
1,000 characters** of cloned voice. Both count toward the platform's daily AI cap (Admin › Settings), not toward a
founder's personal cap.

| At 50 founders × 4 calls × 15 minutes a month | Per month  |
| --------------------------------------------- | ---------- |
| Face, one EIR (Essential)                     | about $280 |
| Cloned voice, one EIR (Creator + usage)       | about $54  |
| Polly no longer used for those calls          | about −$22 |
| **One EIR, face and voice**                   | **≈ $340** |
| Two EIRs, face and voice (Scale)              | ≈ $640     |

The app's own caps keep this bounded: 60 video minutes per founder per month and 20 per call, the daily platform cap,
and one face per call. The per-call limit is enforced twice: the vendor session is opened with it
(`max_session_duration`; if the vendor refuses the value, no session opens and calls keep the presence, so keep
**per call** at or below the plan's session length: 20 on Essential), and the heartbeat ends the face there itself.
A call left on hold (page hidden) for a minute gives its face up, since LITE bills idle minutes.

FULL mode (§9) costs twice as much per minute: **$0.19 a minute** of face (two credits a minute, metered as
`heygen:liveavatar-full`). At presentation volume that still fits the Essential plan: §9.6.

## 7. Stopping it

| To stop                  | Do                                                                                                            | Takes effect                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Every face               | Admin › Settings › **Video faces** off                                                                        | live faces end within 15 s        |
| Every cloned voice       | Admin › Settings › **Cloned voices** off                                                                      | the next sentence, standard voice |
| One vEIR's face or voice | Studio › Consent › Digital twin: **Withdraw…** the scope (EIR), or clear the vendor ID (curator)              | at once                           |
| All calls / all AI       | Admin › Settings › Voice calls off, or the AI kill switch ([runbook](kill-switch-and-persona-suspension.md))  | within 15 s                       |
| The vendors entirely     | `media.face.provider: "none"`, `media.voice.provider: "polly"`, deploy (removes the grants and the CSP hosts) | after the deploy                  |
| The stock face (FULL)    | `media.face.mode: "lite"` and remove `media.face.stock`, or `provider: "none"`, deploy                        | after the deploy                  |
| A leaked or abused key   | Revoke it at the vendor, then put the new one in the secret (§2)                                              | at once at the vendor             |

A withdrawn EIR's models are deleted at the vendors by hand for now (HeyGen avatar, ElevenLabs voice), within 7
days (30 promised).

A face whose browser vanished (tab closed, network gone) is no longer kept alive by heartbeats, so the vendor
closes it after its 5-minute idle timeout; the daily maintenance then bills its seconds up to the call's end
(`maintenance.call_faces` in the audit log).

## 8. First live session: what to check (sandbox, then once in production)

Written from the vendors' documentation; these are the points no test without keys can settle. Use a test venture,
DevTools open, faces and voices on.

1. **The speak channel takes a new connection per hand-over.** The server opens `ws_url` for each part of a unit
   (at most 18 s), waits for `connected`, sends one-second chunks, waits until the vendor acknowledged them (and,
   on the unit's last part, `agent.audio_buffer_committed`), and closes. The vendor allows one socket per session
   and says a new one replaces the old. Speak several sentences in a row and one long answer (over 18 s, so it
   arrives in two parts): every one must lip-sync to the end. If an utterance stops when its socket closes, or the
   second part of a long one is lost, LiveAvatar wants one held connection per session: faces stay off (the app
   falls back on its own) until the relay runs in a per-call worker.
2. **CSP hosts.** Note the exact `wss://` and `https://` LiveKit origins the room uses (Network tab; LiveAvatar's
   project is `heygen-feapbkvq.livekit.cloud`). Put exactly those in `media.face.csp.connect` (no wildcards) and
   check the console shows no CSP violation. TURN (UDP 3478, TCP 443) is not governed by the CSP; university
   networks may need it allowed.
3. **The browser's token can only watch.** Decode the room token from `POST /calls/avatar-session` (jwt.io): its
   video grant must not allow `canPublish` or `canPublishData`. If it allows data, a modified page could send the
   vendor's `agent-control` commands: keep faces to the pilot and move to our own LiveKit project
   (`livekit_config`, subscribe-only tokens) before students.
4. **Render delay.** From a sentence's hand-over to the face's first sound (the call's first-audio time with the face
   on, against off). Expect 0.3–0.6 s more; above about 1 s, compare with Anam (the fallback in the design).
5. **The face's voice is heard, in step, and ducks.** In Chrome, Safari and Firefox, on the laptop's speakers and on
   Bluetooth headphones: the face's video and audio play in one element (the tile's `<video>` holds both tracks and
   is not muted; [calls.md §4.3](../architecture/calls.md#43-the-face-of-a-call)), so the voice no longer crosses
   the call's Web Audio graph and its extra latency; a barge-in mutes it at once (before the vendor's interrupt
   arrives), the voice dips while a possible barge-in is confirmed (not on iOS, which ignores an element's volume),
   no sentence is heard twice, minimizing the call keeps the voice going, and ending the call silences it. In
   DevTools no `MediaStreamAudioSourceNode` of the face's track connects to anything but an `AnalyserNode`.
   - **Same remote stream.** WebRTC keeps an audio and a video track in step only when the sender put them in one
     remote stream (the same msid; LiveKit tracks published under one `stream` name), whatever element plays them,
     and Firefox does not pair them at all. The face lab's in-app call records it (`av_same_stream` in the face
     summary; by hand: in DevTools, the `streams[0].id` of the subscriber connection's two `track` events, which
     LiveKit writes `participantSid|streamName`). If the vendor sends them apart, the single element removes the
     Web Audio delay but nothing else holds the two together: tell HeyGen and measure how far apart they drift.
   - **Measure the offset**, before and after a change to this path: record the tile with a phone's camera on the
     laptop's speakers and on Bluetooth headphones, and count frames between a plosive's lip closure and its sound
     (30 fps: one frame is 33 ms). Note the browser, the output device and `av_same_stream`.
   - **Sound refused.** On iOS Safari with typed input (no microphone), the element may be refused its sound: the
     voice then comes through the call's own output, and at the founder's next tap (its end), click or key the
     element sounds again. A tap must never cut the voice, even for a moment.
   - **Why a face went away.** A face that leaves the call early has its reason in the audit log: the face's
     `call.face_ended` event has the server's cause (`policy_reason`: `face_dropped` when the page ended it,
     `face_injection` or `face_check_failed` from the transcript check, `face_limit`, `face_minutes`, `spend_cap`,
     ...) and, when the page ended it, which trigger fired (`metadata.clientReason`: `video_ended`,
     `video_unsubscribed`, `room_disconnected`, `vendor_stopped` with the vendor's `vendorReason`, `no_video`,
     `connect_timeout`, `connect_failed`, `crisis`, `on_hold`).
6. **The session limit, the envelope and the commands.** The token request carries `max_session_duration` (a 422
   means it is above the plan's session length: lower **per call**); the session must end by itself at the per-call
   limit. Responses must carry `code: 1000` on success (the vendor's SDK checks 1000; its API reference shows a
   default of 100: if a successful start returns another code, every face falls back to the presence and the
   adapter's success code needs changing). `session.state_updated: connected` arrives on each new socket, and
   `agent.speak`, `agent.speak_end` and `agent.interrupt` are acknowledged as documented; ending a call stops the
   vendor session (credits stop).
7. **The clone on the faster model.** The default is `eleven_flash_v2_5` (about 190 ms to first audio). Ask
   ElevenLabs whether professional clones run on v4 Turbo; that model needs a different (WebSocket) endpoint, so it
   is not a configuration change.
8. **Reconcile.** After a week, compare the vendors' usage pages with the usage ledger ([platform insights](insights.md):
   `heygen:liveavatar-lite`, `elevenlabs:*`); more than 10 % apart means the metering needs a look.

## 9. FULL mode: a stock avatar with its stock voice (platform admins and chosen people only)

For presentations before the EIR's own avatar exists (owner decision, until mid-December): a HeyGen **stock**
avatar, speaking in its **stock** voice, says the vEIR's validated words. Only platform admins and the people a
platform admin gave **Video face** (§9.8) are offered it, and
the call tile labels it **"AI avatar"**: it is not the EIR's digital twin, so no likeness consent is involved. The
LITE path (§5, our Polly or cloned audio lip-synced on the EIR's own avatar) is unchanged and remains the path for
the EIR's likeness later; FULL is never used for a likeness (synth refuses `mode: "full"` without a stock avatar).

### 9.1 How it differs from LITE

|                            | LITE (§5)                                              | FULL (this section)                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Whose face                 | the EIR's own avatar, under likeness consent           | a HeyGen stock avatar, labelled "AI avatar"                                                                                                                                          |
| Voice                      | our audio (Polly, or the EIR's ElevenLabs clone)       | the avatar's HeyGen stock voice (FULL mode only)                                                                                                                                     |
| What the vendor receives   | the vEIR's synthesized audio, from our server          | the vEIR's validated words, as text                                                                                                                                                  |
| Who sends it               | our server (the speak channel never reaches a browser) | the browser, over the vendor's room, after our server admits the text (as it signs a reply's units, else `POST /calls/:id/face/say`)                                                 |
| What our server guarantees | the face cannot say anything else                      | the face is only given admitted text by our client; anything else said (a modified page, on its own screen) is caught by the transcript check within one heartbeat and ends the face |
| Who is offered it          | everyone the consent covers (sandbox: admins)          | platform admins and people with Video face (§9.8); synth refuses another audience                                                                                                    |
| Price                      | $0.093 a minute (one credit)                           | $0.19 a minute (two credits)                                                                                                                                                         |

Never the crisis line, in either mode: a crisis turn drops the face to the presence at once.

### 9.2 Configuration

`infra/cdk/config/production.json` → `media.face` (README: [infra/cdk](../../infra/cdk/README.md)):

| Key              | Values                                                                                                   | API variable           |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------------- |
| `mode`           | `lite` (default) or `full`                                                                               | `MEDIA_FACE_MODE`      |
| `stock.avatarId` | a LiveAvatar avatar id (UUID); required with `full`, refused with `lite`                                 | `MEDIA_FACE_AVATAR_ID` |
| `stock.voiceId`  | a LiveAvatar voice id (UUID), `full` only; absent: the avatar's default voice                            | `MEDIA_FACE_VOICE_ID`  |
| `audience`       | `admins` or `everyone`; default `admins` with `full` (the only value it accepts), `everyone` with `lite` | `MEDIA_FACE_AUDIENCE`  |

Synth refuses `full` without `stock.avatarId`, `full` with `audience: "everyone"`, and any `stock` with `lite` (in
LITE the face is always the persona's own; the API would ignore a stock avatar there). It also refuses any of these
values other than the LITE defaults while `apps/api/lambda-contract.json` does not list the variable for the `api`
role: a FULL configuration then fails the deploy loudly instead of running as LITE.
FULL changes no permission: the API still reads only `foundry-ascent/media/heygen`, and the CSP the same LiveKit
origins as LITE.

### 9.3 Owner steps

1. **Now: nothing to buy.** The LiveAvatar **sandbox** is free: the Wayne avatar only, sessions of about a minute,
   no credits used. Every test runs there first.
2. **The key:** the GitHub secret `HEYGEN_LIVEAVATAR_API` and **Ops - sync HeyGen key** (§2). No CloudShell.
3. **Around 20 November: buy Essential ($99 a month)** so one billing month covers rehearsals and the presentation.
   Turn **auto top-up off** (overage is billed in $100 steps) and cancel the renewal after the presentation. The
   Free plan is not usable (5 FULL minutes a month, 2-minute sessions, a watermark).
4. **Pick the avatar and voice** from the stock list (`GET /v1/avatars/public`, each with `default_voice` and
   `is_1080p`; voice previews from `GET /v1/voices`, preferring the `elevenLabs` engine) and give us the two ids.
   Ids are not secrets; the key is.

### 9.4 Turning it on (us, after review)

1. **Sandbox phase.** `media.face`: `provider: "heygen-liveavatar"`, `sandbox: true`, `mode: "full"`,
   `audience: "admins"`, `stock: {"avatarId": "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a"}` (Wayne, the only sandbox
   avatar), `csp.connect: ["wss://heygen-feapbkvq.livekit.cloud", "https://heygen-feapbkvq.livekit.cloud"]`. Keep
   `voice.provider: "polly"` (the fallback when the face fails). Deploy. The deploy adds the read grant on the
   HeyGen key, the `MEDIA_FACE_*` variables and the two CSP origins. The variables reach the API only once
   `apps/api/lambda-contract.json` lists `MEDIA_FACE_MODE`, `MEDIA_FACE_AVATAR_ID`, `MEDIA_FACE_VOICE_ID` and
   `MEDIA_FACE_AUDIENCE` under `environment.api` (part of the app change); until then synth refuses this
   configuration (`No function would receive MEDIA_FACE_MODE, …`) rather than deploying it as LITE.
2. **Admin › Settings:** turn **Video faces** on; **per call** 20 minutes (the Essential session cap); about 600
   video minutes a month; a platform spend cap of at least $120.
3. **Studio:** nothing. A stock face needs no avatar id or consent on the persona.
4. Run the live checks (§9.5) from a founder account of a test venture that has **Video face** (§9.8).
5. **Presentation phase.** `sandbox: false`, `stock.avatarId` and `stock.voiceId` the chosen ids, `audience`
   still `"admins"`. Deploy, then present from the founder account with **Video face** (§9.8). Other founders
   never see the face.

### 9.5 Live checks (sandbox first, about a minute each)

1. Token and start return the vendor's success code (the adapter's code must match: otherwise every face silently
   falls back to the presence), and the room's host matches `csp.connect`.
2. `GET /v1/users/credits` before and after: the sandbox uses none.
3. Each sentence: admitted by the server (a reply's units as they are signed, `turn.speech` `face: true`; the intro
   through one `/face/say` 204), then the face says exactly that text, and the session transcript matches. A reply's
   first unit is handed to the face as it reaches the page (the lab's `e5_hand_over_at_unit_arrival`), and reaches
   the page about when Polly alone's does (`e5_unit_arrival_matches_polly`: the approval did not just move the round
   trip to the server). A reply blocked or failed after its units were pre-approved has what the face did not say
   withdrawn (`call.face_text_withdrawn`).
4. Several sentences in a row: they queue in order (or each cuts off the last: the app is built for either; note
   which, and the gap between one sentence's end and the next one's start).
5. Latency, FULL against LITE: from the founder's end of speech to the face's first sound; target under 1.2 s.
6. Barge-in (`avatar.interrupt`): how fast the face falls silent, and whether queued sentences are dropped.
7. No microphone: no browser microphone prompt, no `user.transcription` events (push-to-talk is never started).
8. A `speak_response` or `speak_text` sent from DevTools: the first should be ignored (the session carries no
   context, the vendor's restricted mode, so its own model should never answer); the second must be caught by the
   transcript check and end the face within one heartbeat (audited `call.face_injection`). Also confirm the
   transcript endpoint answers during the session.
9. Idle and keep-alive behaviour, `session.stopped` reasons, and that the session ends at the per-call limit.
10. **Paid phase:** a 3-minute session with the chosen avatar costs 6 credits; no watermark; killing it mid-call
    falls back to the presence and Polly with no stray audio, the label still shown.
11. **Lip sync.** Watch the mouth against the voice for a few sentences, on speakers and on Bluetooth, and measure the
    offset as in §8.5: they must move together. The face's video and voice play in one element (no Web Audio
    delay); check §8.5's DevTools point and whether the two tracks share one remote stream (`av_same_stream`: only
    then does WebRTC keep them in step). A face whose mouth leads its voice by a visible amount with
    `av_same_stream` true means the voice is being played somewhere else; with it false, the vendor sends them
    apart.
12. **A face that leaves early.** If the face disappears well before the session limit, read the `call.face_ended`
    audit of that call (§8.5, "Why a face went away") before changing anything: it says whether the server stopped
    it (and why) or which of the page's triggers fired.

### 9.6 Cost

Essential: $99 for 1,110 credits, about 550 FULL minutes. About 30 minutes of paid checks, ten 20-minute rehearsals
and the presentation with a backup session come to about 540 credits: **$99 in total, no overage.** Idle time is
billed, so the face opens only during a call, and a call on hold for a minute gives it up.

### 9.7 Still open

- HeyGen marks `avatar_persona` (how the stock voice is chosen) deprecated in favour of stored voice agents; the
  adapter is pinned to recorded responses, so a change shows up as failing tests, not as a silent change.
- HeyGen's privacy policy allows training on inputs with an opt-out by email, while the LiveAvatar FAQ says data is
  never used for training: send the opt-out before real founders ever see a face.
- Essential sessions end at 20 minutes: a longer presentation needs a planned reconnect.

### 9.8 Giving one person the face (the demo account)

The face is offered only to platform admins, but only a venture's founders and team members can start a call, and
the demo runs from one founder account. So a platform admin gives that one account the face:

1. Sign in as a platform admin. **Admin › People & access**.
2. Find the demo founder (search by name or email). In the **Video face** column, turn the switch on and confirm
   **Turn on**. The switch stays on; the change is audited as `principal.face_access_updated` (ids only).
3. **Admin › Settings:** **Video faces** must be on, with video minutes left this month and per call (§9.4 step 2).
4. Sign in as the demo founder (or reload the page if already signed in: no new sign-in is needed, each call reads
   the switch afresh) and start a call. The tile shows the stock avatar labelled **"AI avatar"**.

Video face changes only _who_ may see the face. Faces on, the video minutes, the platform spend cap and (for an
EIR's likeness) consent still decide whether a call has one, and turning **Video faces** off in Settings still
stops every face within seconds. To take it away, turn the person's switch off (no confirmation): their next call
has the presence. The same works by API: `PATCH /api/v1/admin/principals/<id>` with `{"faceAccess": true}`
(platform admin only). A face that does not appear for that account: check the switch, then Settings, then the
`call.avatar_session` audit (`admins_only` / `sandbox_only` means the account has no Video face).

## What still needs real keys or a decision

- Every point of §8 (nothing here has run against the vendors).
- Until §8.3 shows the browser's room token cannot publish data (or our own LiveKit project issues subscribe-only
  tokens), keep faces to a pilot: `faces_enabled` is platform-wide, so mark only the pilot EIRs' faces **Ready** (a
  vEIR without a ready face shows the presence to everyone).
- Deleting a withdrawn EIR's models at the vendors automatically, and a nightly usage reconciliation (both need the
  vendors' delete and usage APIs called with real keys; until then §7 and §8.8 by hand).
- The privacy review: ElevenLabs (the vEIR's words) and HeyGen (the vEIR's audio and the EIR's likeness) as new
  processors.
