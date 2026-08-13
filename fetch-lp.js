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
const TOP_N = 1000;          // top 1000 by LP
const CHUNK_SIZE = 150;

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

async function getLPForPools(poolIds) {
  const result = {};
  for (let i = 0; i < poolIds.length; i += CHUNK_SIZE) {
    const chunk = poolIds.slice(i, i + CHUNK_SIZE);
    console.log(`  querying chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} pools)...`);
    const query = `
    {
      EVM(network: robinhood) {
        DEXPoolEvents(
          limit: {count: ${CHUNK_SIZE * 2}}
          orderBy: {descending: Block_Time}
          where: {
            PoolEvent: {Pool: {PoolId: {in: ${JSON.stringify(chunk)}}}}
          }
        ) {
          PoolEvent {
            Liquidity {
              AmountCurrencyAInUSD
              AmountCurrencyBInUSD
            }
            Pool { PoolId }
          }
        }
      }
    }`;
    const data = await bitqueryFetch(query);
    for (const e of data.EVM.DEXPoolEvents) {
      const id = (e.PoolEvent.Pool.PoolId || "").toLowerCase();
      if (result[id]) continue;
      const a = Number(e.PoolEvent.Liquidity.AmountCurrencyAInUSD || 0);
      const b = Number(e.PoolEvent.Liquidity.AmountCurrencyBInUSD || 0);
      result[id] = b > 0 ? a + b : a * 2;
    }
  }
  return result;
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
  const knownByToken = new Map(known.map(k => [k.token.toLowerCase(), k]));

  console.log("Fetching new launches...");
  const launches = await getRecentLaunches();
  console.log("New launches found:", launches.length);
  for (const l of launches) {
    knownByToken.set(l.token.toLowerCase(), l);
  }
  known = [...knownByToken.values()];
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(KNOWN_PATH, JSON.stringify(known));
  console.log("Known total (all pools.trade):", known.length);

  // Query LP for ALL pools.trade pools
  const poolIds = known.map(k => k.poolId.toLowerCase());
  console.log("Querying LP for ALL", poolIds.length, "pools.trade pools...");
  const lpMap = await getLPForPools(poolIds);

  const ranked = known
    .map(k => ({
      token: k.token.toLowerCase(),
      poolId: k.poolId.toLowerCase(),
      lp_usd: lpMap[k.poolId.toLowerCase()] || 0,
    }))
    .filter(t => t.lp_usd > 5)
    .sort((a, b) => b.lp_usd - a.lp_usd)
    .slice(0, TOP_N);

  console.log("Ranked top", ranked.length, "by LP");
  if (ranked.length) {
    console.log("Highest LP:", ranked[0].lp_usd.toFixed(0));
    console.log("Top 5:", ranked.slice(0, 5).map(r => r.lp_usd.toFixed(0)));
  }

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
