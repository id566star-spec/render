const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const yahooFinance = require("yahoo-finance2").default;

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.static(__dirname));

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function toNum(v) {
  if (v === null || v === undefined || v === "" || v === "-") return NaN;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isNaN(n) ? NaN : n;
}

function fmtNum(v, digits = 2) {
  const n = toNum(v);
  if (Number.isNaN(n)) return "--";
  return n.toFixed(digits);
}

function fmtSigned(v, digits = 2) {
  const n = toNum(v);
  if (Number.isNaN(n)) return "--";
  return n > 0 ? `+${n.toFixed(digits)}` : n.toFixed(digits);
}

function fmtPct(v, digits = 2) {
  const n = toNum(v);
  if (Number.isNaN(n)) return "--";
  return n > 0 ? `+${n.toFixed(digits)}%` : `${n.toFixed(digits)}%`;
}

function calcChange(price, prevClose) {
  const p = toNum(price);
  const y = toNum(prevClose);
  if (Number.isNaN(p) || Number.isNaN(y) || y === 0) {
    return { diff: "--", pct: "--" };
  }
  const diff = p - y;
  const pct = (diff / y) * 100;
  return {
    diff: fmtSigned(diff),
    pct: fmtPct(pct)
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!res.ok) throw new Error(`請求失敗：${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!res.ok) throw new Error(`請求失敗：${res.status}`);
  return res.text();
}

/* -----------------------------
   台股 / ETF / 指數：TWSE MIS
----------------------------- */
async function fetchMisQuotes(codes) {
  const channels = [];

  for (const code of codes) {
    channels.push(`tse_${code}.tw`);
    channels.push(`otc_${code}.tw`);
  }

  // 指數
  channels.push("tse_t00.tw"); // 加權指數
  channels.push("otc_o00.tw"); // 櫃買指數

  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${encodeURIComponent(channels.join("|"))}&_=${Date.now()}`;
  const data = await fetchJson(url);
  const arr = Array.isArray(data.msgArray) ? data.msgArray : [];

  const stocks = [];
  const indices = [];

  for (const item of arr) {
    const code = normalizeCode(item.c);
    const latestPrice = item.z && item.z !== "-" ? item.z : (item.y || "--");
    const prevClose = item.y || "--";
    const chg = calcChange(latestPrice, prevClose);

    const record = {
      code,
      name: item.n || code,
      market: item.ex === "otc" ? "上櫃" : "上市",
      price: latestPrice,
      prevClose,
      open: item.o || "--",
      high: item.h || "--",
      low: item.l || "--",
      volume: item.ov || item.v || "--",
      amount: "--",
      diff: chg.diff,
      pct: chg.pct,
      updateText: `MIS ${item.d || ""} ${item.t || item.ot || ""}`.trim(),
      quoteSource: "MIS 即時"
    };

    if (code === "T00" || code === "O00") {
      indices.push({
        code,
        name: code === "T00" ? "加權指數" : "櫃買指數",
        price: latestPrice,
        diff: chg.diff,
        pct: chg.pct,
        updateText: `MIS ${item.d || ""} ${item.t || item.ot || ""}`.trim(),
        quoteSource: "MIS 即時"
      });
    } else {
      stocks.push(record);
    }
  }

  return { stocks, indices };
}

/* -----------------------------
   台股日資料回退
----------------------------- */
async function fetchTwseDailyFallback() {
  const url = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
  const data = await fetchJson(url);
  return Array.isArray(data) ? data : [];
}

async function fetchTpexDailyFallback() {
  const url = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";
  const data = await fetchJson(url);
  return Array.isArray(data) ? data : [];
}

function mapTwseDaily(item) {
  const code = normalizeCode(item.Code || item.證券代號);
  if (!code) return null;

  const price = item.ClosingPrice || item.收盤價 || "--";
  const prevClose = item.OpeningPrice || item.開盤價 || "--";
  const chg = calcChange(price, prevClose);

  return {
    code,
    name: item.Name || item.證券名稱 || code,
    market: "上市",
    price,
    prevClose,
    open: item.OpeningPrice || item.開盤價 || "--",
    high: item.HighestPrice || item.最高價 || "--",
    low: item.LowestPrice || item.最低價 || "--",
    volume: item.TradeVolume || item.成交股數 || "--",
    amount: item.TradeValue || item.成交金額 || "--",
    diff: chg.diff,
    pct: chg.pct,
    updateText: "TWSE 日資料",
    quoteSource: "TWSE 回退"
  };
}

function mapTpexDaily(item) {
  const code = normalizeCode(item.SecuritiesCompanyCode || item.代號);
  if (!code) return null;

  const price = item.Close || item.收盤 || "--";
  const prevClose = item.PrevClose || item.前日收盤價 || price;
  const chg = calcChange(price, prevClose);

  return {
    code,
    name: item.CompanyName || item.名稱 || code,
    market: "上櫃",
    price,
    prevClose,
    open: item.Open || item.開盤 || "--",
    high: item.High || item.最高 || "--",
    low: item.Low || item.最低 || "--",
    volume: item.Volume || item.成交股數 || "--",
    amount: item.Amount || item.成交金額 || "--",
    diff: chg.diff,
    pct: chg.pct,
    updateText: "TPEx 日資料",
    quoteSource: "TPEx 回退"
  };
}

/* -----------------------------
   全球市場：Yahoo Finance 延遲行情
----------------------------- */
async function fetchYahooQuoteSafe(symbol, config = {}) {
  try {
    const q = await yahooFinance.quote(symbol);
    const price = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice ?? "--";
    const prevClose = q.regularMarketPreviousClose ?? "--";
    const diff = q.regularMarketChange ?? (toNum(price) - toNum(prevClose));
    const pct = q.regularMarketChangePercent ?? (
      !Number.isNaN(toNum(price)) && !Number.isNaN(toNum(prevClose)) && toNum(prevClose) !== 0
        ? ((toNum(price) - toNum(prevClose)) / toNum(prevClose)) * 100
        : NaN
    );

    return {
      code: config.code || symbol,
      name: config.name || q.shortName || q.longName || symbol,
      market: config.market || q.fullExchangeName || "海外",
      price,
      prevClose,
      open: q.regularMarketOpen ?? "--",
      high: q.regularMarketDayHigh ?? "--",
      low: q.regularMarketDayLow ?? "--",
      volume: q.regularMarketVolume ?? "--",
      amount: "--",
      diff: fmtSigned(diff),
      pct: fmtPct(pct),
      updateText: q.regularMarketTime
        ? `Yahoo ${new Date(q.regularMarketTime * 1000).toLocaleString("zh-TW", { hour12: false })}`
        : "Yahoo 延遲",
      quoteSource: "Yahoo 延遲",
      type: config.type || "global"
    };
  } catch (err) {
    return null;
  }
}

async function fetchGlobalMarkets() {
  const targets = [
    { symbol: "^VIX", code: "VIX", name: "VIX 波動率指數", market: "Cboe", type: "volatility" },
    { symbol: "DX-Y.NYB", code: "DXY", name: "美元指數", market: "ICE / Yahoo", type: "fx" },

    { symbol: "TSM", code: "TSM", name: "台積電 ADR", market: "NYSE", type: "adr" },
    { symbol: "UMC", code: "UMC", name: "聯電 ADR", market: "NYSE", type: "adr" },
    { symbol: "AUOTY", code: "AUOTY", name: "友達 ADR", market: "OTC", type: "adr" },
    { symbol: "CHT", code: "CHT", name: "中華電 ADR", market: "NYSE", type: "adr" },
    { symbol: "ASX", code: "ASX", name: "日月光 ADR", market: "NYSE", type: "adr" },
    { symbol: "HIMX", code: "HIMX", name: "奇景 ADR", market: "NASDAQ", type: "adr" },
    { symbol: "IMOS", code: "IMOS", name: "南茂 ADR", market: "NASDAQ", type: "adr" }
  ];

  const quotes = await Promise.all(targets.map(t => fetchYahooQuoteSafe(t.symbol, t)));
  return quotes.filter(Boolean);
}

/* -----------------------------
   台指期夜盤：TAIFEX 頁面 best effort
   若頁面格式變動，會回 null，不硬塞錯價
----------------------------- */
async function fetchTaifexNightSession() {
  try {
    const html = await fetchText("https://www.taifex.com.tw/enl/eIndex");
    const $ = cheerio.load(html);
    const text = $("body").text().replace(/\s+/g, " ").trim();

    // best-effort 抓取 TX 夜盤區塊
    // 如果抓不到，回傳狀態卡，不顯示錯價
    const match = text.match(/TX-After Hours Trading Session\s*([0-9,]+\.\d+|[0-9,]+)?\s*([+\-]?[0-9,]+\.\d+|[+\-]?[0-9,]+)?\s*([+\-]?[0-9.]+%)?/i);

    if (match && match[1]) {
      return {
        code: "TX-NIGHT",
        name: "台指期夜盤",
        market: "TAIFEX",
        price: match[1] || "--",
        prevClose: "--",
        open: "--",
        high: "--",
        low: "--",
        volume: "--",
        amount: "--",
        diff: match[2] || "--",
        pct: match[3] || "--",
        updateText: "TAIFEX 夜盤頁面",
        quoteSource: "TAIFEX"
      };
    }

    return {
      code: "TX-NIGHT",
      name: "台指期夜盤",
      market: "TAIFEX",
      price: "--",
      prevClose: "--",
      open: "--",
      high: "--",
      low: "--",
      volume: "--",
      amount: "--",
      diff: "--",
      pct: "--",
      updateText: "TAIFEX 夜盤時段 15:00–05:00",
      quoteSource: "TAIFEX"
    };
  } catch (err) {
    return {
      code: "TX-NIGHT",
      name: "台指期夜盤",
      market: "TAIFEX",
      price: "--",
      prevClose: "--",
      open: "--",
      high: "--",
      low: "--",
      volume: "--",
      amount: "--",
      diff: "--",
      pct: "--",
      updateText: "TAIFEX 讀取失敗",
      quoteSource: "TAIFEX"
    };
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const codes = String(req.query.codes || "")
      .split(",")
      .map(normalizeCode)
      .filter(Boolean)
      .filter(v => /^[0-9]{4,6}[A-Z]?$/.test(v));

    const mis = await fetchMisQuotes(codes);
    const foundCodes = new Set(mis.stocks.map(x => x.code));
    const missingCodes = codes.filter(code => !foundCodes.has(code));

    let fallbackStocks = [];

    if (missingCodes.length) {
      const [twseDaily, tpexDaily] = await Promise.all([
        fetchTwseDailyFallback(),
        fetchTpexDailyFallback()
      ]);

      const dailyMap = new Map();

      twseDaily.map(mapTwseDaily).filter(Boolean).forEach(item => dailyMap.set(item.code, item));
      tpexDaily.map(mapTpexDaily).filter(Boolean).forEach(item => dailyMap.set(item.code, item));

      fallbackStocks = missingCodes.map(code => dailyMap.get(code)).filter(Boolean);
    }

    const [globalMarkets, txNight] = await Promise.all([
      fetchGlobalMarkets(),
      fetchTaifexNightSession()
    ]);

    res.json({
      indices: mis.indices,
      stocks: [...mis.stocks, ...fallbackStocks],
      global: txNight ? [txNight, ...globalMarkets] : globalMarkets
    });
  } catch (error) {
    console.error("dashboard error:", error);
    res.status(500).send(error.message || "資料抓取失敗");
  }
});

app.get("*", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
