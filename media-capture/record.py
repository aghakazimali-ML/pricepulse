"""Records the live PricePulse site for the Upwork portfolio: screenshots plus a ~45 s tour video."""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = "https://pricepulse-ml.vercel.app"
OUT = sys.argv[1]

async def scroll(pg, total, steps=30, pause=35):
    for _ in range(steps):
        await pg.mouse.wheel(0, total / steps)
        await pg.wait_for_timeout(pause)

async def scrape_preset(pg, name, open_fields=False):
    await pg.goto(f"{BASE}/#/scrape"); await pg.wait_for_timeout(1500)
    await pg.get_by_role("button", name=name).click()
    if open_fields:
        await pg.get_by_text("Custom fields", exact=True).click()
    await pg.wait_for_selector("text=clean records", timeout=60000)
    await pg.wait_for_timeout(1200)

async def shots(b):
    pg = await b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
    await pg.goto(f"{BASE}/#/home"); await pg.wait_for_timeout(4000)
    for name in ["history", "health"]:
        await pg.goto(f"{BASE}/#/{name}"); await pg.wait_for_timeout(3500)
        await pg.screenshot(path=f"{OUT}/demo_{name}.png")
    await scrape_preset(pg, "Books with detail pages (custom fields)", open_fields=True)
    await pg.evaluate("window.scrollTo(0, 0)"); await pg.wait_for_timeout(500)
    await pg.screenshot(path=f"{OUT}/scraper_builder.png")
    await pg.locator("text=Raw scraped data").scroll_into_view_if_needed(); await pg.mouse.wheel(0, -260); await pg.wait_for_timeout(800)
    await pg.screenshot(path=f"{OUT}/scraper_result.png")
    for name in ["home", "products", "insights"]:
        await pg.goto(f"{BASE}/#/{name}"); await pg.wait_for_timeout(3500)
        await pg.screenshot(path=f"{OUT}/live_{name}.png")
    await scrape_preset(pg, "Quotes (CSS selector)")
    await pg.goto(f"{BASE}/#/products"); await pg.wait_for_timeout(3000)
    await pg.screenshot(path=f"{OUT}/live_quotes_products.png")
    await pg.close()

async def video(b):
    ctx = await b.new_context(viewport={"width": 1280, "height": 800}, record_video_dir=OUT, record_video_size={"width": 1280, "height": 800})
    pg = await ctx.new_page()
    await pg.goto(f"{BASE}/#/home"); await pg.wait_for_timeout(3500)
    await scroll(pg, 600); await pg.wait_for_timeout(1200)
    await pg.get_by_role("link", name="Scrape a site").click(); await pg.wait_for_timeout(2000)
    await pg.get_by_text("Custom fields", exact=True).click(); await pg.wait_for_timeout(600)
    await pg.get_by_role("button", name="Books with detail pages (custom fields)").click(); await pg.wait_for_timeout(1500)
    await scroll(pg, 350); await pg.wait_for_timeout(1500)
    await pg.wait_for_selector("text=clean records", timeout=60000); await pg.wait_for_timeout(800)
    await pg.locator("text=Loaded").first.scroll_into_view_if_needed(); await pg.wait_for_timeout(2000)
    await scroll(pg, 500); await pg.wait_for_timeout(2500)
    await pg.get_by_role("link", name="Home").first.click(); await pg.wait_for_timeout(3500)
    await scroll(pg, 600); await pg.wait_for_timeout(1500)
    await pg.get_by_role("link", name="Products").first.click(); await pg.wait_for_timeout(3000)
    await pg.get_by_role("link", name="Insights").first.click(); await pg.wait_for_timeout(3000)
    await scroll(pg, 500); await pg.wait_for_timeout(1500)
    await pg.get_by_role("link", name="Pipeline Health").first.click(); await pg.wait_for_timeout(3000)
    await scroll(pg, 600); await pg.wait_for_timeout(2000)
    path = await pg.video.path()
    await ctx.close()
    print(path)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        await shots(b)
        await video(b)
        await b.close()

asyncio.run(main())
