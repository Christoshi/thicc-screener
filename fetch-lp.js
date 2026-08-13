// fetch-lp.js — pools.trade tRPC only (no Bitquery)
import fs from "fs/promises";

const OUTPUT_PATH = "data.json";
const HISTORY_PATH = "data/history.json";
const TOP_N = 1000;

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * MS_24H;
const MS_30D = 30 * MS_24H;
const TOLERANCE = 3 * 60 * 60 * 1000; // ±3h closest snapshot

async function trpc(procedure, input) {
  const q = encodeURIComponent(JSON.stringify({ "0": input }));
  const url = `https://pools.trade/api/trpc/${procedure}?batch=1&input=${q}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "thicc-screener/1.0" },
  });
  if (!res.ok) throw new Error(`tRPC ${procedure} HTTP ${res.status}`);
  const json = await res.json();
  const item = Array.isArray(json) ? json[0] : json;
  if (item?.error) throw new Error(`tRPC ${procedure}: ${JSON.stringify(item.error)}`);
  return item?.result?.data ?? item?.result?.data?.json ?? [];
}

function mapLaunch(l, source) {
  const stats = l.poolStats || {};
  const lp = Number(stats.liquidityUsd ?? l.liquidityUsd ?? 0);
  const price = Number(stats.priceUsd ?? l.clearingPriceUsd ?? l.priceUsd ?? 0);
  const vol = Number(stats.volume24hUsd ?? l.volume24hUsd ?? 0);
  const fdv = Number(l.fdvUsd ?? (price > 0 ? price * 1e9 : 0));
  return {
    token: (l.tokenAddress || "").toLowerCase(),
    symbol: l.tokenSymbol || "???",
    name: l.tokenName || "",
    pool_id: l.poolId || l.poolKeyHash || null,
    source,
    status: l.status || "",
    lp_value: +lp.toFixed(2),
    fdv: +fdv.toFixed(2),
    volume_24h: +vol.toFixed(2),
    price,
    holders: l.holderCount ?? null,
    created_at: l.createdAt || l.graduatedAt || l.startsAt || null,
  };
}

function closestLp(historyByToken, token, targetTs) {
  const rows = historyByToken.get(token);
  if (!rows || !rows.length) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.ts - targetTs);
    if (d < bestDiff && d <= TOLERANCE * 4) {
      // allow wider window for 7d/30d
      bestDiff = d;
      best = r;
    }
  }
  // stricter for 24h
  if (targetTs > Date.now() - MS_24H * 1.5 && bestDiff > TOLERANCE * 2) return null;
  return best ? best.lp_value : null;
}

function pctChange(now, then) {
  if (then == null || then === 0 || now == null) return null;
  return +(((now - then) / then) * 100).toFixed(2);
}

function dollarChange(now, then) {
  if (then == null || now == null) return null;
  return +(now - then).toFixed(2);
}

async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function main() {
  console.log("Fetching curve.listLaunches (volume)...");
  const byVolume = await trpc("curve.listLaunches", { sortBy: "volume" });
  console.log("  got", byVolume.length);

  console.log("Fetching curve.listLaunches (trending)...");
  let byTrending = [];
  try {
    byTrending = await trpc("curve.listLaunches", { sortBy: "trending" });
    console.log("  got", byTrending.length);
  } catch (e) {
    console.log("  trending skip:", e.message);
  }

  console.log("Fetching curve.listLaunches (recency)...");
  let byRecency = [];
  try {
    byRecency = await trpc("curve.listLaunches", { sortBy: "recency" });
    console.log("  got", byRecency.length);
  } catch (e) {
    console.log("  recency skip:", e.message);
  }

  console.log("Fetching cca.listAuctions...");
  let auctions = [];
  try {
    auctions = await trpc("cca.listAuctions", {});
    console.log("  got", auctions.length);
  } catch (e) {
    console.log("  cca skip:", e.message);
  }

  // Only tokens that appear in pools.trade tRPC launch lists
  const map = new Map();
  for (const l of byVolume) {
    const m = mapLaunch(l, "curve");
    if (m.token) map.set(m.token, m);
  }
  for (const l of byTrending) {
    const m = mapLaunch(l, "curve");
    if (m.token && (!map.has(m.token) || m.lp_value > (map.get(m.token).lp_value || 0))) {
      map.set(m.token, m);
    }
  }
  for (const l of byRecency) {
    const m = mapLaunch(l, "curve");
    if (m.token && (!map.has(m.token) || m.lp_value > (map.get(m.token).lp_value || 0))) {
      map.set(m.token, m);
    }
  }
  for (const a of auctions) {
    if (a.status !== "graduated" && !a.poolKeyHash && !a.poolStats) continue;
    const m = mapLaunch(a, "cca");
    if (m.token && (!map.has(m.token) || m.lp_value > (map.get(m.token).lp_value || 0))) {
      map.set(m.token, m);
    }
  }

  const ranked = [...map.values()]
    .filter((t) => t.lp_value > 0 || t.fdv > 0)
    .sort((a, b) => b.lp_value - a.lp_value)
    .slice(0, TOP_N);

  const now = Date.now();
  let history = await loadHistory();

  // Append current snapshot
  for (const t of ranked) {
    history.push({ token: t.token, ts: now, lp_value: t.lp_value });
  }

  // Keep ~45 days to cover 30d + buffer
  const cutoff = now - 45 * MS_24H;
  history = history.filter((h) => h.ts >= cutoff);

  // Normalize old lp_usd → lp_value
  history = history.map((h) => ({
    token: h.token,
    ts: h.ts,
    lp_value: h.lp_value ?? h.lp_usd ?? 0,
  }));

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));

  // Index history by token
  const byToken = new Map();
  for (const h of history) {
    if (!byToken.has(h.token)) byToken.set(h.token, []);
    byToken.get(h.token).push(h);
  }
  for (const arr of byToken.values()) arr.sort((a, b) => a.ts - b.ts);

  for (const t of ranked) {
    const lp24 = closestLp(byToken, t.token, now - MS_24H);
    const lp7 = closestLp(byToken, t.token, now - MS_7D);
    const lp30 = closestLp(byToken, t.token, now - MS_30D);

    t.lp_change_24h = dollarChange(t.lp_value, lp24);
    t.lp_change_24h_pct = pctChange(t.lp_value, lp24);
    t.lp_change_7d = dollarChange(t.lp_value, lp7);
    t.lp_change_7d_pct = pctChange(t.lp_value, lp7);
    t.lp_change_30d = dollarChange(t.lp_value, lp30);
    t.lp_change_30d_pct = pctChange(t.lp_value, lp30);
  }

  console.log("Ranked", ranked.length, "tokens");
  if (ranked[0]) console.log("Top:", ranked[0].symbol, "LP $", ranked[0].lp_value);

  await fs.writeFile(
    OUTPUT_PATH,
    JSON.stringify({ updated: now, tokens: ranked }, null, 2)
  );
  console.log("Done. Wrote", OUTPUT_PATH, "+ history");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
