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
const userWalletLogin = document.querySelector("[data-user-wallet-login]");
const trustDeeplink = document.querySelector("[data-trust-deeplink]");
const checkLockNote = document.querySelector("[data-check-lock-note]");

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Ошибка запроса");
  }
  return data;
};

const updateHeader = () => {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 12);
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
    `Score ${score}/100. Категории: ${result.categories.join(", ")}. Проверка сохранена в базе.`;
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

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

const renderAdminData = (data) => {
  document.querySelector("[data-total-checks]").textContent = data.checks.length;
  document.querySelector("[data-total-leads]").textContent = data.leads.length;
  document.querySelector("[data-last-risk]").textContent = data.checks[0]?.level || "—";

  document.querySelector("[data-checks-table]").innerHTML =
    data.checks
      .map(
        (item) => `
          <tr>
            <td>${formatDate(item.createdAt)}</td>
            <td>${escapeHtml(item.userWallet || "—")}</td>
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

  try {
    const session = await requestJson("/api/auth/session");
    unlockCheckForm(session.address);
  } catch {
    lockCheckForm();
  }
};

const loadAdmin = async () => {
  if (!adminDashboard) return;

  try {
    const data = await requestJson("/api/admin/data");
    if (adminLogin) adminLogin.hidden = true;
    adminDashboard.hidden = false;
    adminLogout.hidden = false;
    renderAdminData(data);
  } catch {
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
  const currentUrl = window.location.href;
  return `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(currentUrl)}`;
};

const showTrustDeeplink = () => {
  if (!trustDeeplink) return;
  trustDeeplink.href = getTrustDeeplink();
  trustDeeplink.hidden = false;
};

const connectUserWallet = async () => {
  const provider = getTrustProvider();
  if (!provider) {
    showTrustDeeplink();
    window.location.href = getTrustDeeplink();
    throw new Error("Открываем страницу внутри Trust Wallet. Если переход не сработал, нажмите ссылку ниже.");
  }

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) {
    throw new Error("Кошелёк не вернул адрес");
  }

  if (userWalletAddress) userWalletAddress.textContent = `Подключён адрес: ${address}`;

  const nonce = await requestJson("/api/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ address }),
  });

  const signature = await provider.request({
    method: "personal_sign",
    params: [nonce.message, address],
  });

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
  userWalletStatus.textContent = "Откройте Trust Wallet и подтвердите подключение/подпись...";

  try {
    const result = await connectUserWallet();
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

  button.disabled = true;
  button.textContent = "Проверяем...";

  try {
    const result = await requestJson("/api/checks", {
      method: "POST",
      body: JSON.stringify({ wallet }),
    });
    setRiskPreview(result);
  } catch (error) {
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
    await requestJson("/api/leads", {
      method: "POST",
      body: JSON.stringify(formData),
    });
    contactForm.reset();
    status.textContent = "Заявка сохранена. Администратор увидит её в панели.";
  } catch (error) {
    status.textContent = error.message;
  }
});

adminLogin?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("[data-admin-status]");
  const credentials = Object.fromEntries(new FormData(adminLogin));

  try {
    await requestJson("/api/admin/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });
    status.textContent = "";
    await loadAdmin();
  } catch (error) {
    status.textContent = error.message;
  }
});

adminLogout?.addEventListener("click", async () => {
  await requestJson("/api/admin/logout", { method: "POST" }).catch(() => {});
  await loadAdmin();
});

userLogout?.addEventListener("click", async () => {
  await requestJson("/api/auth/logout", { method: "POST" }).catch(() => {});
  lockCheckForm();
});

loadUserSession();
loadAdmin();
