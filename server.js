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
const adminUser = process.env.ADMIN_USER || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://iwtluxz.github.io,http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const nonces = new Map();
let database;

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
  if (!checkColumns.includes("user_wallet")) {
    database.exec("ALTER TABLE checks ADD COLUMN user_wallet TEXT");
  }
  if (!checkColumns.includes("tx_hash")) {
    database.exec("ALTER TABLE checks ADD COLUMN tx_hash TEXT");
  }
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

const getSession = (request, role) => {
  const token = getBearerToken(request);
  if (!token) return undefined;

  const session = database.prepare(`
    SELECT token, role, address, created_at AS createdAt, expires_at AS expiresAt
    FROM sessions
    WHERE token = ?
  `).get(token);

  if (!session || session.role !== role || new Date(session.expiresAt).getTime() < Date.now()) {
    if (session) database.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return undefined;
  }

  return session;
};

const createSession = ({ role, address, days = 7 }) => {
  const token = crypto.randomBytes(32).toString("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  database.prepare(`
    INSERT INTO sessions (token, role, address, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, role, address || null, createdAt, expiresAt);
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
    record.createdAt
  );
};

const insertLead = (record) => {
  database.prepare(`
    INSERT INTO leads (id, name, contact, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(record.id, record.name, record.contact, record.message, record.createdAt);
};

const getAdminData = () => {
  const users = database.prepare(`
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
  `).all();

  const checks = database.prepare(`
    SELECT id, user_wallet AS userWallet, wallet, tx_hash AS txHash, score, level, categories, created_at AS createdAt
    FROM checks
    ORDER BY created_at DESC
  `).all().map((row) => ({ ...row, categories: JSON.parse(row.categories) }));

  const leads = database.prepare(`
    SELECT id, name, contact, message, created_at AS createdAt
    FROM leads
    ORDER BY created_at DESC
  `).all();

  return { users, checks, leads };
};

const buildWalletMessage = (address, nonce) => [
  "AML Best wallet authorization",
  "",
  "Sign this message to prove wallet ownership and unlock free wallet checks.",
  "This action does not transfer funds or grant spending permissions.",
  "",
  `Address: ${getAddress(address)}`,
  `Nonce: ${nonce}`,
].join("\n");

const createWalletNonce = (address) => {
  const normalized = getAddress(address);
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = buildWalletMessage(normalized, nonce);
  nonces.set(normalized, { message, nonce, expiresAt: Date.now() + 5 * 60 * 1000 });
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

const handleApi = async (request, response, pathname) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, getCorsHeaders(request));
    response.end();
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    return sendJson(request, response, 200, { ok: true, time: nowIso() });
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

    const recovered = getAddress(verifyMessage(nonceRecord.message, signature));
    if (recovered !== normalized) {
      return sendJson(request, response, 401, { error: "Подпись не совпадает с адресом кошелька" });
    }

    nonces.delete(normalized);
    upsertWalletUser(normalized);
    const session = createSession({ role: "user", address: normalized });
    return sendJson(request, response, 200, { ok: true, address: normalized, role: "user", ...session });
  }

  if (request.method === "GET" && pathname === "/api/auth/session") {
    const session = getSession(request, "user");
    if (!session) return sendJson(request, response, 401, { error: "Пользователь не подключён" });
    return sendJson(request, response, 200, { ok: true, address: session.address, role: "user" });
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    deleteSession(request);
    return sendJson(request, response, 200, { ok: true });
  }

  if (request.method === "POST" && pathname === "/api/checks") {
    const session = getSession(request, "user");
    if (!session) return sendJson(request, response, 401, { error: "Сначала подключите Trust Wallet" });

    const { wallet, txHash } = await readBody(request);
    if (!wallet || String(wallet).trim().length < 8) {
      return sendJson(request, response, 400, { error: "Введите корректный адрес или tx hash" });
    }

    const result = scoreWallet(String(wallet).trim());
    const record = {
      id: crypto.randomUUID(),
      userWallet: session.address,
      wallet: String(wallet).trim(),
      txHash: txHash || null,
      ...result,
      createdAt: nowIso(),
    };
    insertCheck(record);
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
    return sendJson(request, response, 201, record);
  }

  if (request.method === "POST" && pathname === "/api/admin/login") {
    const { username, password } = await readBody(request);
    if (username !== adminUser || password !== adminPassword) {
      return sendJson(request, response, 401, { error: "Неверный логин или пароль" });
    }
    const session = createSession({ role: "admin", days: 1 });
    return sendJson(request, response, 200, { ok: true, role: "admin", ...session });
  }

  if (request.method === "POST" && pathname === "/api/admin/logout") {
    deleteSession(request);
    return sendJson(request, response, 200, { ok: true });
  }

  if (request.method === "GET" && pathname === "/api/admin/data") {
    const session = getSession(request, "admin");
    if (!session) return sendJson(request, response, 401, { error: "Требуется вход администратора" });
    return sendJson(request, response, 200, getAdminData());
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
  console.log(`Admin login: ${adminUser} / ${adminPassword}`);
});
