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

/**
 * Helpers (NOVO)
 */
async function dismissOverlays(page) {
  // Fecha banners comuns (cookies/consent). Não quebra se não existir.
  const candidates = [
    page.getByRole("button", { name: /accept|agree|allow all|ok/i }),
    page.getByRole("button", { name: /aceitar|concordo|permitir|ok/i }),
    page.locator("button:has-text('Accept')"),
    page.locator("button:has-text('Agree')"),
    page.locator("button:has-text('Allow all')"),
    page.locator("button:has-text('Aceitar')"),
    page.locator("button:has-text('Concordo')"),
  ];

  for (const c of candidates) {
    try {
      if (await c.first().isVisible({ timeout: 1500 })) {
        await c.first().click({ timeout: 5000 });
        await page.waitForTimeout(400);
      }
    } catch {
      // ignore
    }
  }
}

async function selectRegion(page, regionName = "Brazil") {
  // 1) Abrir o dropdown/combobox de região
  const openDropdownCandidates = [
    // Botões/controles com label explícito
    page.getByRole("button", { name: /region/i }),
    page.locator("button:has-text('Region')"),
    page.getByRole("button", { name: /country|location/i }),
    page.locator("button:has-text('Country')"),
    page.locator("button:has-text('Location')"),

    // Heurística: achar um bloco com texto Region e clicar no botão dentro
    page.locator("div:has-text('Region') button").first(),
    page.locator("div:has-text('Country') button").first(),

    // Heurística: às vezes é um combobox
    page.locator('[role="combobox"]').first(),
  ];

  let opened = false;
  for (const cand of openDropdownCandidates) {
    try {
      if (await cand.first().isVisible({ timeout: 2500 })) {
        await cand.first().click({ timeout: 15000 });
        opened = true;
        break;
      }
    } catch {
      // ignore
    }
  }

  if (!opened) {
    throw new Error("Não encontrei o controle de filtro de Region/Country na página.");
  }

  // 2) Clicar na opção Brazil (pode vir em portal)
  const optionCandidates = [
    page.getByRole("option", { name: new RegExp(`^${regionName}$`, "i") }),
    page.locator(`[role="option"]:has-text("${regionName}")`).first(),
    page.locator(`li:has-text("${regionName}")`).first(),
    page.locator(`text=${regionName}`).first(),
  ];

  for (const opt of optionCandidates) {
    try {
      if (await opt.first().isVisible({ timeout: 6000 })) {
        await opt.first().click({ timeout: 15000 });
        await page.waitForTimeout(1200);
        return;
      }
    } catch {
      // ignore
    }
  }

  throw new Error(`Abri o dropdown, mas não encontrei a opção "${regionName}".`);
}

async function selectTimeRange(page, timeRangeLabel = "Last 7 days") {
  // Abre dropdown do período
  const timeBtnCandidates = [
    page.getByRole("button", { name: /last\s+7\s+days|last\s+14\s+days|last\s+30\s+days|today/i }),
    page.locator("button").filter({ hasText: /Last\s+7\s+days|Last\s+30\s+days|Last\s+14\s+days|Today/i }).first(),
    page.locator("div:has-text('Time Range') button").first(),
    page.locator("div:has-text('Date') button").first(),
  ];

  let opened = false;
  for (const cand of timeBtnCandidates) {
    try {
      if (await cand.first().isVisible({ timeout: 2500 })) {
        await cand.first().click({ timeout: 15000 });
        opened = true;
        break;
      }
    } catch {}
  }

  if (!opened) {
    throw new Error("Não encontrei o controle de filtro de período (time range).");
  }

  // Seleciona opção do período
  const optCandidates = [
    page.getByRole("option", { name: new RegExp(`^${timeRangeLabel}$`, "i") }),
    page.locator(`[role="option"]:has-text("${timeRangeLabel}")`).first(),
    page.locator(`li:has-text("${timeRangeLabel}")`).first(),
    page.locator(`text=${timeRangeLabel}`).first(),
  ];

  for (const opt of optCandidates) {
    try {
      if (await opt.first().isVisible({ timeout: 6000 })) {
        await opt.first().click({ timeout: 15000 });
        await page.waitForTimeout(1200);
        return;
      }
    } catch {}
  }

  throw new Error(`Abri o dropdown de período, mas não encontrei "${timeRangeLabel}".`);
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

    await dismissOverlays(page);

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

app.post("/debug/controls", async (req, res) => {
  const url = "https://ads.tiktok.com/business/creativecenter/top-products/pc/en";
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(1500);

    // Coleta textos dos botões visíveis (pra descobrirmos como a UI está nomeando)
    const buttonTexts = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
      };

      return btns
        .filter(visible)
        .map((b) => (b.innerText || "").replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 0)
        .slice(0, 120); // limita pra não explodir
    });

    res.json({ ok: true, buttons_sample: buttonTexts });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
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
    await page.waitForTimeout(1500);

    // NOVO: fecha overlays (cookies etc.)
    await dismissOverlays(page);

    // 1) Selecionar Brazil (NOVO: mais robusto)
    console.log("[scrape] selecting region:", region);
    await selectRegion(page, region);

    // 2) Selecionar período Last 7 days (NOVO: mais robusto)
    console.log("[scrape] selecting time range:", timeRangeLabel);
    await selectTimeRange(page, timeRangeLabel);

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

