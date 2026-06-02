import puppeteer from "puppeteer";

export const ETF_TARGET_URLS = [
  "https://www.indmoney.com/us-stocks/etfs/sp-500-etfs",
  "https://www.indmoney.com/us-stocks/etfs/nasdaq-etfs",
  "https://www.indmoney.com/us-stocks/etfs/gold-etfs",
  "https://www.indmoney.com/us-stocks/etfs/silver-etfs",
  "https://www.indmoney.com/us-stocks/etfs/platinum-etfs",
  "https://www.indmoney.com/us-stocks/etfs/copper-etfs",
  "https://www.indmoney.com/us-stocks/etfs/lithium-etfs",
  "https://www.indmoney.com/us-stocks/etfs/rare-earth-etfs",
  "https://www.indmoney.com/us-stocks/etfs/uranium-etfs",
  "https://www.indmoney.com/us-stocks/etfs/oil-gas-etfs",
  "https://www.indmoney.com/us-stocks/etfs/natural-gas-etfs",
  "https://www.indmoney.com/us-stocks/etfs/ai-etfs",
  "https://www.indmoney.com/us-stocks/etfs/tech-etfs",
  "https://www.indmoney.com/us-stocks/etfs/semiconductor-etfs"
];

export interface CleanEtfRow {
  name: string;
  ticker: string;
  price: string;
  change: string;
  three_year_return: string;
  volume: string;
  logo_url?: string;
  detail_url?: string;
}

export interface CleanPageData {
  category: string;
  url: string;
  fetched_at: string;
  columns: string[];
  rows: CleanEtfRow[];
}

function labelFromUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const slug = pathParts[pathParts.length - 1] || "etfs";
    return slug
      .split("-")
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  } catch {
    return "Global ETFs";
  }
}

function cleanCell(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .replace(/â–²/g, "▲")
    .replace(/â–¼/g, "▼")
    .trim();
}

function findStockListRecursively(obj: any): any[] | null {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findStockListRecursively(item);
      if (result) return result;
    }
    return null;
  }
  if (obj.stock_list && Array.isArray(obj.stock_list)) {
    return obj.stock_list;
  }
  for (const key of Object.keys(obj)) {
    const result = findStockListRecursively(obj[key]);
    if (result) return result;
  }
  return null;
}

function parseStockList(stocks: any[], baseUrl: string): CleanEtfRow[] {
  return stocks.map((stock: any) => {
    const name = String(stock.name || "");
    const ticker = String(stock.ticker || "");
    const price = String(stock.price || "");

    const changeVal = stock.per_change;
    const formattedChange =
      typeof changeVal === "number"
        ? (changeVal > 0 ? "▲" : changeVal < 0 ? "▼" : "") +
          Math.abs(changeVal).toFixed(2) +
          "%"
        : String(changeVal || "");

    const return3yrs = stock.return_3yrs;
    const formattedReturn =
      typeof return3yrs === "number"
        ? (return3yrs > 0 ? "+" : "") + return3yrs.toFixed(2) + "%"
        : String(return3yrs || "0.00%");

    const volume =
      typeof stock.volume === "number"
        ? stock.volume.toLocaleString("en-US")
        : String(stock.volume || "0");

    let logoUrl = stock.icon || undefined;
    let detailUrl = stock.relative_path || undefined;

    if (detailUrl && !detailUrl.startsWith("http")) {
      const cleanPath = detailUrl.startsWith("/")
        ? detailUrl
        : "/us-stocks/etfs/" + detailUrl;
      try {
        detailUrl = new URL(cleanPath, baseUrl).toString();
      } catch {
        detailUrl = cleanPath;
      }
    }

    return {
      name: cleanCell(name),
      ticker: cleanCell(ticker),
      price: price.startsWith("$") ? cleanCell(price) : "$" + cleanCell(price),
      change: cleanCell(formattedChange),
      three_year_return: cleanCell(formattedReturn),
      volume: cleanCell(volume),
      logo_url: logoUrl,
      detail_url: detailUrl
    };
  });
}

export async function scrapeEtfPage(
  url: string,
  browser: puppeteer.Browser
): Promise<CleanPageData> {
  const defaultCategory = labelFromUrl(url);
  const page = await browser.newPage();

  try {
    // Mimic a real Chrome browser
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1"
    });

    // Block images/fonts/media to speed up loading — we only need the HTML/JS
    await page.setRequestInterception(true);
    page.on("request", req => {
      const type = req.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Wait until __NEXT_DATA__ script tag is present in DOM
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Give React/Next.js a moment to hydrate if needed
    await page.waitForFunction(
      () => !!document.querySelector("script#__NEXT_DATA__"),
      { timeout: 15000 }
    );

    const result = await page.evaluate((pageUrl: string) => {
      const scriptEl = document.querySelector("script#__NEXT_DATA__");
      if (!scriptEl || !scriptEl.textContent) return null;

      try {
        const parsed = JSON.parse(scriptEl.textContent);
        const h1 = document.querySelector("h1")?.textContent?.trim() || "";
        return { nextData: parsed, heading: h1 };
      } catch {
        return null;
      }
    }, url);

    if (!result || !result.nextData) {
      throw new Error(`Could not extract __NEXT_DATA__ from ${url}`);
    }

    const { nextData, heading } = result;

    let stocks = nextData?.props?.pageProps?.stocksData?.stock_list;
    if (!stocks || !Array.isArray(stocks)) {
      stocks = findStockListRecursively(nextData);
    }

    if (!stocks || !Array.isArray(stocks) || stocks.length === 0) {
      throw new Error(`No stock_list found in __NEXT_DATA__ for ${url}`);
    }

    const rows = parseStockList(stocks, url);
    const category = cleanCell(heading) || defaultCategory;

    return {
      category,
      url,
      fetched_at: new Date().toISOString(),
      columns: ["Name", "Ticker", "Price", "Change", "3 Yr. Return", "Volume"],
      rows
    };
  } finally {
    await page.close();
  }
}

export async function scrapeAllEtfs(): Promise<CleanPageData[]> {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,800"
    ]
  });

  try {
    const results: CleanPageData[] = [];
    // Process 2 at a time to avoid triggering rate limits
    const batchSize = 2;

    for (let i = 0; i < ETF_TARGET_URLS.length; i += batchSize) {
      const slice = ETF_TARGET_URLS.slice(i, i + batchSize);
      const promises = slice.map(url => scrapeEtfPage(url, browser));
      const batchResults = await Promise.allSettled(promises);

      for (const res of batchResults) {
        if (res.status === "fulfilled") {
          results.push(res.value);
        } else {
          console.error(`[Scrape Failed]`, res.reason);
        }
      }

      // Jitter between batches to avoid rate limiting
      if (i + batchSize < ETF_TARGET_URLS.length) {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 500));
      }
    }

    return results;
  } finally {
    await browser.close();
  }
}