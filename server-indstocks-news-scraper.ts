import puppeteer from "puppeteer";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import * as pdf from "pdf-parse";

export const STOCKS_EXPLORE_URL =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

export interface MarketNewsItem {
  title: string;
  summary?: string;
  source?: string;
  url?: string;
  published_at?: string;
  image_url?: string;
  related_stocks?: string[];
}

export interface MarketNewsData {
  section: string;
  page_url: string;
  fetched_at: string;
  total_count: number;
  items: MarketNewsItem[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanText(value: string): string {
  return String(value).split(/\s+/).filter(Boolean).join(" ").trim();
}

function dateRange(): { bseFrom: string; bseTo: string; nseFrom: string; nseTo: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 3);
  const pad = (n: number) => String(n).padStart(2, "0");
  const bseFmt = (d: Date) =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const nseFmt = (d: Date) =>
    `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
  return {
    bseFrom: bseFmt(from),
    bseTo:   bseFmt(to),
    nseFrom: nseFmt(from),
    nseTo:   nseFmt(to),
  };
}

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = (mod as typeof https).request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          ...headers,
        },
      },
      (res) => {
        // Follow redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          httpsGet(res.headers.location, headers).then(resolve).catch(reject);
          return;
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timed out after 15s"));
    });
    req.end();
  });
}

function downloadBuffer(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = (mod as typeof https).request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          ...headers,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadBuffer(res.headers.location, headers).then(resolve).catch(reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => req.destroy(new Error("PDF download timeout")));
    req.end();
  });
}

interface FinancialMetrics {
  revenue?: string;
  pat?: string;
  eps?: string;
  revenueYoY?: string;
  patYoY?: string;
  period?: string;
}

function extractMetrics(text: string): FinancialMetrics {
  const m: FinancialMetrics = {};

  // Normalise whitespace — PDFs often have fragmented spacing
  const t = text.replace(/\s+/g, " ");

  // Period: "Quarter Ended 31st March 2026" / "Q4 FY26" etc.
  const periodMatch = t.match(
    /(?:quarter(?:ly)?\s+(?:and\s+year\s+)?ended?|for\s+the\s+(?:quarter|period)\s+ended?)\s+([A-Za-z0-9 ,]+?)(?:\s+\(|\.|\n)/i
  );
  if (periodMatch) m.period = periodMatch[1].trim().slice(0, 30);

  // Helper: extract rupee value near a label
  const rupee = (pattern: RegExp): string | undefined => {
    const r = t.match(pattern);
    if (!r) return undefined;
    // Take first number after the label (current period column)
    const numMatch = t.slice(r.index!).match(
      /(?:Rs\.?|₹|INR)?\s*([\d,]+(?:\.\d+)?)/
    );
    if (!numMatch) return undefined;
    const val = parseFloat(numMatch[1].replace(/,/g, ""));
    if (isNaN(val) || val === 0) return undefined;
    return `₹${numMatch[1]} Cr`;
  };

  m.revenue = rupee(
    /(?:revenue from operations|total revenue|net revenue|net sales|income from operations)/i
  );
  m.pat = rupee(
    /(?:profit(?:\s+for\s+the\s+(?:period|quarter|year))?(?:\s+after\s+tax)?|net\s+profit|PAT\b)/i
  );

  // EPS
  const epsMatch = t.match(
    /(?:basic\s+eps|earnings\s+per\s+(?:equity\s+)?share|EPS\s*[\(\[]?basic)/i
  );
  if (epsMatch) {
    const numAfter = t.slice(epsMatch.index!).match(/(?:Rs\.?|₹)?\s*([\d.]+)/);
    if (numAfter) m.eps = `EPS ₹${numAfter[1]}`;
  }

  // YoY % — PDFs often say "increased by X%" or "up X% year-on-year"
  const upMatch = t.match(
    /(?:revenue|income|sales)[^.]*(?:increased?|grew?|up|higher)\s*(?:by\s*)?([\d.]+)\s*%/i
  );
  if (upMatch) m.revenueYoY = `+${upMatch[1]}%`;

  const downMatch = t.match(
    /(?:revenue|income|sales)[^.]*(?:decreased?|declined?|down|lower)\s*(?:by\s*)?([\d.]+)\s*%/i
  );
  if (downMatch && !m.revenueYoY) m.revenueYoY = `-${downMatch[1]}%`;

  const patUpMatch = t.match(
    /(?:profit|PAT)[^.]*(?:increased?|grew?|up|higher)\s*(?:by\s*)?([\d.]+)\s*%/i
  );
  if (patUpMatch) m.patYoY = `+${patUpMatch[1]}%`;

  const patDownMatch = t.match(
    /(?:profit|PAT)[^.]*(?:decreased?|declined?|down|lower)\s*(?:by\s*)?([\d.]+)\s*%/i
  );
  if (patDownMatch && !m.patYoY) m.patYoY = `-${patDownMatch[1]}%`;

  return m;
}

function buildMetricTitle(symbol: string, m: FinancialMetrics): string {
  const parts: string[] = [];
  if (m.revenue) {
    const yoy = m.revenueYoY ? ` (${m.revenueYoY} YoY)` : "";
    parts.push(`Revenue ${m.revenue}${yoy}`);
  }
  if (m.pat) {
    const yoy = m.patYoY ? ` (${m.patYoY} YoY)` : "";
    parts.push(`PAT ${m.pat}${yoy}`);
  }
  if (m.eps) parts.push(m.eps);
  if (parts.length === 0) return "";
  const period = m.period ? ` ${m.period}` : "";
  return `${symbol}${period} results: ${parts.join(", ")}`;
}

const EARNINGS_KEYWORDS = [
  "financial results", "quarterly results", "half yearly results",
  "annual results", "outcome of board meeting",
];

function isEarningsItem(item: MarketNewsItem): boolean {
  const s = (item.summary || "").toLowerCase();
  return EARNINGS_KEYWORDS.some((k) => s.includes(k));
}

async function enrichFinancialResults(items: MarketNewsItem[]): Promise<MarketNewsItem[]> {
  const toEnrich = items
    .filter((item) => isEarningsItem(item) && item.url)
    .slice(0, 40); // cap at 40 PDFs to limit latency

  if (toEnrich.length === 0) return items;

  console.log(`[PDF] Enriching ${toEnrich.length} financial results items...`);

  const enriched = await Promise.allSettled(
    toEnrich.map(async (item) => {
      try {
        const buf = await downloadBuffer(item.url!);
        if (buf.length < 1000) return item; // skip tiny/empty responses

        const parsed = await pdf.default(buf);
        const metrics = extractMetrics(parsed.text);

        const symbol = (item.related_stocks?.[0] || "").toUpperCase();
        const metricTitle = buildMetricTitle(symbol, metrics);

        if (metricTitle) {
          console.log(`[PDF] ✓ ${symbol}: ${metricTitle}`);
          return { ...item, title: metricTitle };
        }
        return item;
      } catch (err) {
        // PDF failed — return original item unchanged
        return item;
      }
    })
  );

  // Merge enriched back into original items array
  const enrichedMap = new Map<string, MarketNewsItem>();
  enriched.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      const original = toEnrich[idx];
      enrichedMap.set(original.url!, result.value);
    }
  });

  return items.map((item) =>
    item.url && enrichedMap.has(item.url) ? enrichedMap.get(item.url)! : item
  );
}

function saveToFile(data: MarketNewsData): void {
  try {
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log(`[File] Created directory: ${dataDir}`);
    }
    const fileName = `announcements-${new Date().toISOString().slice(0, 10)}.json`;
    const filePath = path.join(dataDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    console.log(`[File] Saved ${data.total_count} items → data/${fileName}`);
  } catch (err) {
    console.error("[File] Failed to save JSON:", (err as Error).message);
  }
}

// ── Source 1: BSE Corporate Announcements ────────────────────────────────────

async function fetchBSEAnnouncements(): Promise<MarketNewsItem[]> {
  const { bseFrom, bseTo } = dateRange();

  const url =
    `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w` +
    `?strCat=-1&strPrevDate=${bseFrom}&strScrip=&strSearch=P` +
    `&strToDate=${bseTo}&strType=C&subcategory=-1`;

  console.log(`[BSE] Fetching announcements: ${bseFrom} → ${bseTo}`);
  console.log(`[BSE] URL: ${url}`);

  const raw = await httpsGet(url, {
    Referer:         "https://www.bseindia.com/corporates/ann.html",
    Origin:          "https://www.bseindia.com",
    "Cache-Control": "no-cache",
    Pragma:          "no-cache",
  });

  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`[BSE] Non-JSON response: ${raw.slice(0, 200)}`);
  }

  const rows: any[] = json.Table || json.table || json.data || [];
  console.log(`[BSE] Raw rows received: ${rows.length}`);

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `[BSE] Empty or unexpected response. Keys: ${Object.keys(json).join(", ")}`
    );
  }

  const items = rows
    .map((item): MarketNewsItem => {
      const headline = cleanText(
        String(item.HEADLINE || item.SUBCATEGORYNAME || item.CATEGORYNAME || "")
      );
      const symbol = cleanText(String(item.NSCRIP || item.SCRIP_CD || ""));
      const attachment = cleanText(String(item.ATTACHMENTNAME || ""));

      return {
        title: headline,
        summary: cleanText(String(item.CATEGORYNAME || "")) || undefined,
        source: "BSE India",
        url: attachment
          ? `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${attachment}`
          : `https://www.bseindia.com/corporates/ann.html`,
        published_at: cleanText(String(item.DT_TM || item.NEWS_DT || "")),
        related_stocks: [symbol].filter(Boolean),
      };
    })
    .filter((item) => item.title.length > 5);

  console.log(`[BSE] Parsed ${items.length} valid items`);
  return items;
}

