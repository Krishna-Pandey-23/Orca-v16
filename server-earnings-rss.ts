import puppeteer from "puppeteer";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import { PDFParse } from "pdf-parse";

export interface EarningsResult {
    company_name: string;
    symbol: string;
    period: string;
    revenue: string;
    revenue_yoy: string;
    pat: string;
    pat_yoy: string;
    eps: string;
    dividend: string;
    margin: string;
    source: string;
    announcement_date: string;
    url: string;
}

export interface EarningsSummaryData {
    section: string;
    fetched_at: string;
    total_count: number;
    results: EarningsResult[];
}

const EARNINGS_LOOKBACK_DAYS = 30;
const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const BSE_HTTP_TIMEOUT_MS = 25000;

function cleanText(value: string): string {
    return String(value).split(/\s+/).filter(Boolean).join(" ").trim();
}

function httpsGet(
    url: string,
    headers: Record<string, string> = {},
    timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS
): Promise<string> {
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
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`));
        });
        req.end();
    });
}

function inferPeriod(text: string): string {
    const value = cleanText(text);
    const quarterMatch = value.match(/\b(Q[1-4])\b/i);
    if (quarterMatch) return quarterMatch[1].toUpperCase();

    const fyMatch = value.match(/\b(FY\s?\d{2}|FY\s?\d{4})\b/i);
    if (fyMatch) return fyMatch[1].replace(/\s+/g, "").toUpperCase();

    const yearMatch = value.match(/\b(quarter ended [A-Za-z]+\s+\d{4}|march\s+\d{4}|june\s+\d{4}|september\s+\d{4}|december\s+\d{4})\b/i);
    if (yearMatch) return cleanText(yearMatch[1]);

    return "Recent";
}

function inferCompanyName(title: string): string {
    const normalized = cleanText(title.replace(/^q[1-4]\s+results?:/i, "").replace(/^earnings review:/i, ""));
    const separators = [
        /\s+shares?\s+/i,
        /\s+stock\s+/i,
        /\s+soars?\s+/i,
        /\s+surges?\s+/i,
        /\s+jumps?\s+/i,
        /\s+rall(?:y|ies)\s+/i,
        /\s+tanks?\s+/i,
        /\s+slumps?\s+/i,
        /\s+falls?\s+/i,
        /\s+drop[s]?\s+/i,
        /\s+q[1-4]\s+/i,
        /\s+profit\s+/i,
        /\s+results?\s*[:\-]\s*/i,
        /\s*[:\-]\s*/,
        /\s+\|\s+/,
    ];

    for (const separator of separators) {
        const parts = normalized.split(separator);
        const candidate = cleanText(parts[0] || "");
        if (candidate && candidate.length >= 3 && candidate.length <= 60) {
            return candidate;
        }
    }

    return normalized.slice(0, 60);
}

function inferSymbol(title: string, description: string): string {
    const text = `${title} ${description}`;
    const explicit = text.match(/\b(?:NSE|BSE)\s*[:\-]?\s*([A-Z][A-Z0-9&.-]{1,14})\b/);
    if (explicit) return explicit[1];

    return "";
}

function isLikelyEarningsStory(title: string, description: string): boolean {
    const titleText = cleanText(title).toLowerCase();
    const haystack = cleanText(`${title} ${description}`).toLowerCase();

    const positivePatterns = [
        /\bq[1-4]\b.*\b(results?|earnings|profit|revenue|sales|eps|dividend)\b/i,
        /\b(results?|earnings)\b.*\b(q[1-4]|fy\d{2,4}|quarter|year)\b/i,
        /\b(net profit|profit|revenue|sales)\b.*\b(yoy|year-on-year|year on year|dividend|eps|quarter)\b/i,
        /\breported declining eps\b/i,
        /\bboard recommends dividend\b/i,
        /\bquarterly results?\b/i,
        /\bearnings review\b/i,
        /\bresults review\b/i,
    ];

    const negativePatterns = [
        /\bipo\b/i,
        /\bsummit\b/i,
        /\bwealth\b/i,
        /\bmarket fall\b/i,
        /\bwhat lies ahead\b/i,
        /\bvaluation\b/i,
        /\bpolicy\b/i,
        /\btrading\b/i,
        /\bfutures\b/i,
        /\bstocks vs\b/i,
        /\bpre-ipo\b/i,
        /\bquote of the day\b/i,
        /\bexpert view\b/i,
        /\btop gainers\b/i,
        /^\s*(sensex|nifty|dow|nasdaq|s&p)\b/i,
        /\bopens above\b/i,
        /\bmarket(s)? (gain|fall|crash|bounce|open)\b/i,
    ];

    if (negativePatterns.some((pattern) => pattern.test(titleText))) {
        return false;
    }

    return positivePatterns.some((pattern) => pattern.test(titleText) || pattern.test(haystack));
}

function normalizeRupeeValue(value: string | undefined): string {
    if (!value) return "";
    const cleaned = cleanText(value);
    return /₹|rs\.?/i.test(cleaned) ? cleaned : `₹${cleaned}`;
}

function formatRupeeAmount(amount?: string, unit?: string): string {
    if (!amount) return "";
    const normalizedAmount = cleanText(amount).replace(/,$/, "");
    const normalizedUnit = cleanText(unit || "").replace(/\.$/, "");
    return normalizeRupeeValue(`${normalizedAmount}${normalizedUnit ? ` ${normalizedUnit}` : ""}`);
}

function extractMetricAmount(
    text: string,
    keywords: string[],
    extraPatterns: RegExp[] = []
): string {
    const source = cleanText(text);
    const keywordGroup = keywords.join("|");
    const patterns = [
        new RegExp(`(?:${keywordGroup})[^.\\n]{0,240}?\\b(?:to|at|of|stood at|came in at|was|were)\\s*(?:rs\\.?|₹|inr)\\s*([\\d,]+(?:\\.\\d+)?)\\s*(crore|cr|lakh|lakhs|million|billion)?`, "i"),
        new RegExp(`(?:${keywordGroup})[^.\\n]{0,240}?(?:rs\\.?|₹|inr)\\s*([\\d,]+(?:\\.\\d+)?)\\s*(crore|cr|lakh|lakhs|million|billion)?`, "i"),
        ...extraPatterns,
    ];

    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (match) {
            return formatRupeeAmount(match[1], match[2]);
        }
    }

    return "";
}

function extractMetricGrowth(text: string, keywords: string[]): string {
    const source = cleanText(text);
    const keywordGroup = keywords.join("|");
    const positive = [
        "up",
        "rose",
        "rises",
        "grew",
        "growth",
        "jumped",
        "surged",
        "increased",
        "higher",
        "climbed",
        "advanced",
    ];
    const negative = [
        "down",
        "fell",
        "falls",
        "declined",
        "decline",
        "dropped",
        "drop",
        "slumped",
        "lower",
        "decreased",
    ];

    const positivePattern = new RegExp(`(?:${keywordGroup})[^.\\n]{0,160}?(?:${positive.join("|")})\\s*(?:by\\s*)?(\\d+(?:\\.\\d+)?)\\s*%`, "i");
    const negativePattern = new RegExp(`(?:${keywordGroup})[^.\\n]{0,160}?(?:${negative.join("|")})\\s*(?:by\\s*)?(\\d+(?:\\.\\d+)?)\\s*%`, "i");

    const positiveMatch = source.match(positivePattern);
    if (positiveMatch) return `+${positiveMatch[1]}%`;

    const negativeMatch = source.match(negativePattern);
    if (negativeMatch) return `-${negativeMatch[1]}%`;

    return "";
}

function extractArticleText(html: string): string {
    const $ = cheerio.load(html);
    $("script, style, noscript, svg, iframe, footer, header").remove();

    const selectors = [
        "article p",
        "[data-articlebody='1'] p",
        "[itemprop='articleBody'] p",
        ".artText p",
        ".articleBlock p",
        ".story-content p",
        ".storyBody p",
        ".content p",
        "p",
    ];

    const paragraphs: string[] = [];
    for (const selector of selectors) {
        $(selector).each((_, element) => {
            const text = cleanText($(element).text());
            if (text.length > 30) {
                paragraphs.push(text);
            }
        });
        if (paragraphs.length >= 6) break;
    }

    const title = cleanText($("h1").first().text());
    const description = cleanText(
        $('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        ""
    );

    const combined = [title, description, ...paragraphs.slice(0, 12)]
        .filter(Boolean)
        .join(" ");
    const bodyText = cleanText($("body").text());

    return cleanText(`${combined} ${bodyText.slice(0, 8000)}`);
}

function extractMetricsFromArticle(text: string): Partial<EarningsResult> {
    const normalized = cleanText(text);
    const result: Partial<EarningsResult> = {};

    const revenueKeywords = [
        "revenue from operations",
        "revenue",
        "net sales",
        "sales",
        "income from operations",
    ];
    const patKeywords = [
        "consolidated net profit",
        "standalone net profit",
        "net profit",
        "profit after tax",
        "profit",
        "pat",
    ];

    result.period = inferPeriod(normalized);
    result.revenue = extractMetricAmount(normalized, revenueKeywords);
    result.revenue_yoy = extractMetricGrowth(normalized, revenueKeywords);
    result.pat = extractMetricAmount(normalized, patKeywords);
    result.pat_yoy = extractMetricGrowth(normalized, patKeywords);

    const epsMatch = normalized.match(
        /(?:earnings per share|eps)[^.]{0,80}?(?:to|at|of|was|were|increased to|rose to)?\s*(?:rs\.?|₹)\s*(\d+(?:,\d+)*(?:\.\d+)?)(?!\s*%)/i
    );
    if (epsMatch) {
        const value = Number(epsMatch[1].replace(/,/g, ""));
        if (value > 0 && value < 10000) {
            result.eps = `₹${epsMatch[1]}`;
        }
    }

    const dividendMatch = normalized.match(
        /(?:final|interim|special)?\s*dividend[^.]{0,100}?(?:to|at|of|was|were|recommended)?\s*(?:rs\.?|₹)\s*(\d+(?:,\d+)*(?:\.\d+)?)/i
    );
    if (dividendMatch) {
        result.dividend = `₹${dividendMatch[1]}`;
    }

    const marginMatch = normalized.match(
        /(?:ebitda|operating|net profit|profit)\s+margin[^.]{0,60}?(?:to|at|of|was|were)?\s*(\d+(?:\.\d+)?)\s*%/i
    );
    if (marginMatch) {
        result.margin = `${marginMatch[1]}%`;
    }

    return result;
}

function hasMeaningfulMetrics(result: Partial<EarningsResult>): boolean {
    return Boolean(
        result.revenue ||
        result.revenue_yoy ||
        result.pat ||
        result.pat_yoy ||
        result.eps ||
        result.dividend ||
        result.margin
    );
}

async function enrichEarningsWithArticleDetails(results: EarningsResult[]): Promise<EarningsResult[]> {
    const detailCandidates = results.filter((result) => result.url && !/\.pdf(?:$|\?)/i.test(result.url));
    if (detailCandidates.length === 0) return results;

    console.log(`[Detail] Fetching article details for ${detailCandidates.length} earnings items...`);

    const enriched = await Promise.allSettled(
        detailCandidates.map(async (result) => {
            try {
                const html = await httpsGet(result.url, {
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                });
                const articleText = extractArticleText(html);
                const metrics = extractMetricsFromArticle(articleText);
                const normalizedTitle = cleanText(result.company_name);
                const genericTitle = /^(these \d+ stocks|q[1-4] earnings review|sensex|nifty|crude oil|inflation|profit boost)/i.test(normalizedTitle);
                const stillRelevant =
                    (hasMeaningfulMetrics(metrics) && !genericTitle) ||
                    (!genericTitle && /\b(q[1-4]|quarter|results?|earnings)\b/i.test(articleText) && /\b(net profit|revenue|dividend|eps|margin)\b/i.test(articleText));

                if (!stillRelevant) {
                    return null;
                }

                return {
                    ...result,
                    company_name: inferCompanyName(articleText) || result.company_name,
                    period: metrics.period && metrics.period !== "Recent" ? metrics.period : result.period,
                    revenue: metrics.revenue || result.revenue,
                    revenue_yoy: metrics.revenue_yoy || result.revenue_yoy,
                    pat: metrics.pat || result.pat,
                    pat_yoy: metrics.pat_yoy || result.pat_yoy,
                    eps: metrics.eps || result.eps,
                    dividend: metrics.dividend || result.dividend,
                    margin: metrics.margin || result.margin,
                    symbol: result.symbol,
                } satisfies EarningsResult;
            } catch {
                return result;
            }
        })
    );

    const enrichedMap = new Map<string, EarningsResult | null>();
    enriched.forEach((result, index) => {
        if (result.status === "fulfilled") {
            enrichedMap.set(detailCandidates[index].url, result.value);
        }
    });

    return results
        .map((result) => {
            if (!result.url || !enrichedMap.has(result.url)) return result;
            return enrichedMap.get(result.url) ?? null;
        })
        .filter((result): result is EarningsResult => Boolean(result));
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

interface ExtractedMetrics {
    revenue?: string;
    revenue_yoy?: string;
    pat?: string;
    pat_yoy?: string;
    eps?: string;
    dividend?: string;
    margin?: string;
    period?: string;
}

function extractMetricsFromPDF(text: string): ExtractedMetrics {
    const m: ExtractedMetrics = {};
    const t = text.replace(/\s+/g, " ");

    const periodMatch = t.match(
        /(?:quarter(?:ly)?\s+(?:and\s+year\s+)?ended?|for\s+the\s+(?:quarter|period|year)\s+ended?|Q[1-4]\s+FY|FY\d{2})\s+([A-Za-z0-9 ,\-]+?)(?:\s+\(|\.|\n|20\d{2})/i
    );
    if (periodMatch) m.period = periodMatch[1].trim().slice(0, 50);

    const rupee = (pattern: RegExp): string | undefined => {
        const r = t.match(pattern);
        if (!r) return undefined;
        const numMatch = t.slice(r.index!).match(
            /(?:Rs\.?|₹|INR)?\s*(\d+[,\d]*(?:\.\d+)?)\s*(?:Cr|crore)?/i
        );
        if (!numMatch) return undefined;
        return `₹${numMatch[1]} Cr`;
    };

    m.revenue = rupee(
        /(?:revenue from operations|total revenue|net revenue|net sales|income from operations)/i
    );
    m.pat = rupee(
        /(?:profit(?:\s+for\s+the\s+(?:period|quarter|year))?(?:\s+after\s+tax)?|net\s+profit|PAT\b)/i
    );

    const epsMatch = t.match(
        /(?:basic\s+eps|earnings\s+per\s+(?:equity\s+)?share|EPS\s*[\(\[]?basic)\s*[\(\[]?(?:Rs\.?|₹)?\s*(\d+\.?\d*)/i
    );
    if (epsMatch) m.eps = `₹${epsMatch[1]}`;

    const divMatch = t.match(
        /(?:dividend|proposed dividend)\s*(?:per\s+share)?\s*[\(\[]?(?:Rs\.?|₹)?\s*(\d+\.?\d*)/i
    );
    if (divMatch) m.dividend = `₹${divMatch[1]}`;

    const upMatch = t.match(
        /(?:revenue|income|sales)[^.]*(?:increased?|grew?|up|higher)\s*(?:by\s*)?([\d.]+)\s*%/i
    );
    if (upMatch) m.revenue_yoy = `+${upMatch[1]}%`;

    const downMatch = t.match(
        /(?:revenue|income|sales)[^.]*(?:decreased?|declined?|down|lower)\s*(?:by\s*)?([\d.]+)\s*%/i
    );
    if (downMatch && !m.revenue_yoy) m.revenue_yoy = `-${downMatch[1]}%`;

    const patUpMatch = t.match(
        /(?:profit|PAT)[^.]*(?:increased?|grew?|up|higher)\s*(?:by\s*)?([\d.]+)\s*%/i
    );
    if (patUpMatch) m.pat_yoy = `+${patUpMatch[1]}%`;

    const patDownMatch = t.match(
        /(?:profit|PAT)[^.]*(?:decreased?|declined?|down|lower)\s*(?:by\s*)?([\d.]+)\s*%/i
    );
    if (patDownMatch && !m.pat_yoy) m.pat_yoy = `-${patDownMatch[1]}%`;

    const marginMatch = t.match(
        /(?:net\s+profit\s+margin|EBITDA\s+margin|profit\s+margin)\s*[\(\[]?\s*(\d+\.?\d*)\s*%/i
    );
    if (marginMatch) m.margin = `${marginMatch[1]}%`;

    return m;
}

async function enrichEarningsWithPDF(
    results: EarningsResult[]
): Promise<EarningsResult[]> {
    const toEnrich = results.filter((r) => r.url && r.url.toLowerCase().includes("pdf")).slice(0, 50);

    if (toEnrich.length === 0) return results;

    console.log(`[PDF] Extracting metrics from ${toEnrich.length} earnings PDFs...`);

    const enriched = await Promise.allSettled(
        toEnrich.map(async (result) => {
            try {
                const buf = await downloadBuffer(result.url);
                if (buf.length < 1000) return result;

                const parser = new PDFParse({ data: buf });
                const parsed = await parser.getText();
                await parser.destroy();
                const metrics = extractMetricsFromPDF(parsed.text);

                let updated = { ...result };
                if (metrics.revenue) updated.revenue = metrics.revenue;
                if (metrics.revenue_yoy) updated.revenue_yoy = metrics.revenue_yoy;
                if (metrics.pat) updated.pat = metrics.pat;
                if (metrics.pat_yoy) updated.pat_yoy = metrics.pat_yoy;
                if (metrics.eps) updated.eps = metrics.eps;
                if (metrics.dividend) updated.dividend = metrics.dividend;
                if (metrics.margin) updated.margin = metrics.margin;
                if (metrics.period && !result.period) updated.period = metrics.period;

                console.log(`[PDF] ✓ ${result.company_name}: Extracted metrics`);
                return updated;
            } catch (err) {
                return result;
            }
        })
    );

    const enrichedMap = new Map<string, EarningsResult>();
    enriched.forEach((result, idx) => {
        if (result.status === "fulfilled") {
            enrichedMap.set(toEnrich[idx].url, result.value);
        }
    });

    return results.map((r) =>
        r.url && enrichedMap.has(r.url) ? enrichedMap.get(r.url)! : r
    );  
}

async function fetchNSEEarnings(): Promise<EarningsResult[]> {
  console.log(`[NSE] Fetching earnings from RSS...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  const results: EarningsResult[] = [];

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    await page.goto("https://www.nseindia.com", {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    await new Promise((r) => setTimeout(r, 2000));

    const rssContent: string = await page.evaluate(async () => {
      const res = await fetch("https://www.nseindia.com/rss/equity-market-activity.xml");
      return res.text();
    });

    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;
    const lookbackCutoff = Date.now() - EARNINGS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

    while ((match = itemRegex.exec(rssContent)) !== null) {
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
      const desc = cleanText(get("description"));
      const pubDate = get("pubDate");

      if (!title || title.length < 10) continue;
      if (pubDate && new Date(pubDate).getTime() < lookbackCutoff) continue;

      const earningsKeywords = ["results", "earnings", "quarterly", "annual", "financial"];
      const isEarnings = earningsKeywords.some((k) => title.toLowerCase().includes(k));

      if (!isEarnings) continue;

      const symbolMatch = title.match(/\b([A-Z]{1,5})\b/);
      const symbol = symbolMatch ? symbolMatch[1] : "";

      const revenueMatch = desc.match(/revenue[^.]*?([+-]?\d+\.?\d*)%/i);
      const patMatch = desc.match(/(?:profit|pat)[^.]*?([+-]?\d+\.?\d*)%/i);

      results.push({
        company_name: title,
        symbol: symbol,
        period: title.match(/Q[1-4]|FY\d{2}/i)?.[0] || "Not specified",
        revenue: desc.match(/[₹Rs]?\s*(\d+[,\d]*)\s*(?:Cr|crore)/i)?.[1] || "",
        revenue_yoy: revenueMatch ? (revenueMatch[1].startsWith("-") ? revenueMatch[1] : `+${revenueMatch[1]}`) + "%" : "",
        pat: "",
        pat_yoy: patMatch ? (patMatch[1].startsWith("-") ? patMatch[1] : `+${patMatch[1]}`) + "%" : "",
        eps: desc.match(/eps[^.]*?[₹Rs]?\s*(\d+\.?\d*)/i)?.[1] || "",
        dividend: "",
        margin: "",
        source: "NSE India",
        announcement_date: pubDate,
        url: cleanText(get("link")),
      });
    }

    console.log(`[NSE] Parsed ${results.length} earnings items`);
  } finally {
    await page.close();
    await browser.close();
  }

  return results;
}

async function fetchBSEEarnings(): Promise<EarningsResult[]> {
    const results: EarningsResult[] = [];
    const today = new Date();
    const from = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const bseFmt = (d: Date) =>
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const bseFrom = bseFmt(from);
    const bseTo = bseFmt(today);

    const url =
        `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w` +
        `?strCat=-1&strPrevDate=${bseFrom}&strScrip=&strSearch=P` +
        `&strToDate=${bseTo}&strType=C&subcategory=-1`;

    console.log(`[BSE] Fetching earnings announcements...`);

    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                Referer: "https://www.bseindia.com/corporates/ann.html",
                Origin: "https://www.bseindia.com",
                "Cache-Control": "no-cache",
                Accept: "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            },
            signal: AbortSignal.timeout(BSE_HTTP_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const raw = await response.text();

        let json: any;
        try {
            json = JSON.parse(raw);
        } catch {
            throw new Error(`[BSE] Non-JSON response`);
        }

        const rows: any[] = json.Table || json.table || json.data || [];
        console.log(`[BSE] Raw rows received: ${rows.length}`);

        const earningsKeywords = [
            "financial results",
            "quarterly results",
            "half yearly results",
            "annual results",
        ];

        rows.forEach((item) => {
            const category = (item.CATEGORYNAME || "").toLowerCase();
            const isEarnings = earningsKeywords.some((k) => category.includes(k));

            if (isEarnings) {
                const symbol = cleanText(String(item.NSCRIP || item.SCRIP_CD || ""));
                const headline = cleanText(String(item.HEADLINE || ""));
                const attachment = cleanText(String(item.ATTACHMENTNAME || ""));

                results.push({
                    company_name: inferCompanyName(headline || symbol),
                    symbol: symbol,
                    period: inferPeriod(`${headline} ${category}`),
                    revenue: "",
                    revenue_yoy: "",
                    pat: "",
                    pat_yoy: "",
                    eps: "",
                    dividend: "",
                    margin: "",
                    source: "BSE India",
                    announcement_date: cleanText(String(item.DT_TM || item.NEWS_DT || "")),
                    url: attachment
                        ? `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${attachment}`
                        : "",
                });
            }
        });

        console.log(`[BSE] Parsed ${results.length} earnings items`);
    } catch (err) {
        console.error(`[BSE] Failed: ${(err as Error).message}`);
    }

    return results;
}

async function fetchEconomicTimesEarnings(): Promise<EarningsResult[]> {
    const results: EarningsResult[] = [];
    const feeds = [
        "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms",
        "https://economictimes.indiatimes.com/news/company/rssfeeds/2143429.cms",
        "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    ];

    for (const feedUrl of feeds) {
        console.log(`[ET] Fetching: ${feedUrl}`);

        try {
            const xml = await httpsGet(feedUrl, {
                Accept: "application/rss+xml, application/xml, text/xml, */*",
            });

            const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
            let match: RegExpExecArray | null;
            const lookbackCutoff = Date.now() - EARNINGS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

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
                const desc = cleanText(get("description").replace(/<[^>]+>/g, " "));
                const pubDate = get("pubDate");

                if (title.length < 10) continue;
                if (pubDate && new Date(pubDate).getTime() < lookbackCutoff) continue;

                if (!isLikelyEarningsStory(title, desc)) continue;

                const companyName = inferCompanyName(title);
                const symbol = inferSymbol(title, desc);
                const metrics = extractMetricsFromArticle(`${title} ${desc}`);

                results.push({
                    company_name: companyName || title,
                    symbol: symbol,
                    period: metrics.period || inferPeriod(`${title} ${desc}`),
                    revenue: metrics.revenue || "",
                    revenue_yoy: metrics.revenue_yoy || "",
                    pat: metrics.pat || "",
                    pat_yoy: metrics.pat_yoy || "",
                    eps: metrics.eps || "",
                    dividend: metrics.dividend || "",
                    margin: metrics.margin || "",
                    source: "Economic Times",
                    announcement_date: pubDate,
                    url: cleanText(get("link") || get("guid")),
                });
            }

            console.log(`[ET] ${feedUrl} → ${results.length} items`);
        } catch (err) {
            console.error(`[ET] ${feedUrl} failed: ${(err as Error).message}`);
        }
    }

    return results;
}

function saveToFile(data: EarningsSummaryData): void {
    try {
        const dataDir = path.join(process.cwd(), "data");
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
            console.log(`[File] Created directory: ${dataDir}`);
        }
        const fileName = `earnings-results-${new Date().toISOString().slice(0, 10)}.json`;
        const filePath = path.join(dataDir, fileName);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
        console.log(`[File] Saved ${data.total_count} earnings results → data/${fileName}`);
    } catch (err) {
        console.error("[File] Failed to save JSON:", (err as Error).message);
    }
}

