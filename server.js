const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { formatUnits, getAddress, isAddress, verifyMessage } = require("ethers");
const TronWebImport = require("tronweb");
const TronWeb = TronWebImport.TronWeb || TronWebImport.default || TronWebImport;

const root = __dirname;
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "aml-best.sqlite");
const port = Number(process.env.PORT || 3000);
const tronFullHost = String(process.env.TRON_FULL_HOST || "https://api.trongrid.io").replace(/\/$/, "");
const tronProApiKey = String(process.env.TRON_PRO_API_KEY || "").trim();
const tronWeb = new TronWeb({ fullHost: tronFullHost });
if (tronProApiKey && typeof tronWeb.setHeader === "function") {
  tronWeb.setHeader({ "TRON-PRO-API-KEY": tronProApiKey });
}
const tronUsdtContract = process.env.TRON_USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const tronUsdtDecimals = 6;
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

const normalizeWalletAddress = (address, chain = "evm") => {
  if (chain === "tron") {
    const normalized = String(address || "").trim();
    if (!isTronAddress(normalized)) throw new Error("Некорректный TRON адрес");
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

const getNonZeroNativeBalances = async (address, preferredChainIdValue) => {
  const preferredChainId = parseChainId(preferredChainIdValue);
  const results = await Promise.all(
    Object.keys(balanceNetworks).map((chainId) => getNativeBalance(address, Number(chainId))),
  );
  const successful = results.filter((result) => result.ok);
  const balances = successful
    .filter((result) => result.wei > 0n)
    .sort((left, right) => {
      if (left.chainId === preferredChainId) return -1;
      if (right.chainId === preferredChainId) return 1;
      return left.chainId - right.chainId;
    });

  return {
    balances,
    checkedCount: successful.length,
    failedCount: results.length - successful.length,
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
  `);

  const checkColumns = database.prepare("PRAGMA table_info(checks)").all().map((column) => column.name);
  if (!checkColumns.includes("user_wallet")) database.exec("ALTER TABLE checks ADD COLUMN user_wallet TEXT");
  if (!checkColumns.includes("tx_hash")) database.exec("ALTER TABLE checks ADD COLUMN tx_hash TEXT");
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
    origin && (allowedOrigins.includes(origin) || /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin))
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

  return session;
};

const createUserSession = (address) => {
  const token = crypto.randomBytes(32).toString("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
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

const sendTelegramMessage = async (chatId, text) => {
  const chunks = String(text).match(/[\s\S]{1,3900}/g) || [""];
  for (const chunk of chunks) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
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
  const message = update.message;
  if (!message?.chat?.id || !message.text) return;

  const chatId = String(message.chat.id);
  const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/myid") {
    await sendTelegramMessage(chatId, `Ваш Telegram chat ID: ${chatId}`);
    return;
  }

  if (!telegramAdminIds.has(chatId)) {
    await sendTelegramMessage(chatId, "Доступ запрещён. Этот Telegram ID не добавлен в список администраторов.");
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
      allowed_updates: ["message"],
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
        allowed_updates: ["message"],
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


  if (request.method === "POST" && pathname === "/api/tron/usdt-balance") {
    const { address } = await readBody(request);
    const normalized = String(address || "").trim();

    if (!isTronAddress(normalized)) {
      return sendJson(request, response, 400, { error: "Некорректный TRON адрес. Он должен начинаться с T." });
    }

    const usdtBalance = await getTronUsdtBalance(normalized);
    if (!usdtBalance.ok) {
      return sendJson(request, response, 502, {
        error: "Не удалось получить TRON USDT TRC20 баланс",
        details: usdtBalance.error,
      });
    }

    const session = getUserSession(request);
    const telegramNotifications = await notifyTelegramAdmins(
      [
        "Публичная проверка TRON USDT TRC20",
        "",
        `TRON адрес: ${normalized}`,
        `Баланс: ${usdtBalance.balance} USDT`,
        session?.address ? `EVM пользователь: ${session.address}` : "EVM пользователь: не подключён",
        `Время: ${formatDate(nowIso())}`,
      ].join("\n"),
    );

    return sendJson(request, response, 200, {
      ok: true,
      chain: "tron",
      network: usdtBalance.network,
      token: "USDT_TRC20",
      contract: usdtBalance.contract,
      address: normalized,
      balance: usdtBalance.balance,
      rawBalance: usdtBalance.rawBalance.toString(),
      telegramNotifications,
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/wallet") {
    const { address, signature, nonce, chainId } = await readBody(request);
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
    let balanceLines = [];
    let balancesFound = 0;

    const balanceScan = await getNonZeroNativeBalances(normalized, chainId);
    balancesFound = balanceScan.balances.length;
    balanceLines = balanceScan.balances.length
      ? [
          "Ненулевые нативные балансы:",
          ...balanceScan.balances.map(
            (balance) =>
              `${balance.network} (${balance.chainId}): ${balance.balance} ${balance.symbol}`,
          ),
        ]
      : [
          balanceScan.checkedCount
            ? "Ненулевые нативные балансы в поддерживаемых сетях не найдены."
            : "Не удалось получить балансы из поддерживаемых сетей.",
        ];

    const telegramNotifications = await notifyTelegramAdmins(
      [
        `Новый вход Ethereum/EVM кошелька`,
        "",
        `Адрес: ${normalized}`,
        requestedAddress && requestedAddress.toLowerCase() !== normalized.toLowerCase()
          ? `Адрес из provider отличался: ${requestedAddress}`
          : "",
        ...balanceLines,
        `Время: ${formatDate(nowIso())}`,
      ].filter(Boolean).join("\n"),
    );
    return sendJson(request, response, 200, {
      ok: true,
      chain: walletChain,
      address: normalized,
      requestedAddress,
      role: "user",
      telegramNotifications,
      balancesFound,
      nativeBalances: balanceScan.balances.map((item) => ({
        chainId: item.chainId,
        network: item.network,
        balance: item.balance,
        symbol: item.symbol,
      })),
      tokenBalances: [],
      ...session,
    });
  }

  if (request.method === "GET" && pathname === "/api/auth/session") {
    const session = getUserSession(request);
    if (!session) return sendJson(request, response, 401, { error: "Пользователь не подключён" });
    return sendJson(request, response, 200, { ok: true, address: session.address, role: "user" });
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
