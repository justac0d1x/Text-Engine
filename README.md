# Text Engine

Легковесный in-memory message broker с комнатами и каналами на Express. Без базы данных — всё хранится в оперативной памяти.

## Деплой на Render

- **Environment**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `npm start`

## API

Базовый URL: `https://ваш-сервер.onrender.com`

### `GET /`

Статус сервера.

```json
{ "status": "ok", "rooms": 3, "uptime": 1842 }
```

### `POST /join`

Подключение пользователя к комнате.

```json
{ "room": "my-room", "user": "alice" }
```

**Ответ:**

```json
{ "ok": true, "users": ["alice", "bob"] }
```

### `POST /leave`

Выход из комнаты.

```json
{ "room": "my-room", "user": "alice" }
```

### `POST /send`

Отправка сообщения в канал внутри комнаты.

```json
{
  "room": "my-room",
  "user": "alice",
  "channel": "chat",
  "data": { "text": "Привет!" }
}
```

**Ответ:**

```json
{ "ok": true, "id": "550e8400-e29b-41d4-a716-446655440000" }
```

### `POST /poll`

Получение новых сообщений. Передайте `cursors` — словарь `{ канал: id_последнего_полученного_сообщения }`, чтобы забрать только непрочитанное.

```json
{
  "room": "my-room",
  "user": "bob",
  "cursors": { "chat": "550e8400-e29b-41d4-a716-446655440000" }
}
```

**Ответ:**

```json
{
  "ok": true,
  "messages": {
    "chat": [
      { "id": "...", "from": "alice", "data": { "text": "Как дела?" }, "ts": 1717012345678 }
    ]
  },
  "users": ["alice", "bob"]
}
```

## Внутренние параметры

| Параметр         | Значение | Описание                          |
|------------------|----------|-----------------------------------|
| `MESSAGE_TTL`    | 30 сек   | Время жизни сообщения             |
| `USER_TTL`       | 2 мин    | Таймаут неактивного пользователя  |
| `MAX_PER_CH`     | 200      | Макс. сообщений в одном канале    |
| `CLEANUP_EVERY`  | 10 сек   | Интервал очистки устаревших данных|

## Использование (клиент)

```javascript
const BASE = 'https://ваш-сервер.onrender.com';

// Подключиться к комнате
await fetch(`${BASE}/join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ room: 'game-1', user: 'alice' })
});

// Отправить сообщение
await fetch(`${BASE}/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    room: 'game-1',
    user: 'alice',
    channel: 'moves',
    data: { x: 3, y: 7 }
  })
});

// Поллинг новых сообщений (вызывать периодически)
const cursors = {};

async function poll() {
  const res = await fetch(`${BASE}/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: 'game-1', user: 'bob', cursors })
  });
  const { messages, users } = await res.json();

  for (const [channel, msgs] of Object.entries(messages)) {
    msgs.forEach(m => console.log(`[${channel}] ${m.from}:`, m.data));
    cursors[channel] = msgs[msgs.length - 1].id;
  }
}

setInterval(poll, 1000);
```