export async function scrapeEarningsResults(): Promise<EarningsSummaryData> {
    console.log("\n========================================");
    console.log("[Earnings] Starting earnings results fetch...");
    console.log(`[Earnings] Scanning past ${EARNINGS_LOOKBACK_DAYS} days from ${new Date().toISOString()}`);
    console.log("========================================\n");

    let allResults: EarningsResult[] = [];

    try {
        const nseResults = await fetchNSEEarnings();
        allResults.push(...nseResults);
        console.log(`\n[Earnings] NSE: ✓ ${nseResults.length} items. Running total: ${allResults.length}\n`);
    } catch (err) {
        console.error(`\n[Earnings] NSE: ✗ Failed — ${(err as Error).message}\n`);
    }

    try {
        const bseResults = await fetchBSEEarnings();
        allResults.push(...bseResults);
        console.log(`\n[Earnings] BSE: ✓ ${bseResults.length} items. Running total: ${allResults.length}\n`);
    } catch (err) {
        console.error(`\n[Earnings] BSE: ✗ Failed — ${(err as Error).message}\n`);
    }

    try {
        const etResults = await fetchEconomicTimesEarnings();
        allResults.push(...etResults);
        console.log(`\n[Earnings] ET: ✓ ${etResults.length} items. Running total: ${allResults.length}\n`);
    } catch (err) {
        console.error(`\n[Earnings] ET: ✗ Failed — ${(err as Error).message}\n`);
    }

    if (allResults.length === 0) {
        const emptyResult: EarningsSummaryData = {
            section: `Company Earnings Results — Past ${EARNINGS_LOOKBACK_DAYS} Days`,
            fetched_at: new Date().toISOString(),
            total_count: 0,
            results: [],
        };

        console.warn("[Earnings] No results fetched from any source. Returning an empty dataset instead of crashing.");
        saveToFile(emptyResult);
        return emptyResult;
    }

    const seen = new Set<string>();
    allResults = allResults.filter((r) => {
        const primaryKey = cleanText(r.symbol || r.company_name || r.url).toLowerCase();
        const secondaryKey = cleanText(r.period || r.announcement_date || r.url).toLowerCase();
        const key = `${primaryKey}-${secondaryKey}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`[Earnings] Deduplication: ${allResults.length} unique results`);
    console.log(`[Earnings] Running article detail enrichment...`);

    allResults = await enrichEarningsWithArticleDetails(allResults);
    console.log(`[Earnings] Article enrichment: ${allResults.length} verified results remain`);

    console.log(`[Earnings] Running PDF enrichment...`);

    const enrichedResults = await enrichEarningsWithPDF(allResults);

    const result: EarningsSummaryData = {
        section: `Company Earnings Results — Past ${EARNINGS_LOOKBACK_DAYS} Days`,
        fetched_at: new Date().toISOString(),
        total_count: enrichedResults.length,
        results: enrichedResults,
    };

    saveToFile(result);

    console.log("\n========================================");
    console.log(`[Earnings] Done. Total results: ${result.total_count}`);
    console.log("========================================\n");

    return result;
}

const isDirectExecution =
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
    (async () => {
        try {
            const earningsData = await scrapeEarningsResults();
            console.log("✓ Earnings data ready for card");
            console.log(`Total companies: ${earningsData.total_count}`);
        } catch (err) {
            console.error("✗ Fatal error:", (err as Error).message);
            process.exitCode = 1;
        }
    })();
}
