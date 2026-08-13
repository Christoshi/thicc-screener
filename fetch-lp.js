import fs from "fs/promises";

const API_KEY = process.env.BITQUERY_API_KEY;

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
  console.log(JSON.stringify(json, null, 2));
  return json;
}

// Testing one known poolId from the previous log
const testPoolId = "8c4e99faf82381b202750311901f00b30f4e14296174556c5ca76a5e12f3396b";

const query = `
{
  EVM(network: robinhood) {
    DEXPoolEvents(
      limit: {count: 5}
      orderBy: {descending: Block_Time}
      where: {
        PoolEvent: {Pool: {PoolId: {is: "${testPoolId}"}}}
      }
    ) {
      Block { Time }
      PoolEvent {
        Pool { PoolId }
        Liquidity {
          AmountCurrencyAInUSD
          AmountCurrencyBInUSD
        }
      }
    }
  }
}
`;

bitqueryFetch(query);
