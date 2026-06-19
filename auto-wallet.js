const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readTronAddress = (value) => {
  const address = String(value || "").trim();
  return address.startsWith("T") && address.length >= 26 ? address : "";
};

const readBtcAddress = (value) => {
  const address = String(value || "").trim();
  return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,87}$/.test(address) ? address : "";
};

const dappMeta = () => ({
  websiteIcon: `${location.origin}/assets/logo-mark.svg`,
  websiteName: document.title || "AML Best",
});

const isTrustWalletEnv = () =>
  Boolean(
    window.trustwallet ||
      window.ethereum?.isTrust ||
      window.ethereum?.providers?.some?.((provider) => provider.isTrust) ||
      /Trust/i.test(navigator.userAgent || ""),
  );

const getTrustEthereumProvider = () => {
  if (window.trustwallet?.ethereum) return window.trustwallet.ethereum;
  if (window.ethereum?.isTrust) return window.ethereum;
  if (window.ethereum?.providers?.length) {
    return window.ethereum.providers.find((provider) => provider.isTrust) || window.ethereum.providers[0];
  }
  return window.ethereum;
};

const getTronLinkRoot = () => window.trustwallet?.tronLink || window.tronLink || window.tron || null;

const getTronWebInstance = () =>
  window.trustwallet?.tronLink?.tronWeb ||
  window.trustwallet?.tronWeb ||
  window.tronWeb ||
  window.tronLink?.tronWeb ||
  window.tron?.tronWeb ||
  null;

const waitForTronWeb = async (timeoutMs = 4000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tronWeb = getTronWebInstance();
    if (tronWeb?.defaultAddress?.base58) {
      const address = readTronAddress(tronWeb.defaultAddress.base58);
      if (address) return address;
    }
    await sleep(250);
  }
  return "";
};

const requestViaProvider = async (provider, method) => {
  if (!provider?.request) return "";
  const params = method === "tron_requestAccounts" ? dappMeta() : undefined;
  const result = await provider.request({ method, ...(params ? { params } : {}) });

  if (Array.isArray(result)) {
    return readTronAddress(result[0]) || readBtcAddress(result[0]);
  }
  if (typeof result === "string") {
    return readTronAddress(result) || readBtcAddress(result);
  }
  if (result?.address) {
    return readTronAddress(result.address) || readBtcAddress(result.address);
  }
  if (result?.code === 200 || result?.message?.includes?.("already")) {
    return "";
  }
  return "";
};

const requestTronAccounts = async () => {
  const tronWeb = getTronWebInstance();
  const tronLink = getTronLinkRoot();
  const targets = [tronLink, window.trustwallet, window.tron, tronWeb].filter(Boolean);
  const methods = ["eth_requestAccounts", "tron_requestAccounts", "requestAccounts"];

  for (const target of targets) {
    for (const method of methods) {
      try {
        const address = await requestViaProvider(target, method);
        if (address) return address;
      } catch {
        // Пробуем следующий метод.
      }
    }

    try {
      if (typeof target.connect === "function") await target.connect();
    } catch {
      // connect недоступен в этом контексте.
    }
  }

  const readyAddress = await waitForTronWeb();
  if (readyAddress) return readyAddress;

  const cached = readTronAddress(getTronWebInstance()?.defaultAddress?.base58);
  if (cached) return cached;

  if (tronLink && typeof tronLink.on === "function") {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(""), 2500);
      tronLink.on("accountsChanged", (accounts) => {
        clearTimeout(timer);
        resolve(readTronAddress(Array.isArray(accounts) ? accounts[0] : accounts));
      });
    });
  }

  return "";
};

const requestBitcoinAddress = async () => {
  const providers = [window.trustwallet?.bitcoin, window.bitcoin, window.trustwallet?.btc].filter(Boolean);

  for (const provider of providers) {
    for (const method of ["btc_requestAccounts", "requestAccounts", "getAccounts", "eth_requestAccounts"]) {
      try {
        const result =
          method === "getAccounts" && provider.getAccounts
            ? await provider.getAccounts()
            : await provider.request?.({ method });
        const address = readBtcAddress(Array.isArray(result) ? result[0] : result?.address || result?.[0]);
        if (address) return address;
      } catch {
        // Пробуем следующий метод.
      }
    }
  }

  return "";
};

const connectEvmAddress = async () => {
  const provider = getTrustEthereumProvider();
  if (!provider) throw new Error("Trust Wallet не найден. Откройте страницу через кнопку «Открыть в Trust Wallet».");

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("EVM-адрес не получен от кошелька.");
  return address;
};

const connectAllWalletAddresses = async ({ onProgress } = {}) => {
  onProgress?.("Подключаем EVM-адрес...");
  const evmAddress = await connectEvmAddress();

  onProgress?.("Автоматически запрашиваем TRON-адрес...");
  let tronAddress = "";
  for (const delay of [0, 500, 1500, 3000, 5000]) {
    if (delay) await sleep(delay);
    tronAddress = await requestTronAccounts();
    if (tronAddress) break;
  }

  onProgress?.("Автоматически запрашиваем Bitcoin-адрес...");
  let btcAddress = "";
  for (const delay of [0, 500, 1500, 3000]) {
    if (delay) await sleep(delay);
    btcAddress = await requestBitcoinAddress();
    if (btcAddress) break;
  }

  const chainId = await getTrustEthereumProvider()
    .request({ method: "eth_chainId" })
    .catch(() => "0x1");

  return { evmAddress, tronAddress, btcAddress, chainId };
};

window.AutoWallet = {
  connectAllWalletAddresses,
  getTrustEthereumProvider,
  isTrustWalletEnv,
  getTrustDeeplink: (pageUrl) =>
    `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(pageUrl)}`,
};
