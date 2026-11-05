-- Foundry Ascent — a runtime switch for the vEIR's stock vendor voice (the ElevenLabs "AI voice",
-- docs/runbooks/elevenlabs-voice.md). Applied on top of 0001–0024 (there is no 0014); expand-only and re-runnable.
--
-- `vendor_voice_enabled` (on): while it is on, every validated unit a cloned voice does not take is said by the
-- deployment's stock vendor voice where one is configured (`media.voice.provider: "elevenlabs-stock"`); off, those
-- units are said by Amazon Polly from the next unit on, with no deploy. The AI and calls kill switches still stop
-- all speech; this one changes only who says it. A deployment with no vendor voice configured ignores it.

INSERT INTO platform_settings (key, value) VALUES ('vendor_voice_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
