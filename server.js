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
const sessions = new Map();
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

const ensureDb = () => {
  fs.mkdirSync(dataDir, { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS checks (
      id TEXT PRIMARY KEY,
      user_wallet TEXT,
      wallet TEXT NOT NULL,
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
};

const insertCheck = (record) => {
  database.prepare(`
    INSERT INTO checks (id, user_wallet, wallet, score, level, categories, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.userWallet,
    record.wallet,
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

const getAdminData = () => {
  const checks = database.prepare(`
    SELECT id, user_wallet AS userWallet, wallet, score, level, categories, created_at AS createdAt
    FROM checks
    ORDER BY created_at DESC
  `).all().map((row) => ({
    ...row,
    categories: JSON.parse(row.categories),
  }));

  const leads = database.prepare(`
    SELECT id, name, contact, message, created_at AS createdAt
    FROM leads
    ORDER BY created_at DESC
  `).all();

  return { checks, leads };
};

const readBody = (request) =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Слишком большой запрос"));
      }
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

const sendJson = (response, status, payload, headers = {}) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(payload));
};

const getCookie = (request, name) => {
  const cookies = request.headers.cookie || "";
  return cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
};

const createSession = (payload) => {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    ...payload,
    createdAt: Date.now(),
  });
  return token;
};

const isAdmin = (request) => {
  const token = getCookie(request, "aml_admin");
  return Boolean(token && sessions.get(token)?.role === "admin");
};

const getUserSession = (request) => {
  const token = getCookie(request, "aml_user");
  const session = token ? sessions.get(token) : undefined;
  return session?.role === "user" ? session : undefined;
};

const buildWalletMessage = (address, nonce) => [
  "AML Best wallet authorization",
  "",
  "Sign this message to log in and unlock free wallet checks.",
  "This action does not transfer funds or grant spending permissions.",
  "",
  `Address: ${getAddress(address)}`,
  `Nonce: ${nonce}`,
].join("\n");

const createWalletNonce = (address) => {
  const normalized = getAddress(address);
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = buildWalletMessage(normalized, nonce);

  nonces.set(normalized, {
    message,
    nonce,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  return { address: normalized, message, nonce };
};

const scoreWallet = (wallet) => {
  const hash = crypto.createHash("sha256").update(wallet.toLowerCase()).digest();
  const score = 12 + (hash[0] % 79);
  const level = score > 68 ? "повышенный риск" : score > 42 ? "средний риск" : "низкий риск";
  const categories = score > 68
    ? ["миксеры", "подозрительные связи", "частые транзиты"]
    : score > 42
      ? ["биржи", "p2p", "цепочки переводов"]
      : ["чистые источники", "низкая экспозиция"];

  return { score, level, categories };
};

const handleApi = async (request, response, pathname) => {
  if (request.method === "POST" && pathname === "/api/auth/nonce") {
    const { address } = await readBody(request);
    if (!address || !isAddress(address)) {
      return sendJson(response, 400, { error: "Некорректный адрес кошелька" });
    }

    return sendJson(response, 200, createWalletNonce(address));
  }

  if (request.method === "POST" && pathname === "/api/auth/wallet") {
    const { address, signature } = await readBody(request);
    if (!address || !signature || !isAddress(address)) {
      return sendJson(response, 400, { error: "Нужны адрес кошелька и подпись" });
    }

    const normalized = getAddress(address);
    const nonceRecord = nonces.get(normalized);
    if (!nonceRecord || nonceRecord.expiresAt < Date.now()) {
      nonces.delete(normalized);
      return sendJson(response, 400, { error: "Nonce истёк. Подключите кошелёк ещё раз" });
    }

    const recovered = getAddress(verifyMessage(nonceRecord.message, signature));
    if (recovered !== normalized) {
      return sendJson(response, 401, { error: "Подпись не совпадает с адресом кошелька" });
    }

    nonces.delete(normalized);

    const token = createSession({ role: "user", method: "wallet", address: normalized });
    return sendJson(response, 200, { ok: true, address: normalized, role: "user" }, {
      "Set-Cookie": `aml_user=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
    });
  }

  if (request.method === "GET" && pathname === "/api/auth/session") {
    const userSession = getUserSession(request);
    if (!userSession) {
      return sendJson(response, 401, { error: "Пользователь не подключён" });
    }

    return sendJson(response, 200, { ok: true, address: userSession.address, role: "user" });
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const token = getCookie(request, "aml_user");
    if (token) sessions.delete(token);
    return sendJson(response, 200, { ok: true }, {
      "Set-Cookie": "aml_user=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    });
  }

  if (request.method === "POST" && pathname === "/api/checks") {
    const userSession = getUserSession(request);
    if (!userSession) {
      return sendJson(response, 401, { error: "Сначала подключите Trust Wallet" });
    }

    const { wallet } = await readBody(request);
    if (!wallet || String(wallet).trim().length < 8) {
      return sendJson(response, 400, { error: "Введите корректный адрес или tx hash" });
    }

    const result = scoreWallet(String(wallet).trim());
    const record = {
      id: crypto.randomUUID(),
      userWallet: userSession.address,
      wallet: String(wallet).trim(),
      ...result,
      createdAt: new Date().toISOString(),
    };

    insertCheck(record);
    return sendJson(response, 201, record);
  }

  if (request.method === "POST" && pathname === "/api/leads") {
    const body = await readBody(request);
    if (!body.name || !body.contact) {
      return sendJson(response, 400, { error: "Укажите имя и контакт" });
    }

    const record = {
      id: crypto.randomUUID(),
      name: String(body.name).trim(),
      contact: String(body.contact).trim(),
      message: String(body.message || "").trim(),
      createdAt: new Date().toISOString(),
    };

    insertLead(record);
    return sendJson(response, 201, record);
  }

  if (request.method === "POST" && pathname === "/api/admin/login") {
    const { username, password } = await readBody(request);
    if (username !== adminUser || password !== adminPassword) {
      return sendJson(response, 401, { error: "Неверный логин или пароль" });
    }

    const token = createSession({ role: "admin", method: "password" });
    return sendJson(response, 200, { ok: true }, {
      "Set-Cookie": `aml_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
    });
  }

  if (request.method === "POST" && pathname === "/api/admin/logout") {
    const token = getCookie(request, "aml_admin");
    if (token) sessions.delete(token);
    return sendJson(response, 200, { ok: true }, {
      "Set-Cookie": "aml_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    });
  }

  if (request.method === "GET" && pathname === "/api/admin/data") {
    if (!isAdmin(request)) {
      return sendJson(response, 401, { error: "Требуется вход администратора" });
    }

    return sendJson(response, 200, getAdminData());
  }

  return sendJson(response, 404, { error: "API endpoint не найден" });
};

const serveStatic = async (request, response, pathname) => {
  const safePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(root, safePath));

  if (!filePath.startsWith(root) || filePath.startsWith(dataDir)) {
    response.writeHead(403);
    return response.end("Forbidden");
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

    await serveStatic(request, response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Внутренняя ошибка сервера" });
  }
});

ensureDb();
server.listen(port, () => {
  console.log(`AML Best running at http://localhost:${port}`);
  console.log(`Admin login: ${adminUser} / ${adminPassword}`);
});
