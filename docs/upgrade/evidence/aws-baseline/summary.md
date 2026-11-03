## Conversation lab: voice

|                 |                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------ |
| Passed          | 1/1 (100%)                                                                                 |
| Spend           | USD 0.0944 (app 0.0894 of 1.70, lab 0.0049 of 0.30)                                        |
| Stopped by      | completed                                                                                  |
| Duration        | 158 s                                                                                      |
| App models      | us.amazon.nova-2-lite-v1:0 / global.amazon.nova-2-lite-v1:0 / amazon.titan-embed-text-v2:0 |
| Seed embeddings | chunks=70 memory=50 stoppedBy=done                                                         |

| App spend by purpose | USD    | calls | units  |
| -------------------- | ------ | ----- | ------ |
| speech               | 0.0616 | 27    | 971    |
| turn                 | 0.0239 | 16    | 134219 |
| distill              | 0.0038 | 1     | 5725   |
| seed                 | 0.0001 | 9     | 6315   |
| embedding            | 0.0000 | 11    | 272    |

| Lab spend by purpose | USD    | calls |
| -------------------- | ------ | ----- |
| voice                | 0.0049 | 4     |

Input: transcribe (microphone opened True, line 1 through the fake device True); mean WER 0.0; result pass.

- First audio after the founder stops speaking: p50 2130 ms, p95 2389 ms
- End of speech to turn sent (endpointing + transcription): p50 680 ms, p95 793 ms
- Turn sent to first audio (model + speech): p50 1386 ms, p95 1709 ms
- Barge-in: attempted 2, reply was playing 2, interrupt sent 2, playback stopped after 1190 ms (p50 of [1212, 1190])
- Calls: 2; self-interruptions (interrupts the test did not cause): 0
- App-reported (call end): [{"firstAudioMsP50": 1358.0, "firstAudioMsP95": 1713.0, "bargeIns": 1.0, "reconnects": 0.0}, {"firstAudioMsP50": 1388.0, "firstAudioMsP95": 1527.0, "bargeIns": 1.0, "reconnects": 0.0}]

| Line         | WER | End of speech → turn | Turn → first audio | First audio |
| ------------ | --- | -------------------- | ------------------ | ----------- |
| call 1: VC-1 | 0.0 | 680                  | 1709               | 2389        |
| call 1: VC-2 | 0.0 | 770                  | 1477               | 2247        |
| call 1: VC-3 | 0.0 | 778                  | 1352               | 2130        |
| call 1: VC-4 | 0.0 | 667                  | 1355               | 2022        |
| call 2: VC-1 | 0.0 | 680                  | 1386               | 2066        |
| call 2: VC-2 | 0.0 | 793                  | 1523               | 2316        |
| call 2: VC-3 | 0.0 | 655                  | 1289               | 1945        |
| call 2: VC-4 | 0.0 | 673                  | 1510               | 2183        |

| Model attempts (app logs) | First attempts | First invalid_output | Share | All attempts |
| ------------------------- | -------------- | -------------------- | ----- | ------------ |
| distill                   | 1              | 0                    | 0 %   | 1            |
| turn                      | 16             | 0                    | 0 %   | 16           |

Server turn time: chat - ms; voice p50 3247, p95 5592 (n=8) ms; voice first speech p50 1248, p95 1552 (n=8) ms; Polly first audio p50 137, p95 425 (n=19) ms. Stream fallbacks: none; interrupt requests: 2.

Per voice turn (ms; "at" = since the request reached the API, the rest are durations; Titan embed sums every embedding call of the request, including any after the reply):

| Voice turn | Retrieval | Titan embed | Model start (at) | Time to first token | First token (at) | First delta (at) | Gate hold | First speech (at) | Polly first audio | Total |
| ---------- | --------- | ----------- | ---------------- | ------------------- | ---------------- | ---------------- | --------- | ----------------- | ----------------- | ----- |
| 1          | 380       | 353         | 480              | 941                 | 1421             | 1552             | 131       | 1552              | 122               | 3680  |
| 2          | 204       | 178         | 240              | 954                 | 1194             | 1333             | 139       | 1333              | 111               | 3247  |
| 3          | 270       | 246         | 305              | 759                 | 1064             | 1210             | 146       | 1211              | 113               | 2710  |
| 4          | 223       | 198         | 285              | 938                 | 1223             | 1225             | 2         | 1225              | 107               | 5592  |
| 5          | 282       | 258         | 329              | 844                 | 1173             | 1248             | 75        | 1248              | 111               | 4613  |
| 6          | 207       | 181         | 246              | 960                 | 1206             | 1396             | 190       | 1396              | 108               | 3039  |
| 7          | 273       | 250         | 310              | 595                 | 905              | 1074             | 169       | 1074              | 113               | 2467  |
| 8          | 207       | 181         | 259              | 869                 | 1128             | 1281             | 153       | 1281              | 124               | 3763  |
