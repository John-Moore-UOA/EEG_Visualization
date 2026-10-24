"""
bridge.py - EEG (LSL) -> band power -> WebSocket bridge for the Three.js visualiser.

Reads multichannel EEG from a Lab Streaming Layer (LSL) stream, keeps a short
ring buffer per channel, computes Welch-style band power with numpy, and
broadcasts the result as JSON to every connected WebSocket client.

Install
-------
    pip install pylsl websockets numpy

    (pylsl is only needed for real LSL input; --mock runs without it.
     The Windows/macOS pylsl wheels bundle liblsl. On Linux you may need to
     install liblsl separately, e.g. `conda install -c conda-forge liblsl`.)

Usage
-----
    # Synthetic EEG, no hardware or LSL needed (good for testing the front-end)
    python bridge.py --mock

    # Real LSL stream of type "EEG" (the default)
    python bridge.py

    # Pick a stream by name, send relative power, 20 messages per second
    python bridge.py --stream-name "OpenBCI_EEG" --relative --rate 20

    # Legacy flat form: only alpha, as {"Fp1": 0.42, "Fp2": 0.37, ...}
    python bridge.py --mock --flat-band alpha

    # Stream has no channel labels: supply them yourself
    python bridge.py --channels Fp1,Fp2,F3,F4,C3,C4,P3,P4,O1,O2

Message format (default, one JSON object per message, ~10 Hz)
------------------------------------------------------------
    {
      "type": "bandpower",
      "t": 1729750000.123,          # Unix time (seconds) when computed
      "units": "uV^2",              # or "relative" with --relative
      "bands": {
        "delta": {"Fp1": 1.2, "Fp2": 1.1, ...},
        "theta": {...},
        "alpha": {...},
        "beta":  {...},
        "gamma": {...}
      }
    }

    Band edges (Hz): delta 1-4, theta 4-8, alpha 8-13, beta 13-30, gamma 30-45.
    Each band covers lower <= f < upper (gamma includes 45 Hz), so bands do not
    double-count the shared edge frequencies.

    Absolute values are band power = sum of PSD bins in the band * bin width,
    i.e. the integral of the PSD, in (input units)^2. LSL EEG is normally in
    microvolts, hence "uV^2". With --relative each value is
    band power / total power in 1-45 Hz, so the five bands sum to ~1.

Legacy flat format (--flat-band BAND)
-------------------------------------
    {"Fp1": 0.42, "Fp2": 0.37, ...}       # just that one band, no wrapper

Stop with Ctrl+C.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import math
import random
import sys
import threading
import time
from typing import Optional

import numpy as np


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_CHANNELS = ["Fp1", "Fp2", "F3", "F4", "C3", "C4", "P3", "P4", "O1", "O2"]

# Ordered list of (band name, low Hz, high Hz).
BANDS = [
    ("delta", 1.0, 4.0),
    ("theta", 4.0, 8.0),
    ("alpha", 8.0, 13.0),
    ("beta", 13.0, 30.0),
    ("gamma", 30.0, 45.0),
]

TOTAL_LOW_HZ = 1.0
TOTAL_HIGH_HZ = 45.0

MOCK_SAMPLE_RATE = 256.0


# ---------------------------------------------------------------------------
# Ring buffer (one deque per channel, protected by a lock)
# ---------------------------------------------------------------------------

class RingBuffer:
    """Holds the most recent `max_samples` samples for each channel.

    The reader thread calls `append_chunk`; the async broadcaster calls
    `snapshot`. A lock keeps the two from stepping on each other.
    """

    def __init__(self, channel_count: int, max_samples: int) -> None:
        self.channel_count = channel_count
        self.max_samples = max_samples
        self.lock = threading.Lock()
        self.channels: list[collections.deque] = []
        for _ in range(channel_count):
            self.channels.append(collections.deque(maxlen=max_samples))

    def append_chunk(self, samples: list) -> None:
        """Append a chunk of samples. `samples` is a list of rows, one row per
        time point, each row having one value per channel (LSL layout)."""
        with self.lock:
            for row in samples:
                for channel_index in range(self.channel_count):
                    self.channels[channel_index].append(row[channel_index])

    def sample_count(self) -> int:
        with self.lock:
            if self.channel_count == 0:
                return 0
            return len(self.channels[0])

    def snapshot(self) -> np.ndarray:
        """Return a copy of the buffer as an array of shape (channels, samples)."""
        with self.lock:
            rows = []
            for channel_deque in self.channels:
                rows.append(list(channel_deque))
        return np.array(rows, dtype=np.float64)


# ---------------------------------------------------------------------------
# Band power (Welch PSD with numpy only)
# ---------------------------------------------------------------------------

def welch_psd(signal: np.ndarray, sample_rate: float, segment_length: int) -> tuple[np.ndarray, np.ndarray]:
    """One-sided power spectral density of a 1-D signal using Welch's method.

    - Hann window, 50% overlap, each segment has its mean removed.
    - Scaled as a density (units^2 / Hz), like scipy.signal.welch(scaling="density").

    Returns (frequencies, psd).
    """
    sample_total = len(signal)
    if segment_length > sample_total:
        segment_length = sample_total

    window = np.hanning(segment_length)
    # Normalisation so that the PSD integrates to the signal variance.
    window_power = 0.0
    for w in window:
        window_power += w * w
    scale = 1.0 / (sample_rate * window_power)

    step = segment_length // 2
    if step < 1:
        step = 1

    psd_sum = np.zeros(segment_length // 2 + 1)
    segment_count = 0
    start = 0
    while start + segment_length <= sample_total:
        segment = signal[start:start + segment_length]
        segment = segment - np.mean(segment)
        spectrum = np.fft.rfft(segment * window)
        power = (np.abs(spectrum) ** 2) * scale
        psd_sum += power
        segment_count += 1
        start += step

    psd = psd_sum / max(segment_count, 1)

    # One-sided spectrum: double every bin except DC (and Nyquist if present).
    if segment_length % 2 == 0:
        last_doubled = len(psd) - 1      # Nyquist bin is not doubled
    else:
        last_doubled = len(psd)
    for bin_index in range(1, last_doubled):
        psd[bin_index] *= 2.0

    frequencies = np.fft.rfftfreq(segment_length, d=1.0 / sample_rate)
    return frequencies, psd


def power_in_range(frequencies: np.ndarray, psd: np.ndarray, low_hz: float,
                   high_hz: float, include_high: bool) -> float:
    """Integrate the PSD over low_hz <= f < high_hz (or <= high_hz if
    include_high). Returns power in units^2."""
    if len(frequencies) < 2:
        return 0.0
    bin_width = frequencies[1] - frequencies[0]
    total = 0.0
    for bin_index in range(len(frequencies)):
        f = frequencies[bin_index]
        if f < low_hz:
            continue
        if include_high:
            if f > high_hz:
                continue
        else:
            if f >= high_hz:
                continue
        total += psd[bin_index]
    return float(total * bin_width)


def compute_band_powers(data: np.ndarray, channel_names: list[str], sample_rate: float,
                        relative: bool) -> dict[str, dict[str, float]]:
    """Compute band power for every channel and band.

    `data` has shape (channels, samples). Returns {band: {channel: value}}.
    """
    # 1-second segments give 1 Hz resolution; with a 2 s window that is
    # 3 half-overlapping segments to average.
    segment_length = int(round(sample_rate))

    result: dict[str, dict[str, float]] = {}
    for band_name, _, _ in BANDS:
        result[band_name] = {}

    for channel_index in range(len(channel_names)):
        channel_name = channel_names[channel_index]
        frequencies, psd = welch_psd(data[channel_index], sample_rate, segment_length)

        total_power = power_in_range(frequencies, psd, TOTAL_LOW_HZ, TOTAL_HIGH_HZ, include_high=True)

        for band_index in range(len(BANDS)):
            band_name, low_hz, high_hz = BANDS[band_index]
            is_last_band = band_index == len(BANDS) - 1
            band_power = power_in_range(frequencies, psd, low_hz, high_hz, include_high=is_last_band)

            if relative:
                if total_power > 0.0:
                    value = band_power / total_power
                else:
                    value = 0.0
            else:
                value = band_power

            result[band_name][channel_name] = tidy_number(value)

    return result


def tidy_number(value: float) -> float:
    """Round to 6 significant digits to keep JSON small; guard against NaN/inf
    (which are not valid JSON)."""
    if math.isnan(value) or math.isinf(value):
        return 0.0
    if value == 0.0:
        return 0.0
    digits = 6 - int(math.floor(math.log10(abs(value)))) - 1
    return round(value, digits)


# ---------------------------------------------------------------------------
# Input sources (each runs in its own thread and fills the RingBuffer)
# ---------------------------------------------------------------------------

def resolve_lsl_stream(stream_type: str, stream_name: Optional[str], timeout: float):
    """Find an LSL stream by name (if given) or type. Returns a StreamInfo."""
    try:
        import pylsl
    except Exception as error:  # ImportError or a liblsl loading error
        print("ERROR: could not import pylsl (" + str(error) + ").", file=sys.stderr)
        print("Install it with:  pip install pylsl", file=sys.stderr)
        print("Or run without hardware:  python bridge.py --mock", file=sys.stderr)
        sys.exit(1)

    if stream_name:
        prop, value = "name", stream_name
    else:
        prop, value = "type", stream_type

    print("Looking for an LSL stream with " + prop + "='" + value + "' (timeout " + str(timeout) + " s)...")
    streams = pylsl.resolve_byprop(prop, value, 1, timeout)
    if len(streams) == 0:
        print("ERROR: no LSL stream with " + prop + "='" + value + "' found within " + str(timeout) + " s.",
              file=sys.stderr)
        print("  - Is the EEG software (OpenBCI GUI, Muse app, BrainFlow, etc.) streaming to LSL?", file=sys.stderr)
        print("  - Check the stream's name/type, e.g. with --stream-name or --stream-type.", file=sys.stderr)
        print("  - Firewalls can block LSL multicast; try on the same machine first.", file=sys.stderr)
        print("  - To test without hardware:  python bridge.py --mock", file=sys.stderr)
        sys.exit(1)
    return streams[0]


def read_channel_labels(info) -> list[str]:
    """Read channel labels from <desc><channels><channel><label> in the
    stream metadata. Returns an empty list if they are missing."""
    labels: list[str] = []
    channels_node = info.desc().child("channels")
    if channels_node.empty():
        return labels
    channel_node = channels_node.child("channel")
    while not channel_node.empty():
        label = channel_node.child_value("label")
        labels.append(label)
        channel_node = channel_node.next_sibling("channel")
    return labels


def choose_channel_names(stream_labels: list[str], fallback: list[str], channel_count: int) -> list[str]:
    """Prefer stream labels; else --channels / default list; else Ch1..ChN."""
    labels_ok = len(stream_labels) == channel_count
    for label in stream_labels:
        if label.strip() == "":
            labels_ok = False
    if labels_ok:
        return stream_labels

    if len(stream_labels) > 0:
        print("WARNING: stream has " + str(len(stream_labels)) + " usable-looking labels for "
              + str(channel_count) + " channels; ignoring them.")

    if len(fallback) == channel_count:
        print("Using channel names from --channels: " + ", ".join(fallback))
        return fallback

    if len(fallback) > channel_count:
        print("WARNING: --channels has more names than the stream has channels; using the first "
              + str(channel_count) + ".")
        return fallback[:channel_count]

    names = list(fallback)
    for index in range(len(fallback), channel_count):
        names.append("Ch" + str(index + 1))
    print("WARNING: not enough channel names; using: " + ", ".join(names))
    return names


def lsl_reader_thread(inlet, buffer: RingBuffer, stop_event: threading.Event) -> None:
    """Pull chunks from the LSL inlet into the ring buffer until stopped."""
    while not stop_event.is_set():
        try:
            samples, _timestamps = inlet.pull_chunk(timeout=0.2, max_samples=1024)
        except Exception as error:
            print("LSL read error: " + str(error), file=sys.stderr)
            time.sleep(0.5)
            continue
        if samples:
            buffer.append_chunk(samples)


class MockEEG:
    """Synthetic EEG: for every channel, one sinusoid per band whose amplitude
    drifts slowly, plus Gaussian noise. Alpha is stronger at the back of the
    head (P/O), beta at C, theta at F, so the visualiser has something to show."""

    def __init__(self, channel_names: list[str], sample_rate: float) -> None:
        self.channel_names = channel_names
        self.sample_rate = sample_rate
        self.rng = random.Random(1234)
        # Per channel, per band: [frequency_hz, base_amplitude_uV, drift_hz, drift_phase, signal_phase]
        self.components: list[list[list[float]]] = []
        band_centres = {"delta": 2.5, "theta": 6.0, "alpha": 10.0, "beta": 20.0, "gamma": 38.0}
        base_amplitudes = {"delta": 20.0, "theta": 10.0, "alpha": 10.0, "beta": 4.0, "gamma": 1.5}
        for name in channel_names:
            channel_components = []
            for band_name, _, _ in BANDS:
                amplitude = base_amplitudes[band_name]
                if band_name == "alpha" and (name.startswith("O") or name.startswith("P")):
                    amplitude *= 2.5
                if band_name == "beta" and name.startswith("C"):
                    amplitude *= 2.0
                if band_name == "theta" and name.startswith("F"):
                    amplitude *= 1.8
                frequency = band_centres[band_name] + self.rng.uniform(-0.5, 0.5)
                drift_hz = self.rng.uniform(0.03, 0.15)
                drift_phase = self.rng.uniform(0.0, 2.0 * math.pi)
                signal_phase = self.rng.uniform(0.0, 2.0 * math.pi)
                channel_components.append([frequency, amplitude, drift_hz, drift_phase, signal_phase])
            self.components.append(channel_components)
        self.noise_uV = 2.0
        self.np_rng = np.random.default_rng(5678)

    def generate(self, start_sample: int, sample_count: int) -> list:
        """Return `sample_count` rows (time points) x channels, LSL layout."""
        times = (start_sample + np.arange(sample_count)) / self.sample_rate
        columns = []
        for channel_index in range(len(self.channel_names)):
            channel_signal = np.zeros(sample_count)
            for component in self.components[channel_index]:
                frequency, amplitude, drift_hz, drift_phase, signal_phase = component
                # Amplitude slowly drifts between 0.3x and 1.7x the base.
                envelope = amplitude * (1.0 + 0.7 * np.sin(2.0 * math.pi * drift_hz * times + drift_phase))
                channel_signal += envelope * np.sin(2.0 * math.pi * frequency * times + signal_phase)
            channel_signal += self.np_rng.normal(0.0, self.noise_uV, sample_count)
            columns.append(channel_signal)
        # Transpose (channels, samples) -> list of rows (samples, channels).
        return np.array(columns).T.tolist()


def mock_reader_thread(mock: MockEEG, buffer: RingBuffer, stop_event: threading.Event) -> None:
    """Produce mock samples in real time (small chunks, like a real amp)."""
    start_time = time.monotonic()
    samples_sent = 0
    while not stop_event.is_set():
        elapsed = time.monotonic() - start_time
        samples_due = int(elapsed * mock.sample_rate)
        if samples_due > samples_sent:
            chunk = mock.generate(samples_sent, samples_due - samples_sent)
            buffer.append_chunk(chunk)
            samples_sent = samples_due
        time.sleep(1.0 / 32.0)


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------

def import_websockets_server():
    """Return (serve, broadcast, api_name). Prefers the modern asyncio API
    (websockets >= 13); falls back to the legacy API on older versions."""
    try:
        from websockets.asyncio.server import serve, broadcast
        return serve, broadcast, "websockets.asyncio (modern)"
    except ImportError:
        pass
    try:
        import websockets
        return websockets.serve, websockets.broadcast, "websockets legacy"
    except (ImportError, AttributeError):
        print("ERROR: the 'websockets' package (>= 10) is required:  pip install websockets", file=sys.stderr)
        sys.exit(1)


def build_message(bands: dict[str, dict[str, float]], relative: bool, flat_band: Optional[str]) -> str:
    if flat_band:
        return json.dumps(bands[flat_band])
    message = {
        "type": "bandpower",
        "t": round(time.time(), 3),
        "units": "relative" if relative else "uV^2",
        "bands": bands,
    }
    return json.dumps(message)


async def run_server(args, buffer: RingBuffer, channel_names: list[str], sample_rate: float) -> None:
    serve, broadcast, api_name = import_websockets_server()
    clients: set = set()

    async def handle_client(connection, path=None) -> None:
        # `path` is only passed by very old websockets versions.
        clients.add(connection)
        print("Client connected (" + str(len(clients)) + " total): " + str(connection.remote_address))
        try:
            # We do not expect incoming messages; just drain them until close.
            async for _message in connection:
                pass
        except Exception:
            pass  # abrupt disconnects are fine
        finally:
            clients.discard(connection)
            print("Client disconnected (" + str(len(clients)) + " left)")

    period = 1.0 / args.rate
    min_samples = int(round(sample_rate))  # need at least one 1 s segment

    async with serve(handle_client, args.host, args.port):
        print("Serving on ws://" + args.host + ":" + str(args.port) + " using " + api_name)
        if args.flat_band:
            print("Sending legacy flat form for band '" + args.flat_band + "' at " + str(args.rate) + " Hz")
        else:
            print("Sending bandpower messages at " + str(args.rate) + " Hz"
                  + (" (relative)" if args.relative else ""))

        next_tick = asyncio.get_running_loop().time()
        waiting_logged = False
        while True:
            next_tick += period
            if buffer.sample_count() >= min_samples:
                data = buffer.snapshot()
                bands = compute_band_powers(data, channel_names, sample_rate, args.relative)
                message = build_message(bands, args.relative, args.flat_band)
                if clients:
                    # broadcast() never raises for a dead client; it skips it.
                    broadcast(set(clients), message)
            elif not waiting_logged:
                print("Waiting for data to fill the buffer...")
                waiting_logged = True

            delay = next_tick - asyncio.get_running_loop().time()
            if delay < 0:
                # We fell behind (e.g. machine was asleep); resynchronise.
                next_tick = asyncio.get_running_loop().time()
                delay = 0
            await asyncio.sleep(delay)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    band_names = []
    for band_name, _, _ in BANDS:
        band_names.append(band_name)

    parser = argparse.ArgumentParser(description="LSL EEG -> band power -> WebSocket bridge")
    parser.add_argument("--host", default="localhost", help="WebSocket host (default: localhost)")
    parser.add_argument("--port", type=int, default=8765, help="WebSocket port (default: 8765)")
    parser.add_argument("--rate", type=float, default=10.0, help="messages per second (default: 10)")
    parser.add_argument("--window", type=float, default=2.0, help="analysis window in seconds (default: 2)")
    parser.add_argument("--stream-type", default="EEG", help="LSL stream type to look for (default: EEG)")
    parser.add_argument("--stream-name", default=None, help="LSL stream name (overrides --stream-type)")
    parser.add_argument("--timeout", type=float, default=10.0, help="seconds to wait for the LSL stream")
    parser.add_argument("--channels", default=",".join(DEFAULT_CHANNELS),
                        help="comma-separated channel names, used if the stream has no labels "
                             "(and as the mock channel set)")
    parser.add_argument("--relative", action="store_true",
                        help="send relative power (band / total 1-45 Hz) instead of absolute")
    parser.add_argument("--flat-band", choices=band_names, default=None,
                        help="send only this band as a flat {channel: value} object (legacy form)")
    parser.add_argument("--mock", action="store_true", help="use synthetic EEG instead of LSL")
    args = parser.parse_args()

    if args.rate <= 0:
        parser.error("--rate must be > 0")
    if args.window < 1.0:
        parser.error("--window must be at least 1 second (1 s Welch segments are used)")
    return args


def parse_channel_list(text: str) -> list[str]:
    names = []
    for part in text.split(","):
        part = part.strip()
        if part:
            names.append(part)
    return names


def main() -> None:
    args = parse_args()
    fallback_channels = parse_channel_list(args.channels)
    stop_event = threading.Event()

    if args.mock:
        sample_rate = MOCK_SAMPLE_RATE
        channel_names = fallback_channels
        print("MOCK mode: " + str(len(channel_names)) + " synthetic channels at "
              + str(sample_rate) + " Hz: " + ", ".join(channel_names))
        buffer = RingBuffer(len(channel_names), int(round(args.window * sample_rate)))
        mock = MockEEG(channel_names, sample_rate)
        reader = threading.Thread(target=mock_reader_thread, args=(mock, buffer, stop_event),
                                  name="mock-reader", daemon=True)
    else:
        info = resolve_lsl_stream(args.stream_type, args.stream_name, args.timeout)
        import pylsl  # safe: resolve_lsl_stream already checked the import
        inlet = pylsl.StreamInlet(info, max_buflen=int(math.ceil(args.window)) + 5)
        # The inlet's info has the full metadata (desc), the resolved one may not.
        full_info = inlet.info(timeout=args.timeout)
        sample_rate = full_info.nominal_srate()
        if sample_rate <= 0:
            print("ERROR: stream has an irregular sampling rate; band power needs a fixed rate.",
                  file=sys.stderr)
            sys.exit(1)
        channel_count = full_info.channel_count()
        labels = read_channel_labels(full_info)
        channel_names = choose_channel_names(labels, fallback_channels, channel_count)
        print("Connected to LSL stream '" + full_info.name() + "' (type " + full_info.type() + "), "
              + str(channel_count) + " channels at " + str(sample_rate) + " Hz: " + ", ".join(channel_names))
        buffer = RingBuffer(channel_count, int(round(args.window * sample_rate)))
        reader = threading.Thread(target=lsl_reader_thread, args=(inlet, buffer, stop_event),
                                  name="lsl-reader", daemon=True)

    reader.start()
    try:
        asyncio.run(run_server(args, buffer, channel_names, sample_rate))
    except KeyboardInterrupt:
        print("\nShutting down...")
    except OSError as error:
        print("ERROR: could not start WebSocket server on " + args.host + ":" + str(args.port)
              + " (" + str(error) + "). Is another bridge already running?", file=sys.stderr)
    finally:
        stop_event.set()
        reader.join(timeout=2.0)


if __name__ == "__main__":
    main()
