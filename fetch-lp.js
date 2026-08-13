// fetch-lp.js
import fs from "fs/promises";

const API_KEY = process.env.BITQUERY_API_KEY;
const LAUNCHPADS = [
  "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
  "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
  "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2",
  "0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491",
];
const HISTORY_PATH = "data/history.json";
const KNOWN_PATH = "data/known.json";
const OUTPUT_PATH = "data.json";
const TOP_N = 100;

async function bitqueryFetch(query) {
  const res = await fetch("https://streaming.bitquery.io/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error(JSON.stringify(json.errors, null, 2));
    throw new Error("Bitquery error");
  }
  return json.data;
}

async function loadKnown() {
  try {
    return JSON.parse(await fs.readFile(KNOWN_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function loadHistory() {
  try {
    return JSON.parse(await fs.readFile(HISTORY_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function getRecentLaunches() {
  const query = `
  {
    EVM(network: robinhood) {
      Events(
        limit: {count: 1500}
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
  }`;
  const data = await bitqueryFetch(query);
  const map = new Map();
  for (const ev of data.EVM.Events) {
    let token = null, poolId = null;
    for (const a of ev.Arguments) {
      if (a.Name === "token" && a.Value?.address) token = a.Value.address.toLowerCase();
      if (a.Name === "poolId" && a.Value?.hex) poolId = ("0x" + a.Value.hex).toLowerCase();
    }
    if (token && poolId) map.set(token, { token, poolId });
  }
  return [...map.values()];
}

async function getTopLPPools() {
  const query = `
  {
    EVM(network: robinhood, dataset: realtime) {
      DEXPoolEvents(
        where: {
          PoolEvent: {
            Liquidity: { AmountCurrencyAInUSD: { gt: 20 } }
          }
        }
        limit: { count: 500 }
        limitBy: { by: [PoolEvent_Pool_PoolId], count: 1 }
        orderBy: { descending: PoolEvent_Liquidity_AmountCurrencyAInUSD }
      ) {
        PoolEvent {
          Liquidity {
            AmountCurrencyAInUSD
            AmountCurrencyBInUSD
          }
          Pool {
            PoolId
            CurrencyA { SmartContract Symbol }
            CurrencyB { SmartContract Symbol }
          }
        }
      }
    }
  }`;
  const data = await bitqueryFetch(query);
  return data.EVM.DEXPoolEvents.map(e => {
    const a = Number(e.PoolEvent.Liquidity.AmountCurrencyAInUSD || 0);
    const b = Number(e.PoolEvent.Liquidity.AmountCurrencyBInUSD || 0);
    const lp = b > 0 ? a + b : a * 2;
    return {
      poolId: (e.PoolEvent.Pool.PoolId || "").toLowerCase(),
      lp_usd: lp,
      currencyA: e.PoolEvent.Pool.CurrencyA?.SmartContract?.toLowerCase(),
      currencyB: e.PoolEvent.Pool.CurrencyB?.SmartContract?.toLowerCase(),
    };
  });
}

async function getSymbols(tokens) {
  if (tokens.length === 0) return {};
  const query = `
  {
    EVM(network: robinhood) {
      Transfers(
        limit: {count: ${Math.min(tokens.length * 3, 300)}}
        where: {
          Transfer: {
            Currency: {SmartContract: {in: ${JSON.stringify(tokens)}}}
            Sender: {is: "0x0000000000000000000000000000000000000000"}
          }
        }
      ) {
        Transfer {
          Currency {
            SmartContract
            Symbol
            Name
          }
        }
      }
    }
  }`;
  const data = await bitqueryFetch(query);
  const map = {};
  for (const t of data.EVM.Transfers) {
    const c = t.Transfer.Currency;
    if (c?.SmartContract) {
      map[c.SmartContract.toLowerCase()] = {
        symbol: c.Symbol || "???",
        name: c.Name || "",
      };
    }
  }
  return map;
}

function closest(history, targetTs) {
  if (!history.length) return null;
  return history.reduce((best, h) =>
    Math.abs(h.ts - targetTs) < Math.abs(best.ts - targetTs) ? h : best
  );
}

async function main() {
  console.log("Loading known tokens...");
  let known = await loadKnown();
  const knownByPool = new Map(known.map(k => [k.poolId.toLowerCase(), k]));
  const knownByToken = new Map(known.map(k => [k.token.toLowerCase(), k]));

  console.log("Fetching new launches...");
  const launches = await getRecentLaunches();
  console.log("New launches found:", launches.length);
  for (const l of launches) {
    knownByPool.set(l.poolId.toLowerCase(), l);
    knownByToken.set(l.token.toLowerCase(), l);
  }
  known = [...knownByToken.values()];
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(KNOWN_PATH, JSON.stringify(known));

  console.log("Fetching top LP pools from Bitquery...");
  const topPools = await getTopLPPools();
  console.log("Got", topPools.length, "high-LP pools");
  console.log("Sample top poolIds:", topPools.slice(0, 5).map(p => p.poolId));
  console.log("Sample known poolIds:", [...knownByPool.keys()].slice(0, 5));

  let matches = 0;
  for (const p of topPools.slice(0, 100)) {
    if (knownByPool.has(p.poolId)) matches++;
  }
  console.log("Matches in top 100 high-LP pools:", matches);

  const ranked = [];
  for (const p of topPools) {
    const knownEntry = knownByPool.get(p.poolId);
    if (!knownEntry) continue;
    ranked.push({
      token: knownEntry.token.toLowerCase(),
      poolId: p.poolId,
      lp_usd: p.lp_usd,
    });
    if (ranked.length >= TOP_N) break;
  }

  console.log("Ranked", ranked.length, "pools.trade tokens");

  const symbols = await getSymbols(ranked.map(t => t.token));
  const history = await loadHistory();
  const now = Date.now();

  for (const t of ranked) {
    history.push({ token: t.token, ts: now, lp_usd: t.lp_usd });
  }
  const trimmed = history.filter(h => now - h.ts < 40 * 24 * 60 * 60 * 1000);
  await fs.writeFile(HISTORY_PATH, JSON.stringify(trimmed));

  const DAY = 24 * 60 * 60 * 1000;
  const output = ranked.map(t => {
    const tokenHist = trimmed.filter(h => h.token === t.token);
    const genesis = tokenHist.length
      ? tokenHist.reduce((a, b) => (a.ts < b.ts ? a : b))
      : { lp_usd: t.lp_usd, ts: now };
    const d1 = closest(tokenHist, now - DAY);
    const d7 = closest(tokenHist, now - 7 * DAY);
    const d30 = closest(tokenHist, now - 30 * DAY);

    const change = (past) =>
      past
        ? {
            usd: +(t.lp_usd - past.lp_usd).toFixed(2),
            pct: +(((t.lp_usd - past.lp_usd) / (past.lp_usd || 1)) * 100).toFixed(1),
          }
        : { usd: 0, pct: 0 };

    const meta = symbols[t.token] || { symbol: "???", name: "" };

    return {
      token: t.token,
      symbol: meta.symbol,
      name: meta.name,
      current_lp_usd: +t.lp_usd.toFixed(2),
      genesis_lp_usd: +genesis.lp_usd.toFixed(2),
      genesis_ts: genesis.ts,
      change_24h: change(d1),
      change_7d: change(d7),
      change_30d: change(d30),
    };
  });

  await fs.writeFile(
    OUTPUT_PATH,
    JSON.stringify({ updated: now, tokens: output }, null, 2)
  );
  console.log(`Done. Tracked ${output.length} tokens. Known total: ${known.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
