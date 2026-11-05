# The vEIR's live voice (ElevenLabs stock voice)

Every call speaks with one **ElevenLabs stock voice**: a synthetic voice that is no one's. Wherever the call names
its voice it is labelled **"AI voice"** (`GET /ventures/:id/call-config` → `voice: {vendor: "elevenlabs", label: "AI
voice"}`; the admin usage page lists it as "ElevenLabs · eleven_flash_v2_5", role "AI voice"). It is never
presented as the EIR's own voice. An EIR's consented clone (see [the face and voice runbook](avatars.md)) still
replaces it on calls where cloned voices are on and the EIR's voice is ready under voice consent.

Amazon Polly stays wired as the **fallback**. The founder's voice still goes only to Amazon Transcribe; ElevenLabs
receives only the vEIR's validated words (and, as prosody context, the validated words of the units around them).

## 1. What runs where

| Piece   | What it does                                                                                                                                                                                                                                                | Code                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Config  | `media.voice.provider: "elevenlabs-stock"`, `voiceId`, `model: "eleven_flash_v2_5"`, `fallback: "polly"`                                                                                                                                                    | `infra/cdk/config/production.json`                       |
| Key     | Secrets Manager `foundry-ascent/media/elevenlabs` (`{"apiKey": "…"}`), read by the API on first use, cached 5 min                                                                                                                                           | `apps/api/src/adapters/media-secrets.ts`                 |
| Adapter | `POST /v1/text-to-speech/{voiceId}/stream`, one request per validated unit, `pcm_24000` (or `mp3_44100_64` for an older page), `previous_text` / `next_text`, `language_code: "en"`, a 2 s first-audio deadline, a prewarm (`GET /v1/models`) at call start | `apps/api/src/adapters/elevenlabs-voice.ts`              |
| Core    | Chooses the voice (crisis line: always Polly; a ready clone; else the stock voice), writes numbers, symbols and addresses out as words (`speechText`), meters, falls back, rests a failing vendor 60 s                                                      | `packages/core/src/services/speech.ts`, `speech-text.ts` |
| Route   | `POST /speech` answers raw `audio/pcm` (rate in `x-speech-sample-rate`) when the page's `accept` names it                                                                                                                                                   | `apps/api/src/routes/veir.ts`                            |
| Browser | Plays the PCM as it arrives (100 ms jitter buffer, then 40 ms pieces back to back); barge-in stops every scheduled piece and cancels every fetch at once                                                                                                    | `apps/web/src/lib/realtime/pcm-stream.ts`, `playback.ts` |

The FULL HeyGen stock face (admins, sandbox) is unchanged: HeyGen voices admitted text in its own voice; a unit the face
cannot say falls back to our speakers in the ElevenLabs voice. A LITE face would be handed ElevenLabs' own 24 kHz PCM
(no resampling), whole, with its signed manifest.

## 2. The key (owner, once, and after each rotation)

1. The key is the GitHub Actions secret **`ELEVENLABS_API`** (Settings > Secrets and variables > Actions). Nobody
   pastes it anywhere else.
2. Merge and let **Deploy** finish. The deploy updates the foundation stack, which gives the deploy role
   `CreateSecret` / `PutSecretValue` on exactly `foundry-ascent/media/elevenlabs` (`GitHubDeployMediaKeyPolicy`), and the
   app stack, which lets the API read that one secret. Until the secret exists, every unit is spoken by Polly (the
   adapter fails on the missing key, core falls back) and the logs show `speech.vendor_failed`.
3. Actions > **Ops - sync ElevenLabs key** > Run workflow on `main`, mode **sync**. The summary says `created` (first
   run) or `updated`. The API reads the new key within 5 minutes.
4. Optional: run it again with mode **check**. It reports only the plan (tier) and the characters left this period,
   read from `GET /v1/user/subscription`; no key material and nothing else of the answer is printed. It needs no AWS.
   The plan must be **Starter or above**: the free plan has no commercial licence and cannot use library voices over
   the API.

Rotation: set the new value in `ELEVENLABS_API`, run **sync** again, then revoke the old key at ElevenLabs. A key
scoped to "Text to Speech" (plus "User: read" for **check**) is enough; it does not need speech-to-text or agents.

## 3. The voice, and how to change it

**Chosen: "Talia – soft, warm guide", voice id `OZ0L6eISlOejga3XjDFt`.** Why:

