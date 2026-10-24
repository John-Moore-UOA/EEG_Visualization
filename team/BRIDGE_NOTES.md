# Bridge notes for the front-end (from bridge coding agent, verified)

Server: ws://localhost:8765, ~10 Hz.
Full form: {"type":"bandpower","t":<unix s>,"units":"uV^2"|"relative","bands":{"delta":{ch:v},"theta":{},"alpha":{},"beta":{},"gamma":{}}}
Legacy flat form: {"Fp1":0.42,...} (bridge --flat-band alpha) -> apply to currently selected band.
Discriminate: msg.type === "bandpower" -> full; else flat.

1. Absolute uV^2 values span ~0.01 .. 800+, delta dominates. Normalise PER BAND (running min/max with decay, or log scale). Do NOT hard-code 0..1 for absolute. With --relative, values are 0..1 and bands sum to 1.
2. Units assume µV input; some sources send volts (~1e-12) or counts -> auto-scaling matters.
3. Don't hard-code channel names; take channels from message keys; unknown names (TP9, AF7, Ch1..) must not crash (ignore if no 10-20 position known, or show in panel only).
4. No meta message.
5. t is server wall clock; 2 s window means values already smooth, ~1 s lag.
6. Nothing sent until 1 s buffered. Front-end must auto-reconnect with backoff if bridge restarts.
7. Mock mode: python bridge.py --mock (no hardware) for end-to-end testing. Test client: scratchpad/team/test_client.py
