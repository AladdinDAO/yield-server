const sdk = require('@defillama/sdk');
const { request, gql } = require('graphql-request');
const utils = require('../utils');

// Supported chains and their subgraph endpoints
const chains = {
  ethereum: sdk.graph.modifyEndpoint('x6qJPkv7FaCWkfcjDWx12Z2NEfsvCCwuy87vQzk9zRh'),
};

// GraphQL query to get current pool metrics
const query = gql`
  query GetPoolMetrics($block: Block_height) {
    groupPoolMetrics(first: 1000, block: $block) {
      id
      group_pool_address
      principal_token_address
      collateral_token_address
      shares_token_address
      market_id
      total_principal_tokens_committed
      total_principal_tokens_withdrawn
      total_principal_tokens_borrowed
      total_interest_collected 
      token_difference_from_liquidations
      total_principal_tokens_repaid
      total_collateral_tokens_escrowed
      total_collateral_withdrawn
      interest_rate_upper_bound
      interest_rate_lower_bound
      liquidity_threshold_percent
      collateral_ratio
    }
  }
`;

// Fetch token info (symbols and decimals)
const fetchTokenInfo = async (tokenAddresses, chainString) => {
  const tokens = {};
  for (const address of tokenAddresses) {
    try {
      const tokenInfo = await sdk.api.erc20.info(address, chainString);
      tokens[address.toLowerCase()] = {
        symbol: tokenInfo.output.symbol,
        decimals: parseInt(tokenInfo.output.decimals) || 18,
      };
    } catch (error) {
      tokens[address.toLowerCase()] = { symbol: 'UNKNOWN', decimals: 18 };
    }
  }
  return tokens;
};

const topLvl = async (chainString, url, query, timestamp) => {
  // Get the current block and calculate block number minus 30 incase indexer delayed
  const [block] = await utils.getBlocks(chainString, timestamp, [url]);
  const blockMinus30 = block ? { number: parseInt(block) - 30 } : null;

  // Fetch pool data from blockMinus30
  let dataNow = await request(url, query, { block: blockMinus30 });
  dataNow = dataNow.groupPoolMetrics;

  // Get unique token addresses from all pools
  const tokenAddresses = new Set();
  dataNow.forEach(pool => {
    tokenAddresses.add(pool.principal_token_address);
    tokenAddresses.add(pool.collateral_token_address);
  });

  // Fetch token info (symbols and decimals)
  const tokenInfo = await fetchTokenInfo(Array.from(tokenAddresses), chainString);

  // Enrich pool data with calculated metrics
  const enrichedData = await Promise.all(
    dataNow.map(async (pool) => {
      const { pricesByAddress } = await utils.getPrices(
        [pool.principal_token_address, pool.collateral_token_address],
        chainString
      );

      const principalTokenDecimals = tokenInfo[pool.principal_token_address.toLowerCase()]?.decimals || 18;
      const principalTokenDivisor = 10 ** principalTokenDecimals;

      const collateralTokenDecimals = tokenInfo[pool.collateral_token_address.toLowerCase()]?.decimals || 18;
      const collateralTokenDivisor = 10 ** collateralTokenDecimals;

      const totalInterestCollected = parseInt(pool.total_interest_collected);
      const tokenDifferenceFromLiquidatons = parseInt(pool.token_difference_from_liquidations);
      const totalCollateralEscrowedNet = parseInt(pool.total_collateral_tokens_escrowed) - parseInt(pool.total_collateral_withdrawn);

      const totalCollateralUsd =
        totalCollateralEscrowedNet *
        (parseFloat(pricesByAddress[pool.collateral_token_address.toLowerCase()] || 0) / collateralTokenDivisor);

      const totalTokensActivelyBorrowed =
        parseInt(pool.total_principal_tokens_borrowed) - parseInt(pool.total_principal_tokens_repaid);
      const totalTokensActivelyCommitted =
        parseInt(pool.total_principal_tokens_committed) +
        totalInterestCollected +
        tokenDifferenceFromLiquidatons -
        parseInt(pool.total_principal_tokens_withdrawn);

      const totalCommitted = parseInt(totalTokensActivelyCommitted);
      const totalBorrowed = parseInt(totalTokensActivelyBorrowed);

      const totalSupplyUsd =
        totalCommitted *
        (parseFloat(pricesByAddress[pool.principal_token_address.toLowerCase()] || 0) / principalTokenDivisor);

      const totalBorrowUsd =
        totalBorrowed *
        (parseFloat(pricesByAddress[pool.principal_token_address.toLowerCase()] || 0) / principalTokenDivisor);

      const tvlUsd = totalSupplyUsd - totalBorrowUsd;
      const poolBorrowedPercent = totalCommitted > 0 ? Math.min(Math.max(totalBorrowed / totalCommitted, 0), 1) : 0;

      const interestRateLowerBound = parseInt(pool.interest_rate_lower_bound) || 500;
      const interestRateUpperBound = parseInt(pool.interest_rate_upper_bound) || 1500;

      const apyBase = calculateActiveLenderYield(poolBorrowedPercent, interestRateLowerBound, interestRateUpperBound);
      const ltv = 100.0 / (parseInt(pool.collateral_ratio) / 100.0);
      const borrowApy = calculateActiveBorrowerYield(poolBorrowedPercent, interestRateLowerBound, interestRateUpperBound);

      const principalSymbol = tokenInfo[pool.principal_token_address.toLowerCase()]?.symbol || 'UNKNOWN';
      const collateralSymbol = tokenInfo[pool.collateral_token_address.toLowerCase()]?.symbol || 'UNKNOWN';

      console.log(`Token decimals for pool ${pool.group_pool_address}: Principal=${principalTokenDecimals}, Collateral=${collateralTokenDecimals}`);

      return {
        ...pool,
        tvlUsd,
        apyBase,
        totalSupplyUsd,
        totalBorrowUsd,
        ltv,
        borrowApy,
        principalSymbol,
        collateralSymbol,
        principalTokenDecimals,
        collateralTokenDecimals,
        totalCollateralUsd,
      };
    })
  );

  // For each enriched pool, create separate lending and collateral pool objects
  return enrichedData.flatMap((p) => {
    const underlyingTokens = [p.principal_token_address, p.collateral_token_address];
    const chain = chainString === 'ethereum' ? 'mainnet' : chainString;
    const url = `https://app.teller.org/${chainString}/lend/pool/${p.group_pool_address}`;

    const lendingPool = {
      pool: p.group_pool_address,
      chain: utils.formatChain(chainString),
      project: 'teller',
      symbol: p.principalSymbol,
      tvlUsd: p.totalSupplyUsd,
      apyBase: p.apyBase,
      underlyingTokens,
      url,
    };

    const collateralPool = {
      pool: p.group_pool_address,
      chain: utils.formatChain(chainString),
      project: 'teller',
      symbol: p.collateralSymbol,
      mintedCoin: p.principalSymbol,
      tvlUsd: p.totalCollateralUsd,
      totalSupplyUsd: p.totalCollateralUsd,
      totalBorrowUsd: p.totalBorrowUsd,
      apyBaseBorrow: p.borrowApy,
      apyBase: 0,
      underlyingTokens,
      url,
    };

    return [lendingPool, collateralPool];
  });
};

