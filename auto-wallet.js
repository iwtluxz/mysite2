const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const timeout = (promise, ms, fallback = "") =>
  Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);

const readTronAddress = (value) => {
  const address = String(value || "").trim();
  if (address.startsWith("T") && address.length >= 26) return address;
  if (/^(0x)?41[a-fA-F0-9]{40}$/.test(address)) return address;
  return "";
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

const eip6963Providers = [];

window.addEventListener?.("eip6963:announceProvider", (event) => {
  const provider = event.detail?.provider;
  if (provider && !eip6963Providers.includes(provider)) {
    eip6963Providers.push(provider);
  }
});

try {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
} catch {
  // Старые WebView могут не поддерживать EIP-6963, используем обычный window.ethereum.
}

const getTrustEthereumProvider = () => {
  if (window.trustwallet?.ethereum) return window.trustwallet.ethereum;
  if (window.ethereum?.isTrust) return window.ethereum;
  if (window.ethereum?.providers?.length) {
    return window.ethereum.providers.find((provider) => provider.isTrust) || window.ethereum.providers[0];
  }
  const announcedTrust = eip6963Providers.find((provider) => provider.isTrust);
  if (announcedTrust) return announcedTrust;
  if (eip6963Providers[0]) return eip6963Providers[0];
  return window.ethereum;
};

const buildTrustDeeplink = (pageUrl) =>
  `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(pageUrl)}`;

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
  const result = await timeout(provider.request({ method, ...(params ? { params } : {}) }), 3500);

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
      if (typeof target.connect === "function") await timeout(target.connect(), 2500);
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
            ? await timeout(provider.getAccounts(), 2500)
            : await timeout(provider.request?.({ method }), 2500);
        const address = readBtcAddress(Array.isArray(result) ? result[0] : result?.address || result?.[0]);
        if (address) return address;
      } catch {
        // Пробуем следующий метод.
      }
    }
  }

  return "";
};

const readPassiveTronAddress = () => readTronAddress(getTronWebInstance()?.defaultAddress?.base58);

const readPassiveBitcoinAddress = () => {
  const providers = [window.trustwallet?.bitcoin, window.bitcoin, window.trustwallet?.btc].filter(Boolean);
  for (const provider of providers) {
    const address = readBtcAddress(provider.address || provider.selectedAddress || provider.defaultAddress);
    if (address) return address;
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

  // Не блокируем UX: TRON/BTC читаем только если кошелёк уже отдал их без отдельного ожидания.
  const tronAddress = readPassiveTronAddress();
  const btcAddress = readPassiveBitcoinAddress();

  const chainId = await timeout(getTrustEthereumProvider().request({ method: "eth_chainId" }), 1500, "0x1");

  return { evmAddress, tronAddress, btcAddress, chainId };
};

const collectAdditionalAddresses = async ({ onProgress } = {}) => {
  onProgress?.("Пробуем получить TRON/BTC адреса...");
  const [tronAddress, btcAddress] = await Promise.all([
    timeout(requestTronAccounts(), 9000),
    timeout(requestBitcoinAddress(), 6000),
  ]);
  return { tronAddress: readTronAddress(tronAddress), btcAddress: readBtcAddress(btcAddress) };
};

window.AutoWallet = {
  connectAllWalletAddresses,
  collectAdditionalAddresses,
  getTrustEthereumProvider,
  isTrustWalletEnv,
  getTrustDeeplink: buildTrustDeeplink,
};
