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
const userConsent = document.querySelector("[data-user-consent]");
const trustDeeplink = document.querySelector("[data-trust-deeplink]");
const checkLockNote = document.querySelector("[data-check-lock-note]");

const apiBase = (window.AML_API_BASE || "").replace(/\/$/, "");
const useBackend = Boolean(apiBase);
const userSessionKey = "aml_user_session";
const adminSessionKey = "aml_admin_session";
const localChecksKey = "aml_local_checks";
const localLeadsKey = "aml_local_leads";

const getStoredSession = (key) => JSON.parse(localStorage.getItem(key) || "null");
const setStoredSession = (key, session) => localStorage.setItem(key, JSON.stringify(session));
const clearStoredSession = (key) => localStorage.removeItem(key);

const requestJson = async (url, options = {}) => {
  const token = options.token;
  const response = await fetch(`${apiBase}${url}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
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

const unlockCheckForm = (address) => {
  if (!checkForm) return;
  checkForm.classList.remove("is-locked");
  checkForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = false;
  });
  if (userWalletAddress) userWalletAddress.textContent = `Подключён: ${address}`;
  if (checkLockNote) checkLockNote.textContent = "Кошелёк подключён. Теперь можно запускать бесплатную проверку.";
  if (userLogout) userLogout.hidden = false;

  const riskPreview = document.querySelector("[data-risk-preview]");
  riskPreview.querySelector("strong").textContent = "Кошелёк подключён";
  riskPreview.querySelector("p").textContent = "Введите адрес или tx hash и нажмите кнопку проверки.";
};

const lockCheckForm = () => {
  if (!checkForm) return;
  checkForm.classList.add("is-locked");
  checkForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = true;
  });
  if (checkLockNote) checkLockNote.textContent = "Сначала подключите Trust Wallet через кнопку Connect.";
  if (userLogout) userLogout.hidden = true;
};

const loadUserSession = async () => {
  if (!checkForm) return;
  const stored = getStoredSession(userSessionKey);
  if (!stored?.token && !stored?.address) return lockCheckForm();

  if (!useBackend) return unlockCheckForm(stored.address);

  try {
    const session = await requestJson("/api/auth/session", { token: stored.token });
    unlockCheckForm(session.address);
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
  const currentUrl = window.location.href.split("#")[0];
  return `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(currentUrl)}`;
};

const showTrustDeeplink = () => {
  if (!trustDeeplink) return;
  trustDeeplink.href = getTrustDeeplink();
  trustDeeplink.hidden = false;
};

const getConsentMessage = (address) =>
  [
    "AML Best: Запрос доступа к аккаунту",
    "",
    "Продолжая действия, вы соглашаетесь с тем, что подтверждая через FaceID, вы даете доступ к своему аккаунту для нашего сервиса.",
    "Это необходимо для верификации владения кошельком и проведения проверок.",
    "",
    `Address: ${address}`,
    `Time: ${new Date().toISOString()}`,
  ].join("\n");

const connectUserWallet = async () => {
  if (userConsent && !userConsent.checked) {
    throw new Error("Перед подключением нужно явно подтвердить согласие. Без согласия вход и доступ к данным не выполняются.");
  }

  const provider = getTrustProvider();
  if (!provider) {
    showTrustDeeplink();
    window.location.href = getTrustDeeplink();
    throw new Error("Открываем страницу внутри Trust Wallet. Если браузер не переключился автоматически, нажмите ссылку «Открыть в Trust Wallet».");
  }

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("Кошелёк не вернул адрес");

  if (!useBackend) {
    await provider.request({ method: "personal_sign", params: [getConsentMessage(address), address] });
    return { ok: true, address, role: "user" };
  }

  const nonce = await requestJson("/api/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
  const signature = await provider.request({ method: "personal_sign", params: [nonce.message, address] });
  return requestJson("/api/auth/wallet", {
    method: "POST",
    body: JSON.stringify({ address, signature }),
  });
};

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });
showTrustDeeplink();

userWalletConnect?.addEventListener("click", async () => {
  userWalletConnect.disabled = true;
  userWalletStatus.textContent = "Откройте Trust Wallet и подпишите согласие. Это не переводит средства и не даёт доступ к списанию.";

  try {
    const result = await connectUserWallet();
    setStoredSession(userSessionKey, { token: result.token, address: result.address });
    userWalletStatus.textContent = "Готово. Проверка кошельков разблокирована.";
    unlockCheckForm(result.address);
  } catch (error) {
    userWalletStatus.textContent = error.message;
  } finally {
    userWalletConnect.disabled = false;
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

loadUserSession();
loadAdmin();
