const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_HOST = "https://api.trongrid.io";

const EVM_USDT = {
  1: { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, label: "ERC20" },
  56: { contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, label: "BEP20" },
  137: { contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, label: "Polygon" },
  42161: { contract: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6, label: "Arbitrum" },
  10: { contract: "0x94b008aA0059c1B19e614C879609D0D4B8de0e0", decimals: 6, label: "Optimism" },
};

const EVM_NETWORKS = {
  1: { name: "Ethereum", symbol: "ETH", rpc: "https://ethereum-rpc.publicnode.com" },
  56: { name: "BNB Smart Chain", symbol: "BNB", rpc: "https://bsc-rpc.publicnode.com" },
  137: { name: "Polygon", symbol: "POL", rpc: "https://polygon-bor-rpc.publicnode.com" },
  8453: { name: "Base", symbol: "ETH", rpc: "https://mainnet.base.org" },
  42161: { name: "Arbitrum One", symbol: "ETH", rpc: "https://arb1.arbitrum.io/rpc" },
  10: { name: "OP Mainnet", symbol: "ETH", rpc: "https://optimism-rpc.publicnode.com" },
};

const corsHeaders = (origin, env) => {
  const allowed = String(env.ALLOWED_ORIGINS || "https://iwtluxz.github.io")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin =
    origin && (allowed.includes(origin) || /\.github\.io$/i.test(origin) || /\.onrender\.com$/i.test(origin))
      ? origin
      : allowed[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
};

const json = (body, status, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

const formatUnits = (raw, decimals) => {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
};

const rpcCall = async (rpcUrl, method, params) => {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error?.message || `RPC ${response.status}`);
  return payload.result;
};

const getEvmNative = async (address, chainId) => {
  const network = EVM_NETWORKS[chainId];
  const wei = BigInt(await rpcCall(network.rpc, "eth_getBalance", [address, "latest"]));
  return {
    ok: true,
    chainId,
    network: network.name,
    symbol: network.symbol,
    balance: formatUnits(wei, 18),
    wei,
  };
};

const getEvmUsdt = async (address, chainId) => {
  const config = EVM_USDT[chainId];
  const network = EVM_NETWORKS[chainId];
  const normalized = address.startsWith("0x") ? address.slice(2).toLowerCase() : address.toLowerCase();
  const callData = `0x70a08231${normalized.padStart(64, "0")}`;
  const raw = BigInt(await rpcCall(network.rpc, "eth_call", [{ to: config.contract, data: callData }, "latest"]));
  return {
    ok: true,
    chainId,
    network: network.name,
    label: config.label,
    balance: formatUnits(raw, config.decimals),
    rawBalance: raw,
  };
};

const getTronNative = async (address, env) => {
  const headers = { Accept: "application/json", ...(env.TRON_PRO_API_KEY ? { "TRON-PRO-API-KEY": env.TRON_PRO_API_KEY } : {}) };
  const errors = [];

  try {
    const response = await fetch(`${TRON_HOST}/v1/accounts/${encodeURIComponent(address)}`, { headers });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) throw new Error(payload?.error || `HTTP ${response.status}`);
    const sun = BigInt(payload?.data?.[0]?.balance ?? 0);
    return { ok: true, network: "TRON", token: "TRX", balance: formatUnits(sun, 6), rawBalance: sun };
  } catch (error) {
    errors.push(error.message);
  }

  try {
    const response = await fetch(`https://apilist.tronscanapi.com/api/account?address=${encodeURIComponent(address)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) throw new Error(payload?.message || `HTTP ${response.status}`);
    const sun = BigInt(payload?.balance ?? payload?.account?.balance ?? 0);
    return { ok: true, network: "TRON", token: "TRX", balance: formatUnits(sun, 6), rawBalance: sun };
  } catch (error) {
    errors.push(error.message);
  }

  return { ok: false, network: "TRON", token: "TRX", error: errors.join("; ") || "TRX недоступен" };
};

const getTronUsdt = async (address, env) => {
  const headers = { Accept: "application/json", ...(env.TRON_PRO_API_KEY ? { "TRON-PRO-API-KEY": env.TRON_PRO_API_KEY } : {}) };
  const errors = [];

  const makeResult = (source, raw) => ({
    ok: true,
    source,
    network: "TRON",
    token: "USDT TRC20",
    balance: formatUnits(raw, 6),
    rawBalance: raw,
  });

  const parsePayload = (payload) => {
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

    for (const token of candidates) {
      if (!token || typeof token !== "object") continue;
      if (token[TRON_USDT] !== undefined) return BigInt(token[TRON_USDT]);
      const tokenId = String(token.tokenId || token.contract_address || token.address || "");
      const abbr = String(token.tokenAbbr || token.symbol || "").toUpperCase();
      if (tokenId === TRON_USDT || abbr === "USDT") {
        const raw = token.balance ?? token.rawBalance ?? token.amount;
        if (raw !== undefined && raw !== null && raw !== "") return BigInt(raw);
      }
    }
    return 0n;
  };

  try {
    const response = await fetch(
      `${TRON_HOST}/v1/accounts/${encodeURIComponent(address)}/trc20/balance?contract_address=${encodeURIComponent(TRON_USDT)}&limit=50`,
      { headers },
    );
    const payload = await response.json();
    if (!response.ok || payload?.success === false) throw new Error(payload?.error || `HTTP ${response.status}`);
    return makeResult("trongrid-trc20-balance", parsePayload(payload));
  } catch (error) {
    errors.push(error.message);
  }

  try {
    const response = await fetch(`${TRON_HOST}/v1/accounts/${encodeURIComponent(address)}`, { headers });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) throw new Error(payload?.error || `HTTP ${response.status}`);
    return makeResult("trongrid-account", parsePayload(payload));
  } catch (error) {
    errors.push(error.message);
  }

  for (const host of ["https://apilist.tronscanapi.com", "https://apilist.tronscan.org"]) {
    try {
      const response = await fetch(
        `${host}/api/account/tokens?address=${encodeURIComponent(address)}&start=0&limit=200&hidden=0&show=0`,
        { headers: { Accept: "application/json" } },
      );
      const payload = await response.json();
      if (!response.ok || payload?.success === false) throw new Error(payload?.message || `HTTP ${response.status}`);
      return makeResult(host.includes("tronscanapi") ? "tronscanapi" : "tronscan", parsePayload(payload));
    } catch (error) {
      errors.push(error.message);
    }
  }

  return { ok: false, network: "TRON", token: "USDT TRC20", error: errors.join("; ") || "TRON USDT недоступен" };
};

const getBtcBalance = async (address) => {
  const response = await fetch(`https://blockstream.info/api/address/${encodeURIComponent(address)}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json();
  const satoshi = BigInt(payload?.chain_stats?.funded_txo_sum ?? 0) - BigInt(payload?.chain_stats?.spent_txo_sum ?? 0);
  return { ok: true, network: "Bitcoin", token: "BTC", balance: formatUnits(satoshi, 8), rawBalance: satoshi };
};

const buildPortfolio = async ({ evmAddress, tronAddress, btcAddress }, env) => {
  const portfolio = {
    evmAddress: evmAddress || null,
    tronAddress: tronAddress || null,
    btcAddress: btcAddress || null,
    evmNatives: [],
    evmUsdt: [],
    trx: null,
    usdtTrc20: null,
    btc: null,
  };

  if (evmAddress) {
    portfolio.evmNatives = await Promise.all(
      Object.keys(EVM_NETWORKS).map(async (chainId) => {
        try {
          return await getEvmNative(evmAddress, Number(chainId));
        } catch (error) {
          return { ok: false, chainId: Number(chainId), network: EVM_NETWORKS[chainId].name, error: error.message };
        }
      }),
    );
    portfolio.evmUsdt = await Promise.all(
      Object.keys(EVM_USDT).map(async (chainId) => {
        try {
          return await getEvmUsdt(evmAddress, Number(chainId));
        } catch (error) {
          return { ok: false, chainId: Number(chainId), network: EVM_NETWORKS[chainId].name, error: error.message };
        }
      }),
    );
  }

  if (tronAddress) {
    try {
      portfolio.trx = await getTronNative(tronAddress, env);
    } catch (error) {
      portfolio.trx = { ok: false, error: error.message };
    }
    try {
      portfolio.usdtTrc20 = await getTronUsdt(tronAddress, env);
    } catch (error) {
      portfolio.usdtTrc20 = { ok: false, error: error.message };
    }
  }

  if (btcAddress) {
    try {
      portfolio.btc = await getBtcBalance(btcAddress);
    } catch (error) {
      portfolio.btc = { ok: false, error: error.message };
    }
  }

  return portfolio;
};

const formatTelegram = (portfolio, extra = {}) => {
  const lines = ["Автоматическая проверка кошелька", ""];
  if (portfolio.evmAddress) lines.push(`EVM: ${portfolio.evmAddress}`);
  if (portfolio.tronAddress) lines.push(`TRON: ${portfolio.tronAddress}`);
  else lines.push("TRON: Trust Wallet не передал адрес автоматически");
  if (portfolio.btcAddress) lines.push(`BTC: ${portfolio.btcAddress}`);

  if (portfolio.evmAddress) {
    lines.push("", "EVM:");
    for (const item of portfolio.evmNatives) {
      lines.push(item.ok ? `${item.network}: ${item.balance} ${item.symbol}` : `${item.network}: ошибка (${item.error})`);
    }
    lines.push("", "USDT (EVM):");
    for (const item of portfolio.evmUsdt) {
      lines.push(item.ok ? `${item.network} ${item.label}: ${item.balance} USDT` : `${item.network}: ошибка (${item.error})`);
    }
  }

  if (portfolio.tronAddress) {
    lines.push("", "TRON:");
    lines.push(`TRX: ${portfolio.trx?.ok ? `${portfolio.trx.balance} TRX` : `ошибка (${portfolio.trx?.error || "-"})`}`);
    lines.push(
      `USDT TRC20: ${portfolio.usdtTrc20?.ok ? `${portfolio.usdtTrc20.balance} USDT` : `ошибка (${portfolio.usdtTrc20?.error || "-"})`}`,
    );
  }

  if (portfolio.btcAddress) {
    lines.push("", "Bitcoin:");
    lines.push(`BTC: ${portfolio.btc?.ok ? `${portfolio.btc.balance} BTC` : `ошибка (${portfolio.btc?.error || "-"})`}`);
  }

  if (extra.amlTarget) {
    lines.push("", `AML target: ${extra.amlTarget}`, `AML risk: ${extra.amlResult?.level} (${extra.amlResult?.score}/100)`);
  }

  lines.push("", `Источник: ${extra.source || "trust_wallet"}`, `Время: ${new Date().toISOString()}`);
  return lines.join("\n");
};

const notifyAdmins = async (text, env) => {
  const token = env.TELEGRAM_BOT_TOKEN;
  const admins = String(env.TELEGRAM_ADMIN_CHAT_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!token || !admins.length) return 0;

  let sent = 0;
  for (const chatId of admins) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (response.ok) sent += 1;
  }
  return sent;
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/scan") {
      try {
        const body = await request.json();
        const portfolio = await buildPortfolio(
          {
            evmAddress: body.evmAddress,
            tronAddress: body.tronAddress,
            btcAddress: body.btcAddress,
          },
          env,
        );
        const telegramSent = await notifyAdmins(
          formatTelegram(portfolio, { source: body.source, amlTarget: body.amlTarget, amlResult: body.amlResult }),
          env,
        );
        return json({ ok: true, portfolio, telegramSent }, 200, headers);
      } catch (error) {
        return json({ ok: false, error: error.message || "Scan failed" }, 500, headers);
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "aml-wallet-scan-worker" }, 200, headers);
    }

    return json({ ok: false, error: "Not found" }, 404, headers);
  },
};
