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
 * ===== Helpers NOVOS =====
 */
async function dismissOverlays(root) {
  // root pode ser page ou frame (ambos têm getByRole/locator)
  const candidates = [
    root.getByRole("button", { name: /accept|agree|allow all|ok/i }),
    root.getByRole("button", { name: /aceitar|concordo|permitir|ok/i }),
    root.locator("button:has-text('Accept')"),
    root.locator("button:has-text('Agree')"),
    root.locator("button:has-text('Allow all')"),
    root.locator("button:has-text('Aceitar')"),
    root.locator("button:has-text('Concordo')"),
  ];

  for (const c of candidates) {
    try {
      if (await c.first().isVisible({ timeout: 1500 })) {
        await c.first().click({ timeout: 5000 });
        await root.waitForTimeout?.(400);
      }
    } catch {}
  }
}

function pickBestFrame(page) {
  // Heurística: pega o frame com URL mais “real” e ligado ao domínio do TikTok/Creative Center
  const frames = page.frames();
  const scored = frames.map((f) => {
    const url = f.url() || "";
    let score = 0;
    if (url.includes("ads.tiktok.com")) score += 5;
    if (url.includes("creativecenter")) score += 5;
    if (url.startsWith("about:blank")) score -= 5;
    return { frame: f, url, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.frame || page.mainFrame();
}

async function listButtonsInFrame(frame) {
  // Lista textos de botões visíveis dentro do frame
  return await frame.evaluate(() => {
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
      .slice(0, 150);
  });
}

async function openFiltersPanel(root) {
  const candidates = [
    root.getByRole("button", { name: /filter/i }),
    root.locator("button:has-text('Filter')"),
    root.locator("button[aria-label*='filter' i]"),
    root.locator("[aria-label*='filter' i]"),
  ];

  for (const c of candidates) {
    try {
      if (await c.first().isVisible({ timeout: 2000 })) {
        await c.first().click({ timeout: 15000 });
        await root.waitForTimeout?.(800);
        return true;
      }
    } catch {}
  }
  return false;
}

async function selectRegion(root, regionName = "Brazil") {
  // 1) tenta abrir painel de filtros (se existir)
  await openFiltersPanel(root);

  // 2) tenta achar um combobox / input para país
  const regionFieldCandidates = [
    root.getByRole("combobox").first(),
    root.locator('input[placeholder*="Region" i]').first(),
    root.locator('input[placeholder*="Country" i]').first(),
    root.locator('input[placeholder*="Search" i]').first(),
    root.locator('input[type="text"]').first(),
  ];

  let field = null;
  for (const cand of regionFieldCandidates) {
    try {
      if (await cand.isVisible({ timeout: 2500 })) {
        field = cand;
        break;
      }
    } catch {}
  }

  if (!field) {
    throw new Error("Não encontrei campo (combobox/input) para escolher país/região (provável UI em iframe/portal diferente).");
  }

  await field.click({ timeout: 15000 });
  await field.fill(regionName, { timeout: 15000 });
  await root.waitForTimeout?.(600);

  // 3) escolher a opção
  const optCandidates = [
    root.getByRole("option", { name: new RegExp(`^${regionName}$`, "i") }),
    root.locator(`[role="option"]:has-text("${regionName}")`).first(),
    root.locator(`li:has-text("${regionName}")`).first(),
    root.locator(`text=${regionName}`).first(),
  ];

  for (const opt of optCandidates) {
    try {
      if (await opt.first().isVisible({ timeout: 6000 })) {
        await opt.first().click({ timeout: 15000 });
        await root.waitForTimeout?.(800);
        break;
      }
    } catch {}
  }

  // 4) se tiver Apply/Confirm
  const applyCandidates = [
    root.getByRole("button", { name: /apply|confirm|ok|done/i }),
    root.locator("button:has-text('Apply')"),
    root.locator("button:has-text('Confirm')"),
    root.locator("button:has-text('Done')"),
  ];

  for (const a of applyCandidates) {
    try {
      if (await a.first().isVisible({ timeout: 1500 })) {
        await a.first().click({ timeout: 8000 });
        await root.waitForTimeout?.(800);
        break;
      }
    } catch {}
  }
}

async function selectTimeRange(root, timeRangeLabel = "Last 7 days") {
  const timeBtnCandidates = [
    root.getByRole("button", { name: /last\s+7\s+days|last\s+14\s+days|last\s+30\s+days|today/i }),
    root.locator("button").filter({ hasText: /Last\s+7\s+days|Last\s+30\s+days|Last\s+14\s+days|Today/i }).first(),
    root.locator("div:has-text('Time Range') button").first(),
    root.locator("div:has-text('Date') button").first(),
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
    // não mata aqui; às vezes o default já é Last 7 days
    console.log("[scrape] time-range control not found; continuing with default UI state");
    return;
  }

  const optCandidates = [
    root.getByRole("option", { name: new RegExp(`^${timeRangeLabel}$`, "i") }),
    root.locator(`[role="option"]:has-text("${timeRangeLabel}")`).first(),
    root.locator(`li:has-text("${timeRangeLabel}")`).first(),
    root.locator(`text=${timeRangeLabel}`).first(),
  ];

  for (const opt of optCandidates) {
    try {
      if (await opt.first().isVisible({ timeout: 6000 })) {
        await opt.first().click({ timeout: 15000 });
        await root.waitForTimeout?.(800);
        return;
      }
    } catch {}
  }

  console.log(`[scrape] time-range option "${timeRangeLabel}" not found; continuing`);
}

/**
 * ===== Debug endpoints =====
 */

app.post("/debug/open", async (req, res) => {
  const url = "https://ads.tiktok.com/business/creativecenter/top-products/pc/en";
  let browser;
  const started = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(1500);

    const title = await page.title();
    res.json({ ok: true, title, ms: Date.now() - started });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e), ms: Date.now() - started });
  } finally {
    if (browser) await browser.close();
  }
});

