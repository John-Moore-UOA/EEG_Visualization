"""Connect to the bridge, receive N messages, check rate + schema."""
import asyncio, json, sys, time
from websockets.asyncio.client import connect

EXPECTED = ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2"]
BANDS = ["delta","theta","alpha","beta","gamma"]

async def main(url, n, mode):
    async with connect(url) as ws:
        arrivals, msgs = [], []
        for i in range(n):
            raw = await asyncio.wait_for(ws.recv(), timeout=5)
            arrivals.append(time.monotonic()); msgs.append(json.loads(raw))
    span = arrivals[-1] - arrivals[0]
    rate = (n - 1) / span
    print(f"received {n} msgs, rate = {rate:.2f} Hz")
    errors = 0
    for m in msgs:
        if mode == "flat":
            flat = m
        else:
            assert m["type"] == "bandpower" and isinstance(m["t"], float) and m["units"] in ("uV^2", "relative"), m
            assert list(m["bands"].keys()) == BANDS
            for b in BANDS:
                assert list(m["bands"][b].keys()) == EXPECTED, m["bands"][b].keys()
            flat = m["bands"]["alpha"]
        assert list(flat.keys()) == EXPECTED, flat.keys()
        for v in flat.values():
            if not isinstance(v, (int, float)) or v < 0: errors += 1
    print("schema OK, bad values:", errors)
    print("sample:", json.dumps(msgs[-1])[:600])
    if mode != "flat":
        a1 = msgs[0]["bands"]["alpha"]["O1"]; a2 = msgs[-1]["bands"]["alpha"]["O1"]
        print("alpha O1 first/last:", a1, a2, " alpha Fp1 last:", msgs[-1]["bands"]["alpha"]["Fp1"])
        if msgs[-1]["units"] == "relative":
            s = sum(msgs[-1]["bands"][b]["O1"] for b in BANDS); print("relative sum O1:", s)
    assert 8.5 < rate < 11.5, rate

asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8765",
                 int(sys.argv[2]) if len(sys.argv) > 2 else 20,
                 sys.argv[3] if len(sys.argv) > 3 else "full"))
