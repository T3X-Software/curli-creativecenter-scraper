const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "scraper", ts: new Date().toISOString() });
});

// MVP: por enquanto só abre a página e confirma que carregou
app.post("/scrape/creative-center/top-products", async (req, res) => {
  const url =
    "https://ads.tiktok.com/business/creativecenter/top-products/pc/en";

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Por enquanto retornamos só o título (validação do Playwright no Railway)
    const title = await page.title();

    res.json({
      ok: true,
      title,
      region: "Brazil",
      time_range: "Last 7 days",
      collected_at: new Date().toISOString(),
      data: []
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  } finally {
    await browser.close();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`scraper listening on :${port}`));
