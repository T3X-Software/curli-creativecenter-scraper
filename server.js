const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "scraper", ts: new Date().toISOString() });
});

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

app.post("/debug/open", async (req, res) => {
  const url = "https://ads.tiktok.com/business/creativecenter/top-products/pc/en";
  let browser;
  const started = Date.now();

  try {
    console.log("[debug/open] launching browser...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    console.log("[debug/open] goto...");
    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });

    const title = await page.title();
    console.log("[debug/open] title:", title);

    res.json({ ok: true, title, ms: Date.now() - started });
  } catch (e) {
    console.error("[debug/open] error:", e);
    res.status(500).json({ ok: false, message: String(e), ms: Date.now() - started });
  } finally {
    if (browser) await browser.close();
  }
});

app.post("/scrape/creative-center/top-products", async (req, res) => {
  const url = "https://ads.tiktok.com/business/creativecenter/top-products/pc/en";
  const region = "Brazil";
  const timeRangeLabel = "Last 7 days";

  let browser;
  const started = Date.now();

  try {
    console.log("[scrape] launching browser...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    console.log("[scrape] goto...");
    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(2000);

    // 1) Selecionar Brazil
    console.log("[scrape] selecting region:", region);
    const countryBtn = page
      .locator("button")
      .filter({ hasText: /Brazil|United States|Canada|Mexico|Japan|France|Germany|Spain|Italy/i })
      .first();

    await countryBtn.click({ timeout: 30000 });

    const brazilOption = page.locator("text=Brazil").first();
    await brazilOption.waitFor({ timeout: 30000 });
    await brazilOption.click();
    await page.waitForTimeout(1500);

    // 2) Selecionar período Last 7 days
    console.log("[scrape] selecting time range:", timeRangeLabel);
    const timeBtn = page
      .locator("button")
      .filter({ hasText: /Last\s+7\s+days|Last\s+30\s+days|Last\s+14\s+days|Today/i })
      .first();

    await timeBtn.click({ timeout: 30000 });

    const opt = page.locator(`text=${timeRangeLabel}`).first();
    await opt.waitFor({ timeout: 30000 });
    await opt.click();
    await page.waitForTimeout(2000);

    // 3) Esperar a tabela
    console.log("[scrape] waiting rows...");
    const rowsLocator = page.locator("tr").filter({ hasText: /Details/i });
    await rowsLocator.first().waitFor({ timeout: 60000 });

    const rowCount = await rowsLocator.count();
    console.log("[scrape] rowCount:", rowCount);

    const data = [];
    for (let i = 0; i < rowCount; i++) {
      const row = rowsLocator.nth(i);
      const cells = row.locator("td");
      const cellCount = await cells.count();
      if (cellCount < 5) continue;

      const productCellText = cleanText(await cells.nth(0).innerText());
      const popularity = cleanText(await cells.nth(1).innerText());
      const popularity_change = cleanText(await cells.nth(2).innerText());
      const ctr = cleanText(await cells.nth(3).innerText());
      const cvr = cleanText(await cells.nth(4).innerText());

      let cpa = "";
      if (cellCount >= 6) cpa = cleanText(await cells.nth(5).innerText());

      data.push({ product: productCellText, popularity, popularity_change, ctr, cvr, cpa });
    }

    console.log("[scrape] done. items:", data.length);

    res.json({
      ok: true,
      region,
      time_range: timeRangeLabel,
      collected_at: new Date().toISOString(),
      source: "creative_center",
      count: data.length,
      ms: Date.now() - started,
      data,
    });
  } catch (e) {
    console.error("[scrape] error:", e);
    res.status(500).json({ ok: false, message: String(e), ms: Date.now() - started });
  } finally {
    if (browser) await browser.close();
  }
});

// Listen robusto (não mexe)
const port = process.env.PORT || 8080;

const server = app.listen(port, "::", () => {
  console.log(`scraper listening on [::]:${port}`);
});

server.on("error", (err) => {
  console.error("Failed to bind on ::, falling back to 0.0.0.0", err);
  app.listen(port, "0.0.0.0", () => console.log(`scraper listening on 0.0.0.0:${port}`));
});