// Calculate active yield for lenders
const calculateActiveLenderYield = (poolBorrowedPercent, interestRateLowerBound, interestRateUpperBound) => {
  let poolYieldRaw;
  if (poolBorrowedPercent === 0) {
    poolYieldRaw = interestRateLowerBound;
  } else if (poolBorrowedPercent === 1) {
    poolYieldRaw = interestRateUpperBound;
  } else {
    const range = interestRateUpperBound - interestRateLowerBound;
    poolYieldRaw = interestRateLowerBound + (poolBorrowedPercent * range);
  }
  return (poolYieldRaw / 100) * poolBorrowedPercent;
};

// Calculate active yield for borrowers
const calculateActiveBorrowerYield = (poolBorrowedPercent, interestRateLowerBound, interestRateUpperBound) => {
  let poolYieldRaw;
  if (poolBorrowedPercent === 0) {
    poolYieldRaw = interestRateLowerBound;
  } else if (poolBorrowedPercent === 1) {
    poolYieldRaw = interestRateUpperBound;
  } else {
    const range = interestRateUpperBound - interestRateLowerBound;
    poolYieldRaw = interestRateLowerBound + (poolBorrowedPercent * range);
  }
  return poolYieldRaw / 100;
};

const main = async (timestamp = null) => {
  let data = [];
  for (const [chain, url] of Object.entries(chains)) {
    try {
      console.log(`Fetching data for ${chain}...`);
      const chainData = await topLvl(chain, url, query, timestamp);
      console.log("chainData", chainData);
      data.push(...chainData);
    } catch (err) {
      console.log(chain, err);
    }
  }
  const filteredData = data.filter((p) => utils.keepFinite(p));
  return filteredData;
};

module.exports = {
  timetravel: false,
  apy: main,
};
