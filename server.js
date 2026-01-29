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
 * ===== Helpers =====
 */

async function dismissOverlays(root) {
  const candidates = [
    root.getByRole("button", { name: /accept|agree|allow all|ok/i }),
    root.getByRole("button", { name: /aceitar|concordo|permitir tudo|permitir|ok/i }),
    root.locator("button:has-text('Accept')"),
    root.locator("button:has-text('Agree')"),
    root.locator("button:has-text('Allow all')"),
    root.locator("button:has-text('Aceitar')"),
    root.locator("button:has-text('Concordo')"),
    root.locator("button:has-text('Permitir tudo')"),
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

async function listButtonsInFrame(frame) {
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

function scoreFrameByUrl(url) {
  let score = 0;
  if (!url) return -999;
  if (url.includes("ads.tiktok.com")) score += 5;
  if (url.includes("creativecenter")) score += 5;
  if (url.startsWith("about:blank")) score -= 5;
  return score;
}

async function pickBestFrame(page) {
  // Heurística melhor: tenta achar o frame que realmente contém a tabela (Detalhes/Details)
  const frames = page.frames();

  // 1) tenta por conteúdo
  for (const f of frames) {
    try {
      const maybe = f.locator("text=Detalhes, text=Details");
      if (await maybe.first().isVisible({ timeout: 800 })) {
        return f;
      }
    } catch {}
  }

  // 2) fallback por URL
  const scored = frames
    .map((f) => ({ frame: f, url: f.url() || "", score: scoreFrameByUrl(f.url() || "") }))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.frame || page.mainFrame();
}

async function openFiltersPanel(root) {
  const candidates = [
    root.getByRole("button", { name: /filter|filtro/i }),
    root.locator("button:has-text('Filter')"),
    root.locator("button:has-text('Filtro')"),
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

async function selectRegion(root, regionName = "Brasil") {
  await openFiltersPanel(root);

  // Como seu print mostra um dropdown já exibindo "Brasil",
  // tentamos clicar no botão que contém o texto do país atual
  const regionBtnCandidates = [
    root.getByRole("button", { name: /brasil|brazil|portugal|mexico|united states|canada|japan/i }),
    root.locator("button").filter({ hasText: /Brasil|Brazil|United States|Canada|Mexico|Japan/i }).first(),
  ];

  let opened = false;
  for (const b of regionBtnCandidates) {
    try {
      if (await b.first().isVisible({ timeout: 2500 })) {
        await b.first().click({ timeout: 15000 });
        opened = true;
        break;
      }
    } catch {}
  }

  // fallback: tenta achar qualquer combobox/input (se a UI mudou)
  if (!opened) {
    const regionFieldCandidates = [
      root.getByRole("combobox").first(),
      root.locator('input[placeholder*="Reg" i]').first(),
      root.locator('input[placeholder*="Region" i]').first(),
      root.locator('input[placeholder*="Pa" i]').first(),
      root.locator('input[placeholder*="Country" i]').first(),
      root.locator('input[placeholder*="Pesq" i]').first(),
      root.locator('input[placeholder*="Search" i]').first(),
      root.locator('input[type="text"]').first(),
    ];

    let field = null;
    for (const cand of regionFieldCandidates) {
      try {
        if (await cand.isVisible({ timeout: 2000 })) {
          field = cand;
          break;
        }
      } catch {}
    }

    if (!field) {
      throw new Error("Não encontrei controle de Region/Country (dropdown/combobox/input) no frame escolhido.");
    }

    await field.click({ timeout: 15000 });
    await field.fill(regionName, { timeout: 15000 });
    await root.waitForTimeout?.(600);
  }

  // escolher opção (PT/EN)
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

  // Se tiver Apply/Confirm
  const applyCandidates = [
    root.getByRole("button", { name: /apply|confirm|ok|done|aplicar|confirmar|concluir/i }),
    root.locator("button:has-text('Apply')"),
    root.locator("button:has-text('Confirm')"),
    root.locator("button:has-text('Done')"),
    root.locator("button:has-text('Aplicar')"),
    root.locator("button:has-text('Confirmar')"),
    root.locator("button:has-text('Concluir')"),
  ];

  for (const a of applyCandidates) {
    try {
      if (await a.first().isVisible({ timeout: 1200 })) {
        await a.first().click({ timeout: 8000 });
        await root.waitForTimeout?.(800);
        break;
      }
    } catch {}
  }
}

async function selectTimeRange(root, timeRangeLabel = "Últimos 7 dias") {
  // seu print mostra o botão “Últimos 7 dias”
  const timeBtnCandidates = [
    root.getByRole("button", { name: /últimos\s+7\s+dias|ultimos\s+7\s+dias|last\s+7\s+days/i }),
    root.locator("button").filter({ hasText: /Últimos\s+7\s+dias|Last\s+7\s+days|Últimos\s+30\s+dias|Last\s+30\s+days/i }).first(),
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

    const context = await browser.newContext({
      viewport: { width: 1365, height: 768 },
      locale: "pt-BR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" });

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

app.post("/debug/frames", async (req, res) => {
  const url = "https://ads.tiktok.com/business/creativecenter/top-products/pc/en";
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      viewport: { width: 1365, height: 768 },
      locale: "pt-BR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" });

    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(1500);

    const frames = page.frames();
    const out = [];

    for (const f of frames) {
      let buttons = [];
      try {
        buttons = await listButtonsInFrame(f);
      } catch {
        buttons = [];
      }
      out.push({
        frame_url: f.url(),
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

    const context = await browser.newContext({
      viewport: { width: 1365, height: 768 },
      locale: "pt-BR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" });

    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const title = await page.title();

    const htmlLen = await page.evaluate(() => document.documentElement.outerHTML.length);
    const textSample = await page.evaluate(() =>
      (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 800)
    );

    const counts = await page.evaluate(() => ({
      buttons: document.querySelectorAll("button").length,
      links: document.querySelectorAll("a").length,
      inputs: document.querySelectorAll("input").length,
      selects: document.querySelectorAll("select").length,
      tables: document.querySelectorAll("table").length,
      trs: document.querySelectorAll("tr").length,
    }));

    const screenshotBase64 = await page.screenshot({
      type: "png",
      fullPage: true,
      encoding: "base64",
    });

    res.json({ ok: true, title, finalUrl, htmlLen, textSample, counts, screenshotBase64 });
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

  // ✅ defaults que batem com sua UI (PT-BR)
  const region = req.body?.region || "Brasil";
  const timeRangeLabel = req.body?.timeRangeLabel || "Últimos 7 dias";

  let browser;
  const started = Date.now();

  try {
    console.log("[scrape] launching browser...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      viewport: { width: 1365, height: 768 },
      locale: "pt-BR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" });

    console.log("[scrape] goto...");
    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(1500);

    const root = await pickBestFrame(page);
    console.log("[scrape] picked frame:", root.url());

    await dismissOverlays(root);

    console.log("[scrape] selecting region:", region);
    await selectRegion(root, region);

    console.log("[scrape] selecting time range:", timeRangeLabel);
    await selectTimeRange(root, timeRangeLabel);

    console.log("[scrape] waiting rows...");
    const rowsLocator = root.locator("tr").filter({ hasText: /Details|Detalhes/i });
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
