import fs from "fs/promises";

const API_KEY = process.env.BITQUERY_API_KEY;
const LAUNCHPADS = [
  "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
  "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
  "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2",
  "0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491",
];
const HISTORY_PATH = "data/history.json";
const OUTPUT_PATH = "data.json";
const TOP_N = 100;

async function bitqueryFetch(query) {
  const res = await fetch("https://streaming.bitquery.io/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function getLaunches() {
  const query = `
    {
      EVM(network: robinhood) {
        Events(
          limit: {count: 2000}
          orderBy: {descending: Block_Time}
          where: {
            LogHeader: {Address: {in: ${JSON.stringify(LAUNCHPADS)}}}
            Log: {Signature: {Name: {is: "TokenLaunched"}}}
          }
        ) {
          Arguments {
            Name
            Value {
              ... on EVM_ABI_Address_Value_Arg { address }
              ... on EVM_ABI_Bytes_Value_Arg { hex }
            }
          }
        }
      }
    }
  `;
  const data = await bitqueryFetch(query);
  const launches = [];
  for (const ev of data.EVM.Events || []) {
    let token = null, poolId = null;
    for (const arg of ev.Arguments) {
      if (arg.Name === "token" && arg.Value?.address) {
        token = arg.Value.address.toLowerCase();
      }
      if (arg.Name === "poolId" && arg.Value?.hex) {
        const hex = arg.Value.hex;
        poolId = (hex.startsWith("0x") ? hex : "0x" + hex).toLowerCase();
      }
    }
    if (token && poolId) launches.push({ token, poolId });
  }

  // dedupe
  const seen = new Set();
  return launches.filter(l => {
    if (seen.has(l.token)) return false;
    seen.add(l.token);
    return true;
  });
}

async function getLP(poolIds) {
  if (poolIds.length === 0) return {};
  const query = `
    {
      EVM(network: robinhood) {
        DEXPoolEvents(
          limit: {count: 4000}
          orderBy: {descending: Block_Time}
          where: {
            PoolEvent: {Pool: {PoolId: {in: ${JSON.stringify(poolIds)}}}}
          }
        ) {
          PoolEvent {
            Pool { PoolId }
            Liquidity { AmountCurrencyAInUSD }
          }
        }
      }
    }
  `;
  const data = await bitqueryFetch(query);
  const map = {};
  for (const row of data.EVM.DEXPoolEvents || []) {
    const id = row.PoolEvent.Pool.PoolId.toLowerCase();
    if (!map[id]) {
      const eth = parseFloat(row.PoolEvent.Liquidity.AmountCurrencyAInUSD || 0);
      map[id] = eth * 2;
    }
  }
  return map;
}

async function getSymbols(tokens) {
  if (tokens.length === 0) return {};
  const query = `
    {
      EVM(network: robinhood) {
        Transfers(
          limit: {count: ${Math.min(tokens.length * 3, 500)}}
          where: {
            Transfer: {
              Sender: {is: "0x0000000000000000000000000000000000000000"}
              Currency: {SmartContract: {in: ${JSON.stringify(tokens)}}}
            }
          }
        ) {
          Transfer {
            Currency { SmartContract Symbol Name }
          }
        }
      }
    }
  `;
  const data = await bitqueryFetch(query);
  const map = {};
  for (const row of data.EVM.Transfers || []) {
    const c = row.Transfer.Currency;
    if (c?.SmartContract) {
      map[c.SmartContract.toLowerCase()] = {
        symbol: c.Symbol || "???",
        name: c.Name || ""
      };
    }
  }
  return map;
}

async function loadHistory() {
  try {
    return JSON.parse(await fs.readFile(HISTORY_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function closest(entries, target) {
  let best = null, bestDiff = Infinity;
  for (const e of entries) {
    const d = Math.abs(e.ts - target);
    if (d < bestDiff) { bestDiff = d; best = e; }
  }
  return best;
}

async function main() {
  console.log("Fetching pools.trade launches...");
  const launches = await getLaunches();
  console.log(`Got ${launches.length} unique tokens`);

  const lpMap = await getLP(launches.map(l => l.poolId));

  let candidates = launches.map(l => ({
    token: l.token,
    poolId: l.poolId,
    lp_usd: lpMap[l.poolId] || 0
  })).filter(t => t.lp_usd > 20);

  // Also keep previously seen tokens that still have decent LP
  const history = await loadHistory();
  const prevTokens = [...new Set(history.map(h => h.token))];
  const missing = prevTokens.filter(t => !candidates.find(c => c.token === t));
  if (missing.length) {
    console.log(`Checking ${missing.length} previously tracked tokens...`);
    // We don't have their poolId easily, so we skip re-query for now
    // (can improve later)
  }

  candidates.sort((a, b) => b.lp_usd - a.lp_usd);
  candidates = candidates.slice(0, TOP_N);

  const symbols = await getSymbols(candidates.map(c => c.token));
  candidates = candidates.map(c => ({
    ...c,
    symbol: symbols[c.token]?.symbol || c.token.slice(0, 6),
    name: symbols[c.token]?.name || ""
  }));

  const now = Date.now();
  for (const t of candidates) {
    history.push({ token: t.token, ts: now, lp_usd: t.lp_usd });
  }
  if (history.length > 50000) history.splice(0, history.length - 40000);

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));

  const DAY = 86400000;
  const output = candidates.map(t => {
    const th = history.filter(h => h.token === t.token);
    const genesis = th.length ? th.reduce((a, b) => a.ts < b.ts ? a : b) : null;
    const d1 = closest(th, now - DAY);
    const d7 = closest(th, now - 7 * DAY);
    const d30 = closest(th, now - 30 * DAY);

    const ch = (p) => p && p.lp_usd > 0
      ? { usd: +(t.lp_usd - p.lp_usd).toFixed(2), pct: +(((t.lp_usd - p.lp_usd) / p.lp_usd) * 100).toFixed(1) }
      : null;

    return {
      token: t.token,
      symbol: t.symbol,
      name: t.name,
      current_lp_usd: +t.lp_usd.toFixed(2),
      genesis_lp_usd: genesis ? +genesis.lp_usd.toFixed(2) : null,
      genesis_ts: genesis?.ts || null,
      change_24h: ch(d1),
      change_7d: ch(d7),
      change_30d: ch(d30)
    };
  });

  await fs.writeFile(OUTPUT_PATH, JSON.stringify({ updated: now, tokens: output }, null, 2));
  console.log(`Done. Tracked ${output.length} pools.trade tokens.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
