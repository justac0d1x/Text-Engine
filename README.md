# Secure Message Broker

Легковесный in-memory message broker с аутентификацией через GitHub Gist на Express. Без базы данных — всё хранится в оперативной памяти, пользователи в зашифрованном Gist.

## Деплой на Render

- **Environment**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `node server.js`

## Переменные окружения (обязательные)

| Переменная | Описание |
|------------|----------|
| `GIST_ID` | ID GitHub Gist с зашифрованным списком пользователей |
| `GITHUB_TOKEN` | GitHub Personal Access Token (права `gist`) |
| `GIST_DECRYPT_KEY` | Ключ для расшифровки Gist |
| `PASSWORD_KEY_1` | Секретный ключ для генерации паролей |
| `PASSWORD_KEY_2` | Второй секретный ключ |
| `CORS_ORIGIN` | (опционально) Домен фронтенда, по умолчанию `*` |

## API

Базовый URL: `https://ваш-сервер.onrender.com`

### `GET /`

Статус сервера.

```json
{ "status": "ok", "uptime": 1842 }
```

### `POST /login`

Аутентификация пользователя.

```json
{ "username": "alice", "password": "сгенерированный_пароль" }
```

**Ответ:**

```json
{ "ok": true, "sessionId": "550e8400-e29b-41d4-a716-446655440000", "username": "alice" }
```

### `POST /logout`

Завершение сессии.

```json
{ "sessionId": "550e8400-e29b-41d4-a716-446655440000" }
```

### `POST /join`

Подключение к комнате.

```json
{ "room": "my-room", "sessionId": "550e8400-e29b-41d4-a716-446655440000" }
```

**Ответ:**

```json
{ "ok": true, "users": ["alice", "bob"], "username": "alice" }
```

### `POST /leave`

Выход из комнаты.

```json
{ "room": "my-room", "sessionId": "550e8400-e29b-41d4-a716-446655440000" }
```

### `POST /send`

Отправка сообщения в канал внутри комнаты.

```json
{
  "room": "my-room",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "channel": "chat",
  "data": "Привет!"
}
```

**Ответ:**

```json
{ "ok": true, "id": "660e8400-e29b-41d4-a716-446655440001" }
```

### `POST /poll`

Получение новых сообщений. Передайте `cursors` — словарь `{ канал: id_последнего_сообщения }`.

```json
{
  "room": "my-room",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "cursors": { "chat": "660e8400-e29b-41d4-a716-446655440001" }
}
```

**Ответ:**

```json
{
  "ok": true,
  "messages": {
    "chat": [
      { "id": "...", "from": "alice", "data": "Как дела?", "ts": 1717012345678 }
    ]
  },
  "users": ["alice", "bob"]
}
```

## Внутренние параметры

| Параметр | Значение | Описание |
|----------|----------|----------|
| `MESSAGE_TTL` | 30 сек | Время жизни сообщения |
| `USER_TTL` | 2 мин | Таймаут неактивного пользователя |
| `MAX_PER_CH` | 200 | Макс. сообщений в одном канале |
| `SESSION_TTL` | 24 часа | Время жизни сессии |
| `DB_CACHE_TTL` | 1 мин | Кэш списка пользователей |
| `CLEANUP_EVERY` | 10 сек | Интервал очистки устаревших данных |

## Создание базы пользователей в Gist

1. Создайте JSON-массив с именами пользователей:
   ```json
   ["alice", "bob", "charlie"]
   ```

2. Зашифруйте его ключом `GIST_DECRYPT_KEY` (AES-256-GCM, формат `iv:authTag:data` в Hex).

3. Создайте Secret Gist на GitHub и вставьте зашифрованную строку.

4. Укажите ID Gist и токен в переменных окружения.

## Генерация пароля для пользователя

Пароль вычисляется как:
```
HMAC-SHA256(PASSWORD_KEY_1 + ":" + PASSWORD_KEY_2, username)
```

Пример на Node.js:
```javascript
const crypto = require('crypto');
const password = crypto.createHmac('sha256', KEY1 + ':' + KEY2)
  .update('alice')
  .digest('hex');
```

## Использование (клиент)

```javascript
const BASE = 'https://ваш-сервер.onrender.com';
let sessionId = null;

// Логин
async function login(username, password) {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  sessionId = data.sessionId;
  return data;
}

// Войти в комнату
await fetch(`${BASE}/join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ room: 'lobby', sessionId })
});

// Отправить сообщение
await fetch(`${BASE}/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    room: 'lobby',
    sessionId,
    channel: 'general',
    data: 'Привет всем!'
  })
});

// Поллинг сообщений
const cursors = {};

async function poll() {
  const res = await fetch(`${BASE}/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: 'lobby', sessionId, cursors })
  });
  const { messages, users } = await res.json();

  for (const [channel, msgs] of Object.entries(messages)) {
    msgs.forEach(m => console.log(`[${channel}] ${m.from}:`, m.data));
    cursors[channel] = msgs[msgs.length - 1].id;
  }
}

setInterval(poll, 500);
```
