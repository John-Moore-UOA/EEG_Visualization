"""Hostile-ish test server for the front-end (port 8767).
Per connection: sends garbage + odd shapes, then 30 frames of relative-unit data that include
unknown channel names (TP9, Ch1) and a non-numeric value, then goes silent with the socket OPEN
(so the page must show 'Stale', not 'Disconnected')."""
import asyncio
import json
import math
import time

from websockets.asyncio.server import serve


async def handler(ws):
    await ws.send("not json at all")
    await ws.send(json.dumps([1, 2, 3]))
    await ws.send(json.dumps({"type": "bandpower", "bands": {}}))
    for i in range(30):
        t = time.time()
        alpha = {"Fp1": 0.10, "Fp2": 0.12, "O1": 0.40 + 0.1 * math.sin(i / 3), "O2": 0.38,
                 "C3": 0.2, "TP9": 0.25, "Ch1": 0.5, "P4": "bad"}
        msg = {"type": "bandpower", "t": t, "units": "relative",
               "bands": {"alpha": alpha, "beta": {"Fp1": 0.2, "O1": 0.1, "TP9": 0.3}, "mu": {"Fp1": 1}}}
        await ws.send(json.dumps(msg))
        await asyncio.sleep(0.1)
    await asyncio.sleep(3600)


async def main():
    async with serve(handler, "localhost", 8767):
        await asyncio.Future()


asyncio.run(main())