- ElevenLabs' old _default_ (formerly premade) voices stop working on **2026-12-31** and do not exist on accounts made
  after March 2026, so none of them can be pinned. ElevenLabs publishes a table of current Voice Library voices that
  replace them ("What are default voices?", help center, read 2026-11-05); Talia is the listed replacement for Sarah.
  A voice from that table is current, maintained by ElevenLabs as a default substitute, and usable over the API on
  any paid plan.
- A warm, unhurried guide's register suits a coach, and it is a female voice like the platform's Polly voice
  (`Danielle`), so a unit that falls back to Polly does not switch the vEIR's gender mid-sentence.
- It was chosen from the published description, not auditioned with our text (the key cannot be used locally).
  Listen to it in the first live call (section 5); the other listed candidates that fit a coach are "Caleb – trusted
  guide" `AaOhDHYJ1XLZk74lXhdE`, "Eddie – natural, helpful" `l7kNoIfnJKPg7779LI2t` and "Elara – crisp, professional
  narrator" `WQP7cQUF5aAS6Axh5yaa`.

Before keeping (or changing to) a library voice, check it at ElevenLabs (Voice Library, or `GET /v1/voices/{id}` with
the key): it is shared for API use, `disable_at_unix` is empty (no notice period running), and it carries no credit
multiplier. A voice made with Voice Design in the account itself has none of these risks.

To change it: edit `media.voice.voiceId` in `infra/cdk/config/production.json` (letters and digits, as ElevenLabs shows
the id), open a PR, merge, let Deploy finish. No code changes. To change the model, edit `media.voice.model`
(`eleven_flash_v2_5` is the lowest-latency multilingual model; `eleven_flash_v2` is English-only; v3/v4 models are not
for this HTTP path).

## 4. Safeguards (unchanged rules, applied to the new voice)

- **Only validated words.** Each request carries a signed unit (or matches a completed reply's stored spoken words);
  neighbours used as context are checked against their own signatures, and a neighbour that does not verify is dropped.
- **Never read aloud:** web and email addresses ("the link on screen"), Markdown, citation keys, table pipes. Numbers,
  money, percentages, ranges, ordinals, dates, times and phone-like digits are written out as words (`speechText`).
- **Caps and kill switches:** the AI and calls switches, the platform's daily spend cap, the call's and the person's
  speech budget (15 characters per second of call) all apply before the vendor is called. The crisis support line is
  always Polly.
- **Metering:** one usage-ledger row per synthesis, `elevenlabs:eleven_flash_v2_5`, at $0.04 per 1,000 characters
  (`packages/core/media-vendors.json`), billed when the synthesis started, whether or not playback finished (as for
  Polly). Reconcile monthly with ElevenLabs' usage page; more than 10% apart needs a look.
- **Fallback (60 s rest):** a vendor error, a missing key or no first audio within 2 s is not the end of the unit:
  Polly says the same words in the same response and the same reservation (one ledger row, Polly's; the unit is never
  said twice), and the vendor rests for 60 s in that container (its next units go straight to Polly). A stream that
  breaks after its first audio cannot be spliced: the unit ends where the audio stopped, and the vendor rests the same
  way. The audit marks a fallen-back unit `fallback: true`; `speech.timing` logs `voice`, `fallback` and `pcm`.
- **Turning it off:** `media.voice.provider: "polly"` and a deploy (every call then speaks Polly). The AI and calls
  kill switches stop all speech at once, as before.

## 5. What to check live after the first deploy

1. Deploy green; **Ops - sync ElevenLabs key** (sync) says `created`; (check) shows a paid tier and characters left.
2. Start a call as a founder (not only an admin: the voice is for everyone). The first reply is in the ElevenLabs
   voice; captions keep in step; the level meter moves.
3. CloudWatch, API function: `speech.timing` lines with `voice: "vendor"`, `fallback: false`, `pcm: true`; their
   `synthesizedMs` minus `reservedMs` is the vendor's time to first audio. No `speech.vendor_failed`. A few units
   with `fallback: true` right after a cold start are acceptable; many mean the 2 s deadline is too short for the
   region or the plan's concurrency is exhausted (`429`).
4. Barge in mid-sentence: the voice stops at once and nothing of the cut reply plays afterwards.
5. Admin › Usage: an "ElevenLabs · eleven_flash_v2_5" row priced per character.
6. Listen for numbers, money and a URL in a reply: they are said as words, and the URL as "the link on screen".
7. Whether a client abort through CloudFront cancels the Lambda's vendor request (`c.req.raw.signal`) is not verified;
   if ElevenLabs' usage shows more characters than the ledger, that is the first suspect.
