# The vEIR's face and voice (HeyGen LiveAvatar, ElevenLabs)

The vEIR can appear on calls as a video of its EIR (HeyGen LiveAvatar, LITE mode) and speak with the EIR's own
cloned voice (ElevenLabs). Everything ships **off**. This runbook is what the owner does to turn it on, what it
costs, how to stop it, and what the first live session must check. How it works:
[docs/architecture/calls.md §4](../architecture/calls.md#4-the-face-and-the-voice-of-a-call-the-digital-twin).

Who may act: the **owner** (vendor accounts, AWS secrets, deploys, Admin › Settings), each **EIR** (recordings,
vendor consent steps, their own consent in the studio), a **program lead** (vendor IDs in the studio; consent only
for a fictional EIR).

## What stays true whatever is switched on

- Our checks still decide every word. The face only renders audio our server made from units that passed the
  identity guard, the meta-narration gate and the sentence gate (signed units); the cloned voice is only ever
  called by our server with such a unit. Anything else is refused before the vendor sees it.
- The founder's voice still goes only to Amazon Transcribe. ElevenLabs receives the vEIR's validated words;
  HeyGen receives the vEIR's synthesized audio. No founder audio, transcript, memory or document leaves AWS.
- No vendor key reaches a browser. The face's speak channel stays on our server; the browser only watches.
- A face or voice that fails costs the call nothing: the presence tile and a standard voice take over silently.
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

In AWS CloudShell (us-east-1), without the key in your shell history:

```bash
read -rs KEY && printf '{"apiKey":"%s"}' "$KEY" > /tmp/k.json && unset KEY
aws secretsmanager create-secret --name foundry-ascent/media/heygen --secret-string file:///tmp/k.json
rm /tmp/k.json
# again for foundry-ascent/media/elevenlabs
```

Rotate later with `aws secretsmanager put-secret-value --secret-id <name> --secret-string file:///tmp/k.json`;
every API container picks the new key up within 5 minutes. Keep the default AWS-managed encryption.

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
   `face.sandbox: true`, `voice.provider: "elevenlabs"`. Deploy ([deploy and rollback](deploy-and-rollback.md)).
   The deploy adds the two secret grants and the `MEDIA_*` variables; nothing changes for anyone yet.
2. **Admin › Settings**: turn on **Video faces** and **Cloned voices** (each asks first and says the price). Set
   **Video minutes per person per month** (60) and **per call** (20 on Essential).
3. **Studio › the vEIR › Consent › Digital twin** (program lead or the EIR): paste the **HeyGen avatar ID** (the
   sandbox uses the vendor's sandbox avatar whatever is entered) and the **ElevenLabs voice ID**, status **Ready**.
   Ready needs the matching scope in the consent in force.
4. Run the **first live session checks** (§8) on a test venture.
5. **Production:** add the exact LiveKit origins from §8.2 to `media.face.csp.connect`, set `face.sandbox: false`,
   enter the EIR's real avatar ID, deploy. Pilot with named EIRs and founders first.

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

The app's own caps keep this bounded: 60 video minutes per founder per month and 20 per call (the vendor session
ends itself at that limit), the daily platform cap, and one face per call.

## 7. Stopping it

| To stop                  | Do                                                                                                            | Takes effect                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Every face               | Admin › Settings › **Video faces** off                                                                        | live faces end within 15 s        |
| Every cloned voice       | Admin › Settings › **Cloned voices** off                                                                      | the next sentence, standard voice |
| One vEIR's face or voice | Studio › Consent › Digital twin: **Withdraw…** the scope (EIR), or clear the vendor ID (curator)              | at once                           |
| All calls / all AI       | Admin › Settings › Voice calls off, or the AI kill switch ([runbook](kill-switch-and-persona-suspension.md))  | within 15 s                       |
| The vendors entirely     | `media.face.provider: "none"`, `media.voice.provider: "polly"`, deploy (removes the grants and the CSP hosts) | after the deploy                  |
| A leaked or abused key   | Revoke it at the vendor, then put the new one in the secret (§2)                                              | at once at the vendor             |

A withdrawn EIR's models are deleted at the vendors by hand for now (HeyGen avatar, ElevenLabs voice), within 7
days (30 promised).

## 8. First live session: what to check (sandbox, then once in production)

Written from the vendors' documentation; these are the points no test without keys can settle. Use a test venture,
DevTools open, faces and voices on.

1. **The speak channel takes a new connection per sentence.** The server opens `ws_url` for each unit and closes it.
   Speak several sentences in a row: every one must lip-sync. If the second fails, LiveAvatar wants one held
   connection per session; faces stay off (the app falls back) until the relay runs in a per-call worker.
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
5. **The face's voice is heard and ducks.** In Chrome, Safari and Firefox: the face's audio plays through the call
   (not the video element), barge-in stops it at once, and no sentence is heard twice.
6. **The session limit and the commands.** The token request carries `max_session_duration` (the adapter retries
   without it if refused) and the session must end by itself at the per-call limit; `agent.speak`,
   `agent.speak_end` and `agent.interrupt` behave as documented; ending a call stops the vendor session (credits stop).
7. **The clone on the faster model.** The default is `eleven_flash_v2_5` (about 190 ms to first audio). Ask
   ElevenLabs whether professional clones run on v4 Turbo; that model needs a different (WebSocket) endpoint, so it
   is not a configuration change.
8. **Reconcile.** After a week, compare the vendors' usage pages with the usage ledger ([platform insights](insights.md):
   `heygen:liveavatar-lite`, `elevenlabs:*`); more than 10 % apart means the metering needs a look.

## What still needs real keys or a decision

- Every point of §8 (nothing here has run against the vendors).
- Deleting a withdrawn EIR's models at the vendors automatically, and a nightly usage reconciliation.
- The privacy review: ElevenLabs (the vEIR's words) and HeyGen (the vEIR's audio and the EIR's likeness) as new
  processors.