// NOVO: debug por frame (pra você me colar e eu acertar o seletor definitivo)
app.post("/debug/frames", async (req, res) => {
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

    const frames = page.frames();
    const out = [];

    for (const f of frames) {
      const url = f.url();
      let buttons = [];
      try {
        buttons = await listButtonsInFrame(f);
      } catch {
        buttons = [];
      }
      out.push({
        frame_url: url,
        buttons_sample: buttons.slice(0, 50),
        buttons_count: buttons.length,
      });
    }

    res.json({ ok: true, frames: out });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

app.post("/debug/page-snapshot", async (req, res) => {
  const url = "https://ads.tiktok.com/business/creativecenter/top-products/pc/en";
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();

    // Deixa mais “humano”
    await page.setViewportSize({ width: 1365, height: 768 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const title = await page.title();

    // Conteúdo bruto (pra saber se veio “vazio”)
    const htmlLen = await page.evaluate(() => document.documentElement.outerHTML.length);
    const textSample = await page.evaluate(() =>
      (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 800)
    );

    // Contagens de elementos básicos
    const counts = await page.evaluate(() => ({
      buttons: document.querySelectorAll("button").length,
      links: document.querySelectorAll("a").length,
      inputs: document.querySelectorAll("input").length,
      selects: document.querySelectorAll("select").length,
      tables: document.querySelectorAll("table").length,
      trs: document.querySelectorAll("tr").length,
    }));

    const screenshotBase64 = await page.screenshot({ type: "png", fullPage: true, encoding: "base64" });

    res.json({
      ok: true,
      title,
      finalUrl,
      htmlLen,
      textSample,
      counts,
      screenshotBase64,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * ===== Scrape =====
 */

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

    // IMPORTANTÍSSIMO: operar no frame certo
    const root = pickBestFrame(page);
    console.log("[scrape] picked frame:", root.url());

    await dismissOverlays(root);

    // 1) Selecionar Brazil
    console.log("[scrape] selecting region:", region);
    await selectRegion(root, region);

    // 2) Selecionar período
    console.log("[scrape] selecting time range:", timeRangeLabel);
    await selectTimeRange(root, timeRangeLabel);

    // 3) Esperar tabela
    console.log("[scrape] waiting rows...");
    const rowsLocator = root.locator("tr").filter({ hasText: /Details/i });
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

