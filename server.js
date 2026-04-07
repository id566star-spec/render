const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.static(__dirname));

function toNum(v) {
  if (v === null || v === undefined || v === "" || v === "-") return NaN;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isNaN(n) ? NaN : n;
}

function fmt2(v) {
  const n = toNum(v);
  if (Number.isNaN(n)) return "--";
  return n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

function fmtPct(v) {
  const n = toNum(v);
  if (Number.isNaN(n)) return "--";
  return n > 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`;
}

function calcChange(price, prevClose) {
  const p = toNum(price);
  const y = toNum(prevClose);
  if (Number.isNaN(p) || Number.isNaN(y) || y === 0) {
    return { diff: "--", pct: "--" };
  }
  const diff = p - y;
  const pct = diff / y * 100;
  return { diff: fmt2(diff), pct: fmtPct(pct) };
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!res.ok) throw new Error(`請求失敗：${res.status}`);
  return res.json();
}

async function fetchMisQuotes(codes) {
  const channels = [];

  for (const code of codes) {
    channels.push(`tse_${code}.tw`);
    channels.push(`otc_${code}.tw`);
  }

  // 指數區
  channels.push("tse_t00.tw");
  channels.push("otc_o00.tw");

  const url =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${encodeURIComponent(channels.join("|"))}&_=${Date.now()}`;

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
        updateText: `MIS ${item.d || ""} ${item.t || item.ot || ""}`.trim()
      });
    } else {
      stocks.push(record);
    }
  }

  return { stocks, indices };
}

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

      fallbackStocks = missingCodes
        .map(code => dailyMap.get(code))
        .filter(Boolean);
    }

    const stocks = [...mis.stocks, ...fallbackStocks];

    res.json({
      indices: mis.indices,
      stocks
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