// ── Source 2: NSE Corporate Announcements (Puppeteer session) ────────────────

async function fetchNSEAnnouncements(): Promise<MarketNewsItem[]> {
  const { nseFrom, nseTo } = dateRange();

  console.log(`[NSE] Launching browser to seed session cookies...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    console.log(`[NSE] Visiting homepage to get session...`);
    await page.goto("https://www.nseindia.com", {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    await new Promise((r) => setTimeout(r, 2500));

    const apiUrl =
      `https://www.nseindia.com/api/corporate-announcements` +
      `?index=equities&from_date=${nseFrom}&to_date=${nseTo}`;

    console.log(`[NSE] Fetching API: ${apiUrl}`);

    const rawJson: string = await page.evaluate(async (url: string) => {
      const res = await fetch(url, {
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      return res.text();
    }, apiUrl);

    let data: any;
    try {
      data = JSON.parse(rawJson);
    } catch {
      throw new Error(`[NSE] Non-JSON response: ${rawJson.slice(0, 200)}`);
    }

    const rows: any[] = Array.isArray(data) ? data : data.data || [];
    console.log(`[NSE] Raw rows received: ${rows.length}`);

    if (rows.length === 0) {
      throw new Error("[NSE] Empty array returned from API");
    }

    const items = rows
      .map((item): MarketNewsItem => {
        const symbol   = cleanText(String(item.symbol || ""));
        const category = cleanText(String(item.desc || item.an_desc || ""));
        const bodyText = cleanText(String(item.attchmntText || ""));

        // Use first real sentence from announcement body as title
        const firstSentence = bodyText.split(/(?<=[.!?])\s+/)[0]?.slice(0, 250) || "";
        const isUseful =
          firstSentence.length > 25 &&
          !firstSentence.toLowerCase().match(
            /^(please refer|kindly refer|enclosed please|pursuant to|as required by|we hereby|this is to inform that the company has informed|we wish to inform you that the company has informed|in compliance|in accordance|the exchange|stock exchange)/
          );

        return {
          title: isUseful ? firstSentence : `${symbol}: ${category}`,
          summary: category || undefined,
          source: "NSE India",
          url: item.attchmntFile
          ? (String(item.attchmntFile).startsWith("http")
              ? String(item.attchmntFile)
              : `https://archives.nseindia.com/corporate/${item.attchmntFile}`)
          : undefined,
          published_at: cleanText(String(item.exchdisstime || item.bm_timestamp || "")),
          related_stocks: [symbol].filter(Boolean),
        };
      })
      .filter((item) => item.title.length > 5);

    console.log(`[NSE] Parsed ${items.length} valid items`);
    console.log(`[NSE] Running PDF enrichment on financial results items...`);
    const enrichedItems = await enrichFinancialResults(items);
    const enrichedCount = enrichedItems.filter(
      (item, i) => item.title !== items[i]?.title
    ).length;
    console.log(`[NSE] PDF enrichment done. ${enrichedCount} items enriched with metrics`);
    return enrichedItems;
  } finally {
    await page.close();
    await browser.close();
    console.log(`[NSE] Browser closed`);
  }
}

// ── Source 3: Economic Times RSS (earnings + stock news) ─────────────────────

async function fetchETEarningsRSS(): Promise<MarketNewsItem[]> {
  const feeds = [
    "https://economictimes.indiatimes.com/markets/earnings/rss.cms",
    "https://economictimes.indiatimes.com/markets/stocks/news/rss.cms",
  ];

  const items: MarketNewsItem[] = [];
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

  for (const feedUrl of feeds) {
    console.log(`[ET RSS] Fetching: ${feedUrl}`);
    try {
      const xml = await httpsGet(feedUrl, {
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      });

      const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
      let match: RegExpExecArray | null;
      let count = 0;

      while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];

        const get = (tag: string): string => {
          const m = block.match(
            new RegExp(
              `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`,
              "i"
            )
          );
          return m ? m[1].trim() : "";
        };

        const title = cleanText(get("title"));
        if (!title || title.length < 10) continue;

        const pubDate = get("pubDate");
        if (pubDate && new Date(pubDate).getTime() < threeDaysAgo) continue;

        const desc = cleanText(get("description").replace(/<[^>]+>/g, " "));

        items.push({
          title,
          summary: desc || undefined,
          source: "Economic Times",
          url: cleanText(get("link") || get("guid")) || undefined,
          published_at: pubDate || undefined,
        });
        count++;
      }

      console.log(`[ET RSS] ${feedUrl} → ${count} items within 3 days`);
    } catch (err) {
      console.error(`[ET RSS] ${feedUrl} failed: ${(err as Error).message}`);
    }
  }

  return items;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scrapeMarketNews(): Promise<MarketNewsData> {
  console.log("\n========================================");
  console.log("[News] Starting market news fetch...");
  console.log(`[News] Date range: past 3 days from ${new Date().toISOString()}`);
  console.log("========================================\n");

  let items: MarketNewsItem[] = [];
  let pageUrl = "https://www.bseindia.com/corporates/ann.html";

  // ── Source 1: BSE ──────────────────────────────────────────────────────────
  try {
    const bseItems = await fetchBSEAnnouncements();
    items.push(...bseItems);
    console.log(`\n[News] BSE: ✓ ${bseItems.length} items added. Running total: ${items.length}\n`);
  } catch (err) {
    console.error(`\n[News] BSE: ✗ Failed — ${(err as Error).message}\n`);
  }

  // ── Source 2: NSE ──────────────────────────────────────────────────────────
  try {
    const nseItems = await fetchNSEAnnouncements();
    items.push(...nseItems);
    pageUrl = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
    console.log(`\n[News] NSE: ✓ ${nseItems.length} items added. Running total: ${items.length}\n`);
  } catch (err) {
    console.error(`\n[News] NSE: ✗ Failed — ${(err as Error).message}\n`);
  }

  // ── Source 3: ET RSS ───────────────────────────────────────────────────────
  try {
    const rssItems = await fetchETEarningsRSS();
    items.push(...rssItems);
    console.log(`\n[News] ET RSS: ✓ ${rssItems.length} items added. Running total: ${items.length}\n`);
  } catch (err) {
    console.error(`\n[News] ET RSS: ✗ Failed — ${(err as Error).message}\n`);
  }

  // Hard fail — no mock data ever
  if (items.length === 0) {
    throw new Error(
      "All three sources failed (BSE, NSE, ET RSS). Check network connectivity."
    );
  }

  // Deduplicate by title
  const seen = new Set<string>();
  items = items.filter((item) => {
    const key = item.title.toLowerCase().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n[News] Deduplication: ${items.length} unique items remaining`);

  const result: MarketNewsData = {
    section:     "Corporate Announcements & Earnings — Past 3 Days",
    page_url:    pageUrl,
    fetched_at:  new Date().toISOString(),
    total_count: items.length,
    items,
  };

  // Save to data/ directory
  saveToFile(result);

  console.log("\n========================================");
  console.log(`[News] Done. Total items: ${result.total_count}`);
  console.log("========================================\n");

  return result;
}