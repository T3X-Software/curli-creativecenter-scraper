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

async function selectDropdownByVisibleText(page, dropdownSelector, optionText) {
  // Clica no dropdown
  await page.locator(dropdownSelector).first().click({ timeout: 20000 });

  // Procura opção pelo texto (case-insensitive)
  const option = page.locator(`text=${optionText}`).first();
  await option.waitFor({ timeout: 20000 });
  await option.click();
}

app.post("/scrape/creative-center/top-products", async (req, res) => {
  const url =
    "https://ads.tiktok.com/business/creativecenter/top-products/pc/en";

  const region = "Brazil";
  const timeRangeLabel = "Last 7 days";

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage"
    ],
  });

  try {
    const page = await browser.newPage();

    // Dica: algumas páginas do TikTok mudam conteúdo por região/UA
    await page.setExtraHTTPHeaders({
      "accept-language": "en-US,en;q=0.9",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Espera um pouco a UI hidratar
    await page.waitForTimeout(3000);

    /**
     * ✅ Seletores "prováveis" (podem variar com updates do site)
     * A estratégia aqui é:
     * 1) localizar dropdowns na barra superior
     * 2) clicar e escolher os textos desejados
     */

    // 1) Selecionar país/região
    // Tentativa 1: pegar o primeiro dropdown (geralmente "country")
    // Se falhar, vamos cair no try/catch e continuar com alternativa
    try {
      // Heurística: dropdowns ficam numa área com selects visíveis no topo
      const topSelects = page.locator("div:has(button) button");
      // Clique em algo que esteja mostrando um país (ex: Brazil, United States etc)
      const countryBtn = page.locator("button").filter({ hasText: /Brazil|United States|Canada|Mexico|Japan|France|Germany|Spain|Italy/i }).first();
      if (await countryBtn.count()) {
        await countryBtn.click({ timeout: 20000 });
      } else {
        // fallback: tenta o primeiro botão com caret/dropdown
        await topSelects.first().click({ timeout: 20000 });
      }

      const brazilOption = page.locator("text=Brazil").first();
      await brazilOption.waitFor({ timeout: 20000 });
      await brazilOption.click();
      await page.waitForTimeout(2000);
    } catch (e) {
      // Se não conseguir aplicar o filtro, seguimos e retornamos erro mais amigável
      throw new Error(
        `Não consegui selecionar o filtro de país (Brazil). Ajuste de seletor necessário. Detalhe: ${String(e)}`
      );
    }

    // 2) Selecionar período "Last 7 days"
    try {
      // Botão que contém o período atual (ex.: "Last 7 days")
      const timeBtn = page.locator("button").filter({ hasText: /Last\s+7\s+days|Last\s+30\s+days|Last\s+14\s+days|Today/i }).first();
      await timeBtn.click({ timeout: 20000 });

      const opt = page.locator(`text=${timeRangeLabel}`).first();
      await opt.waitFor({ timeout: 20000 });
      await opt.click();
      await page.waitForTimeout(2000);
    } catch (e) {
      throw new Error(
        `Não consegui selecionar o período (Last 7 days). Ajuste de seletor necessário. Detalhe: ${String(e)}`
      );
    }

    // 3) Esperar a tabela aparecer
    // Tentativa: achar linhas que tenham botão "Details" (como no seu print)
    const rowsLocator = page.locator("tr").filter({ hasText: /Details/i });

    await rowsLocator.first().waitFor({ timeout: 30000 });

    // 4) Extrair dados
    const rowCount = await rowsLocator.count();

    const data = [];
    for (let i = 0; i < rowCount; i++) {
      const row = rowsLocator.nth(i);

      // pega todas as células
      const cells = row.locator("td");
      const cellCount = await cells.count();
      if (cellCount < 5) continue;

      // Pelo layout comum:
      // 0 = Product (nome + categoria em subtexto)
      // 1 = Popularity
      // 2 = Popularity change
      // 3 = CTR
      // 4 = CVR
      // 5 = CPA (às vezes existe)
      // (o botão Details normalmente fica por último)

      const productCellText = cleanText(await cells.nth(0).innerText());
      const popularity = cleanText(await cells.nth(1).innerText());
      const popularity_change = cleanText(await cells.nth(2).innerText());
      const ctr = cleanText(await cells.nth(3).innerText());
      const cvr = cleanText(await cells.nth(4).innerText());

      // CPA pode estar na 5, mas depende do layout e se tem mais colunas
      let cpa = "";
      if (cellCount >= 6) {
        cpa = cleanText(await cells.nth(5).innerText());
      }

      // Product pode vir com várias linhas (nome + categoria).
      // A gente pega o primeiro trecho como nome “principal”.
      const product = productCellText.split(" ").slice(0).join(" ");

      data.push({
        product: productCellText,
        popularity,
        popularity_change,
        ctr,
        cvr,
        cpa,
      });
    }

    res.json({
      ok: true,
      region,
      time_range: timeRangeLabel,
      collected_at: new Date().toISOString(),
      source: "creative_center",
      count: data.length,
      data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e) });
  } finally {
    await browser.close();
  }
});

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () =>
  console.log(`scraper listening on :${port}`)
);
