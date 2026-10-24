from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]); pg = b.new_page(viewport={"width":1440,"height":900})
    msgs = []; pg.on("console", lambda m: msgs.append((m.type, m.text)))
    for q in ["", "?montage=19"]:
        pg.goto("http://localhost:8000/index.html" + q); pg.wait_for_timeout(9000)
        print(q or "default", pg.evaluate("""() => new Promise(res => { const r = window.__eeg.renderer; r.info.autoReset = false; r.info.reset();
          requestAnimationFrame(() => requestAnimationFrame(() => { const i = r.info.render; const o = {calls: i.calls, tris: i.triangles, lines: i.lines, fps: document.getElementById('fps').textContent}; r.info.autoReset = true; res(o); })); })"""))
    print(msgs); b.close()
