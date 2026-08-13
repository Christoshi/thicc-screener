// fetch-lp.js — pools.trade tRPC (no Bitquery required)
import fs from "fs/promises";

const OUTPUT_PATH = "data.json";
const TOP_N = 1000;

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
  // ETH/token sides not split in tRPC — leave null (UI shows —)
  return {
    token: (l.tokenAddress || "").toLowerCase(),
    symbol: l.tokenSymbol || "???",
    name: l.tokenName || "",
    pool_id: l.poolId || l.poolKeyHash || null,
    source,
    status: l.status || "",
    lp_value: +lp.toFixed(2),
    eth_side: null,
    token_side: null,
    all_fees_added: null,
    fees_24h_eth: null,
    fees_24h_tokens: null,
    fdv: +fdv.toFixed(2),
    volume_24h: +vol.toFixed(2),
    price: price,
    holders: l.holderCount ?? null,
    created_at: l.createdAt || l.graduatedAt || l.startsAt || null,
  };
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
    // Only graduated CCA have real pools / LP
    if (a.status !== "graduated" && !a.poolKeyHash && !a.poolStats) continue;
    const m = mapLaunch(a, "cca");
    if (m.token && (!map.has(m.token) || m.lp_value > (map.get(m.token).lp_value || 0))) {
      map.set(m.token, m);
    }
  }

  const ranked = [...map.values()]
    .filter(t => t.lp_value > 0 || t.fdv > 0)
    .sort((a, b) => b.lp_value - a.lp_value)
    .slice(0, TOP_N);

  console.log("Ranked", ranked.length, "tokens");
  if (ranked[0]) {
    console.log("Top:", ranked[0].symbol, "LP $", ranked[0].lp_value);
  }

  const now = Date.now();
  await fs.writeFile(
    OUTPUT_PATH,
    JSON.stringify({ updated: now, tokens: ranked }, null, 2)
  );
  console.log("Done. Wrote", OUTPUT_PATH);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
