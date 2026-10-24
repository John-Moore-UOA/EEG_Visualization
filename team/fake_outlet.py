"""Fake LSL EEG outlet: 10 labelled channels at 256 Hz, 10 Hz alpha on O1/O2."""
import math, time, random
import pylsl
names = ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2"]
info = pylsl.StreamInfo("FakeEEG", "EEG", len(names), 256, "float32", "fake-eeg-123")
chs = info.desc().append_child("channels")
for n in names:
    c = chs.append_child("channel"); c.append_child_value("label", n); c.append_child_value("unit", "microvolts"); c.append_child_value("type", "EEG")
outlet = pylsl.StreamOutlet(info, 32)
print("outlet up", flush=True)
t0 = time.monotonic(); sent = 0
while True:
    due = int((time.monotonic() - t0) * 256)
    chunk = []
    for k in range(sent, due):
        t = k / 256
        row = []
        for n in names:
            amp = 30.0 if n.startswith("O") else 3.0
            row.append(amp * math.sin(2*math.pi*10*t) + 5*math.sin(2*math.pi*2*t) + random.gauss(0, 1))
        chunk.append(row)
    if chunk: outlet.push_chunk(chunk)
    sent = due
    time.sleep(0.02)
