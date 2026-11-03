## Conversation lab: face

| | |
| --- | --- |
| Passed | 3/3 (100%) |
| Spend | USD 0.0330 (app 0.0330 of 2.00, lab 0.0000 of 0.00) |
| Stopped by | completed |
| Duration | 138 s |
| App models | us.amazon.nova-2-lite-v1:0 / global.amazon.nova-2-lite-v1:0 / amazon.titan-embed-text-v2:0 |
| Seed embeddings | chunks=70 memory=50 stoppedBy=done |

| App spend by purpose | USD | calls | units |
| --- | --- | --- | --- |
| speech | 0.0174 | 22 | 1169 |
| turn | 0.0106 | 10 | 56528 |
| distill | 0.0049 | 1 | 5697 |
| seed | 0.0001 | 9 | 6315 |
| embedding | 0.0000 | 6 | 158 |

Vendor: heygen-sandbox; face mode: lite; founder made a platform admin: granted; Playwright exit 0; success codes (token, start): [1000]; credits before 10.0, after 10.0, used 0.0.

| Check | Result |
| --- | --- |
| instruments_ok | pass |
| e1_success_code_recorded | pass |
| e1_livekit_host_expected | not measured |
| e2_no_credits_used | pass |
| e3_speak_text_exact | not measured |
| e4_queue_measured | not measured |
| e5_first_audio_under_target | not measured |
| e5_hand_over_at_unit_arrival | not measured |
| e5_unit_arrival_matches_polly | not measured |
| e6_interrupt_clears_queue | not measured |
| e7_no_microphone | not measured |
| e7_no_user_transcription | not measured |
| e8_speak_response_ignored | not measured |
| e9_full_token_publishes | not measured |
| e9_lite_token_cannot_publish | not measured |
| e10_transcript_endpoint_live | not measured |
| e10_injection_ends_face_in_a_heartbeat | not measured |
| e11_idle_end_recorded | not measured |
| e11_max_duration_enforced | not measured |
| label_ai_avatar_visible | not measured |
| falls_back_to_presence | not measured |

In-app arms side by side (the same founder turns, the same meters; p50 / p95 in ms, n):

| Moment | FULL | LITE | Polly only |
| --- | --- | --- | --- |
| Turn sent → first audio (level onset) | - | 2419 / 3149 (n=2) | 1741 / 3172 (n=2) |
| Turn sent → first avatar.speak_started | - | - | - |
| Turn sent → first spoken unit arrives (turn.speech) | - | 1166 / 1347 (n=2) | 1411 / 2826 (n=2) |
| Turn sent → first hand-over to the face (FULL speak_text, LITE face/speak) | - | 1563 / 2253 (n=2) | - |
| First unit arrives → its hand-over to the face (FULL: pre-approved, no face/say) | - | 397 / 907 (n=2) | - |
| Turn sent → first hand-over relayed (LITE face/speak answered) | - | 9812 / 10531 (n=2) | - |
| Server: turn request → model call starts (turn.timing) | - | 228 / 346 (n=2) | 235 / 277 (n=2) |
| Server: turn request → first spoken unit sent (turn.timing) | - | 1163 / 1343 (n=2) | 1405 / 2822 (n=2) |
| Each unit: hand-over → first audio | - | 859 / 1109 (n=7) | - |
| Each unit: hand-over → avatar.speak_started | - | - | - |

Before the arms, one unmeasured warm-up turn on Polly alone (so no arm meets the API process's first turn): turns 1, server model start 501 / 501 (n=1) ms, first spoken unit 2015 / 2015 (n=1) ms.

| Vendor call | HTTP status | Envelope code |
| --- | --- | --- |
| /v1/sessions/keep-alive | 200 x2 | 1000 x2 |
| /v1/sessions/start | 201 x1 | 1000 x1 |
| /v1/sessions/stop | 200 x1 | 1000 x1 |
| /v1/sessions/token | 200 x1 | 1000 x1 |
| /v1/users/credits | 200 x2 | 1000 x2 |

In-app call, LITE (the same founder turns; the avatar lip-syncs the call's Polly audio, relayed by the server over the speak socket):
- Face: heygen / audio, stock False, LiveKit host heygen-feapbkvq.livekit.cloud; shown True; face reference ready
- Each unit, face/speak → answered -; → speak_started -; → first audio p50 859 ms, p95 1109 ms (n=7); face/speak requests 7 (answered 204: 0), the call's own playback after the face joined 3
- Microphone requests after the face joined 0; audio tracks published 0

| Model attempts (app logs) | First attempts | First invalid_output | Share | All attempts |
| --- | --- | --- | --- | --- |
| distill | 1 | 0 | 0 % | 1 |
| turn | 10 | 0 | 0 % | 10 |

Server turn time: chat - ms; voice p50 4515, p95 6614 (n=5) ms; voice first speech p50 1405, p95 2822 (n=5) ms; Polly first audio p50 235, p95 882 (n=16) ms. Stream fallbacks: none; interrupt requests: 1.

Per voice turn (ms; "at" = since the request reached the API, the rest are durations; Titan embed sums every embedding call of the request, including any after the reply):

| Voice turn | Retrieval | Titan embed | Model start (at) | Time to first token | First token (at) | First delta (at) | Gate hold | First speech (at) | Polly first audio | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 412 | 391 | 501 | 1406 | 1907 | 2014 | 107 | 2015 | 601 | 6614 |
| 2 | 204 | 183 | 235 | 2320 | 2555 | 2822 | 267 | 2822 | 122 | 4485 |
| 3 | 196 | 176 | 277 | 910 | 1187 | 1405 | 218 | 1405 | 113 | 3180 |
| 4 | 197 | 180 | 228 | 899 | 1127 | 1343 | 216 | 1343 | 445 | 4515 |
| 5 | 286 | 262 | 346 | 680 | 1026 | 1163 | 137 | 1163 | 381 | 5887 |

