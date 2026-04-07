const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.static(__dirname));

function pick(obj, keys, fallback = "--") {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== "") {
      return obj[key];
    }
  }
  return fallback;
}

function mapTwseItem(item) {
  const code = String(pick(item, ["Code", "證券代號"], "")).trim();
  if (!code) return null;

  return {
    code,
    name: pick(item, ["Name", "證券名稱"], "上市股票"),
    market: "上市",
    price: pick(item, ["ClosingPrice", "收盤價", "MonthAvgPrice", "月平均價"], "--"),
    prevClose: pick(item, ["OpeningPrice", "開盤價"], "--"),
    open: pick(item, ["OpeningPrice", "開盤價"], "--"),
    high: pick(item, ["HighestPrice", "最高價"], "--"),
    low: pick(item, ["LowestPrice", "最低價"], "--"),
    volume: pick(item, ["TradeVolume", "成交股數"], "--"),
    amount: pick(item, ["TradeValue", "成交金額"], "--"),
    updateText: "TWSE 官方資料"
  };
}

function mapTpexItem(item) {
  const code = String(pick(item, ["SecuritiesCompanyCode", "代號"], "")).trim();
  if (!code) return null;

  return {
    code,
    name: pick(item, ["CompanyName", "名稱"], "上櫃股票"),
    market: "上櫃",
    price: pick(item, ["Close", "收盤"], "--"),
    prevClose: pick(item, ["Close", "收盤"], "--"),
    open: pick(item, ["Open", "開盤"], "--"),
    high: pick(item, ["High", "最高"], "--"),
    low: pick(item, ["Low", "最低"], "--"),
    volume: pick(item, ["Volume", "成交股數"], "--"),
    amount: pick(item, ["Amount", "成交金額"], "--"),
    updateText: "TPEx 官方資料"
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/stocks", async (req, res) => {
  try {
    const twseUrl = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
    const tpexUrl = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

    const [twseRes, tpexRes] = await Promise.all([
      fetch(twseUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      }),
      fetch(tpexUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      })
    ]);

    if (!twseRes.ok) {
      throw new Error(`TWSE 資料來源失敗：${twseRes.status}`);
    }
    if (!tpexRes.ok) {
      throw new Error(`TPEx 資料來源失敗：${tpexRes.status}`);
    }

    const twseData = await twseRes.json();
    const tpexData = await tpexRes.json();

    const twseList = Array.isArray(twseData)
      ? twseData.map(mapTwseItem).filter(Boolean)
      : [];

    const tpexList = Array.isArray(tpexData)
      ? tpexData.map(mapTpexItem).filter(Boolean)
      : [];

    res.json([...twseList, ...tpexList]);
  } catch (error) {
    console.error("api/stocks error:", error);
    res.status(500).send(error.message || "資料抓取失敗");
  }
});

app.get("*", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});