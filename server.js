/**
 * Curli — TikTok Creative Center Scraper (Top Products)
 * Caminho A: extrair a TABELA em JSON (items) e retornar pronto pro n8n → Google Sheets
 *
 * Endpoints:
 *  - GET  /health
 *  - POST /scrape/creative-center/top-products   ✅ retorna items (JSON)
 *  - POST /debug/open
 *  - POST /debug/frames
 *  - POST /debug/page-snapshot
 */

const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "2mb" }));

/** =========================
 *  Utils
 *  ========================= */
function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function msNow(started) {
  return Date.now() - started;
}

function scoreFrameByUrl(url) {
  let score = 0;
  if (!url) return -999;
  if (url.includes("ads.tiktok.com")) score += 5;
  if (url.includes("creativecenter")) score += 5;
  if (url.includes("top-products")) score += 4;
  if (url.startsWith("about:blank")) score -= 5;
  return score;
}

function normalizeHeaderToKey(h) {
  const header = cleanText(h).toLowerCase();

  // PT-BR
  if (header.includes("produto")) return "product";
  if (header.includes("popularidade")) return "popularity";
  if (header.includes("mud") || header.includes("varia") || header.includes("change")) return "popularity_change";
  if (header === "ctr" || header.includes("ctr")) return "ctr";
  if (header === "cvr" || header.includes("cvr")) return "cvr";
  if (header === "cpa" || header.includes("cpa")) return "cpa";
  if (header.includes("custo") || header.includes("cost")) return "cost";
  if (header.includes("impress")) return "impressions";
  if (header.includes("curt") || header.includes("like")) return "likes";
  if (header.includes("coment")) return "comments";
  if (header.includes("compart") || header.includes("share")) return "shares";
  if (header.includes("view rate") || header.includes("taxa de visual")) return "view_rate";
  if (header.includes("6s")) return "view_rate_6s";

  // EN
  if (header.includes("product")) return "product";
  if (header.includes("popularity")) return "popularity";

  // fallback: transforma em key segura
  return header
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

async function dismissOverlays(root) {
  // root pode ser page ou frame (ambos têm locator/getByRole)
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

async function pickBestFrame(page) {
  const frames = page.frames();

  // 1) tenta por conteúdo (linha Detalhes/Details)
  for (const f of frames) {
    try {
      const maybe = f.locator("text=Detalhes, text=Details");
      if (await maybe.first().isVisible({ timeout: 800 })) return f;
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

  // tenta clicar no dropdown que já mostra o país atual
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

  // fallback: tenta campo de texto/combobox
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

  // Apply/Confirm se existir
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
    // às vezes o default já é o certo
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
 * Extrai tabela como JSON:
 * - tenta ler headers do THEAD (se existir)
 * - senão infere a partir da 1ª linha (menos confiável)
 */
async function extractTopProductsTable(root) {
  // garante que existe alguma linha com Detalhes/Details
  const rowsLocator = root.locator("tr").filter({ hasText: /Details|Detalhes/i });
  await rowsLocator.first().waitFor({ timeout: 60000 });

  // tenta achar tabela "mais próxima"
  // (muitas UIs têm várias tabelas; esta heurística foca na que contém as linhas com Details/Detalhes)
  const table = root.locator("table").filter({ has: rowsLocator.first() }).first();

  // headers
  let headers = [];
  try {
    const theadHeaders = table.locator("thead tr th");
    if ((await theadHeaders.count()) > 0) {
      headers = await theadHeaders.allInnerTexts();
      headers = headers.map(cleanText).filter(Boolean);
    }
  } catch {}

  // fallback: tenta pegar a 1ª linha de dados como “pseudo-header” (não ideal)
  if (headers.length === 0) {
    // tenta localizar qualquer th na página
    const ths = root.locator("th");
    if ((await ths.count()) > 0) {
      headers = (await ths.allInnerTexts()).map(cleanText).filter(Boolean);
    }
  }

  // map de índice → key
  const headerKeys = headers.map(normalizeHeaderToKey);

  const rowCount = await rowsLocator.count();
  const items = [];

  for (let i = 0; i < rowCount; i++) {
    const row = rowsLocator.nth(i);
    const cells = row.locator("td");
    const cellCount = await cells.count();

    // normalmente tem: Produto + várias métricas + um botão Detalhes no fim
    if (cellCount < 3) continue;

    const cellTexts = [];
    for (let c = 0; c < cellCount; c++) {
      cellTexts.push(cleanText(await cells.nth(c).innerText()));
    }

    // remove a última célula se for só “Detalhes/Details”
    const last = cellTexts[cellTexts.length - 1]?.toLowerCase?.() || "";
    if (last === "details" || last === "detalhes") {
      cellTexts.pop();
    }

    // cria objeto
    const obj = {};

    if (headerKeys.length > 0) {
      // usa os headers se baterem em quantidade (ou quase)
      for (let idx = 0; idx < cellTexts.length; idx++) {
        const key = headerKeys[idx] || `col_${idx + 1}`;
        obj[key] = cellTexts[idx];
      }
    } else {
      // fallback “fixo” (se não conseguiu ler header)
      // ordem mais comum:
      // 0 product, 1 popularity, 2 popularity_change, 3 ctr, 4 cvr, 5 cpa, ...
      obj.product = cellTexts[0] || "";
      obj.popularity = cellTexts[1] || "";
      obj.popularity_change = cellTexts[2] || "";
      obj.ctr = cellTexts[3] || "";
      obj.cvr = cellTexts[4] || "";
      obj.cpa = cellTexts[5] || "";
      // extras
      for (let idx = 6; idx < cellTexts.length; idx++) {
        obj[`col_${idx + 1}`] = cellTexts[idx];
      }
    }

    // saneamento mínimo
    if (obj.product && obj.product.length > 1) items.push(obj);
  }

  return {
    headers,
    headerKeys,
    items,
  };
}

/** =========================
 *  Routes
 *  ========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "scraper", ts: new Date().toISOString() });
});

/**
 * DEBUG: só abre a página e retorna título
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

    res.json({ ok: true, title: await page.title(), finalUrl: page.url(), ms: msNow(started) });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e), ms: msNow(started) });
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * DEBUG: lista frames + botões visíveis (pra diagnosticar UI)
 */
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
        score: scoreFrameByUrl(f.url()),
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

/**
 * DEBUG: snapshot (textSample + counts + screenshot em base64)
 * ⚠️ ATENÇÃO: screenshot pode ser pesado; use quando precisar.
 */
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

    const title = await page.title();
    const finalUrl = page.url();

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
 * ✅ SCRAPE PRINCIPAL (Caminho A)
 *
 * Body opcional:
 *  {
 *    "region": "Brasil" | "Brazil",
 *    "timeRangeLabel": "Últimos 7 dias" | "Last 7 days",
 *    "includeScreenshot": false
 *  }
 */
app.post("/scrape/creative-center/top-products", async (req, res) => {
  const url = "https://ads.tiktok.com/business/creativecenter/top-products/pc/en";

  const region = req.body?.region || "Brasil";
  const timeRangeLabel = req.body?.timeRangeLabel || "Últimos 7 dias";
  const includeScreenshot = Boolean(req.body?.includeScreenshot);

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

    console.log("[scrape] extracting table...");
    const { headers, headerKeys, items } = await extractTopProductsTable(root);

    const payload = {
      ok: true,
      source: "creative_center",
      page_url: url,
      region,
      time_range: timeRangeLabel,
      collected_at: new Date().toISOString(),
      headers,
      header_keys: headerKeys,
      count: items.length,
      ms: msNow(started),
      items, // ✅ aqui estão os dados que você vai mandar pra planilha
    };

    if (includeScreenshot) {
      // opcional (pra debug), evita ficar pesado sempre
      const screenshotBase64 = await page.screenshot({
        type: "png",
        fullPage: true,
        encoding: "base64",
      });
      payload.screenshotBase64 = screenshotBase64;
    }

    res.json(payload);
  } catch (e) {
    console.error("[scrape] error:", e);
    res.status(500).json({
      ok: false,
      message: String(e),
      ms: msNow(started),
    });
  } finally {
    if (browser) await browser.close();
  }
});

/** =========================
 *  Listen
 *  ========================= */
const port = process.env.PORT || 8080;

// Railway/containers normalmente precisam 0.0.0.0
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`scraper listening on 0.0.0.0:${port}`);
});

server.on("error", (err) => {
  console.error("Failed to bind server:", err);
});
