from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=d3d11"]); pg = b.new_page()
    pg.goto("http://localhost:8000/index.html"); pg.wait_for_timeout(1500)
    order = []
    for i in range(16):
        pg.keyboard.press("Tab")
        order.append(pg.evaluate("() => { const a = document.activeElement; return a.id || a.dataset.view || a.dataset.name || a.tagName + ':' + (a.textContent||'').trim().slice(0,12) }"))
    print(order); b.close()
