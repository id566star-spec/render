const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.static(__dirname));

function toNum(value) {
  if (value === null || value === undefined) return NaN;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isNaN(n) ? NaN : n;
}

function formatYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function formatROC(date) {
  const y = date.getFullYear() - 1911;
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function shiftDate(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function calcChange(price, prevClose) {
  const p = toNum(price);
  const y = toNum(prevClose);

  if (Number.isNaN(p) || Number.isNaN(y) || y === 0) {
    return {
      diff: "--",
      pct: "--",
      cls: "flat"
    };
  }

  const diff = p - y;
  const pct = (diff / y) * 100;

  return {
    diff: (diff > 0 ? "+" : "") + diff.toFixed(2),
    pct: (pct > 0 ? "+" : "") + pct.toFixed(2) + "%",
    cls: diff > 0 ? "up" : diff < 0 ? "down" : "flat"
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

async function fetchTwseByDate(date) {
  const dateStr = formatYYYYMMDD(date);
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${dateStr}&type=ALLBUT0999`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!res.ok) {
    throw new Error(`TWSE 請求失敗：${res.status}`);
  }

  const data = await res.json();

  if (!data || !Array.isArray(data.tables)) {
    return [];
  }

  // 找有個股清單的表
  const targetTable = data.tables.find(
    table =>
      Array.isArray(table.fields) &&
      Array.isArray(table.data) &&
      table.fields.some(f => String(f).includes("證券代號")) &&
      table.fields.some(f => String(f).includes("收盤價"))
  );

  if (!targetTable) return [];

  const fields = targetTable.fields;
  const rows = targetTable.data;

  const idxCode = fields.findIndex(f => String(f).includes("證券代號"));
  const idxName = fields.findIndex(f => String(f).includes("證券名稱"));
  const idxVolume = fields.findIndex(f => String(f).includes("成交股數"));
  const idxAmount = fields.findIndex(f => String(f).includes("成交金額"));
  const idxOpen = fields.findIndex(f => String(f).includes("開盤價"));
  const idxHigh = fields.findIndex(f => String(f).includes("最高價"));
  const idxLow = fields.findIndex(f => String(f).includes("最低價"));
  const idxClose = fields.findIndex(f => String(f).includes("收盤價"));
  const idxChange = fields.findIndex(f => String(f).includes("漲跌價差"));

  return rows
    .filter(row => row && row[idxCode])
    .map(row => {
      const code = String(row[idxCode]).trim();
      const name = idxName >= 0 ? String(row[idxName]).trim() : "上市股票";
      const volume = idxVolume >= 0 ? row[idxVolume] : "--";
      const amount = idxAmount >= 0 ? row[idxAmount] : "--";
      const open = idxOpen >= 0 ? row[idxOpen] : "--";
      const high = idxHigh >= 0 ? row[idxHigh] : "--";
      const low = idxLow >= 0 ? row[idxLow] : "--";
      const price = idxClose >= 0 ? row[idxClose] : "--";
      const changeValueRaw = idxChange >= 0 ? row[idxChange] : "--";

      return {
        code,
        name,
        market: "上市",
        volume,
        amount,
        open,
        high,
        low,
        price,
        changeValueRaw,
        updateText: `TWSE ${dateStr}`
      };
    });
}

async function fetchTpexByDate(date) {
  const rocDate = formatROC(date);
  const url = `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes?d=${encodeURIComponent(rocDate)}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!res.ok) {
    throw new Error(`TPEx 請求失敗：${res.status}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data
    .filter(item => item["SecuritiesCompanyCode"] || item["代號"])
    .map(item => {
      const code = String(item["SecuritiesCompanyCode"] || item["代號"]).trim();
      const name = item["CompanyName"] || item["名稱"] || "上櫃股票";
      const volume = item["Volume"] || item["成交股數"] || "--";
      const amount = item["Amount"] || item["成交金額"] || "--";
      const open = item["Open"] || item["開盤"] || "--";
      const high = item["High"] || item["最高"] || "--";
      const low = item["Low"] || item["最低"] || "--";
      const price = item["Close"] || item["收盤"] || "--";
      const changeValueRaw = item["Change"] || item["漲跌"] || "--";

      return {
        code,
        name,
        market: "上櫃",
        volume,
        amount,
        open,
        high,
        low,
        price,
        changeValueRaw,
        updateText: `TPEx ${rocDate}`
      };
    });
}

async function fetchNearestTradingData(fetcher, maxBackDays = 7) {
  const today = new Date();

  for (let i = 0; i <= maxBackDays; i++) {
    const d = shiftDate(today, -i);
    try {
      const list = await fetcher(d);
      if (Array.isArray(list) && list.length > 0) {
        return {
          date: d,
          list
        };
      }
    } catch (err) {
      // 繼續往前找最近交易日
    }
  }

  return {
    date: null,
    list: []
  };
}

app.get("/api/stocks", async (req, res) => {
  try {
    const [twseTodayPack, tpexTodayPack, twsePrevPack, tpexPrevPack] = await Promise.all([
      fetchNearestTradingData(fetchTwseByDate, 7),
      fetchNearestTradingData(fetchTpexByDate, 7),
      fetchNearestTradingData(date => fetchTwseByDate(shiftDate(date, -1)), 10),
      fetchNearestTradingData(date => fetchTpexByDate(shiftDate(date, -1)), 10)
    ]);

    const twseToday = twseTodayPack.list;
    const tpexToday = tpexTodayPack.list;
    const twsePrev = twsePrevPack.list;
    const tpexPrev = tpexPrevPack.list;

    const prevMap = new Map();

    [...twsePrev, ...tpexPrev].forEach(item => {
      prevMap.set(item.code, item.price);
    });

    const merged = [...twseToday, ...tpexToday].map(item => {
      const prevClose = prevMap.get(item.code) ?? "--";
      const chg = calcChange(item.price, prevClose);

      return {
        code: item.code,
        name: item.name,
        market: item.market,
        price: item.price,
        prevClose,
        open: item.open,
        high: item.high,
        low: item.low,
        volume: item.volume,
        amount: item.amount,
        diff: chg.diff,
        pct: chg.pct,
        cls: chg.cls,
        updateText: item.updateText
      };
    });

    res.json(merged);
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
