# План доведения «Рупора» до идеала

## Статус на текущий момент

```
verify-accounts.js      37/37  PASS (прогон 1)
probe-chat-history.js    9/9   PASS
probe-ice-restart.js     5/5   PASS
probe-concurrent-join    идёт
verify-social-ui.js      идёт
```

---

## Решения пользователя (зафиксировано)

1. **TURN — публичный.** `openrelay.metered.ca` + новый `relay.metered.ca` по TCP/443. Своих серверов не поднимаем. Аварийная замена через `localStorage.rup_ice`.
2. **Mesh — оставляем.** Без SFU. Комфортно 4–5 человек. Для больших групп — режим «только аудио».
3. **История чата — локально.** 200 сообщений на группу в `rup_chat_<gid>`.

---

## ЭТАП 1 — Звонки и VPN (dev-webrtc) — ГОТОВО

| # | Задача | Статус |
|---|---|---|
| 1.1 | `ICE_CAP` 1500 → 4000 мс | ✅ signalling.js:43 |
| 1.2 | ICE restart при `disconnected` (2 с grace) | ✅ двусторонний: caller → restartIce + renegotiation, answerer → полный redial |
| 1.3 | TURN TCP/443 | ✅ добавлены `turn:relay.metered.ca:443?transport=tcp` и `turns:relay.metered.ca:443` |
| 1.4 | Утечка AudioContext в `leaveRoom` | ✅ `mixCtx.close()`, `voiceCtx.close()` |
| 1.5 | Медиатреки останавливаются | ✅ проверено, уже было |
| 1.6 | Реконнект при `failed` | ✅ `_redialMedia()`, лимит 3 |
| 1.7 | Re-negotiation path в `MediaConn._start()` | ✅ `replaceTrack` вместо `addTrack`, guard по `signalingState` |
| 1.8 | Экспорт диагностики `RuporBus.ICE_CAP` | ✅ для тестов |

---

## ЭТАП 2 — Интерфейс и рингтон (dev-frontend) — ГОТОВО

| # | Задача | Статус |
|---|---|---|
| 2.1 | Discord-рингтон D5→G5→B5 | ✅ social-ui.js:397–473 |
| 2.2 | Утечка `openSocial.timer` | ✅ clearInterval в `closeSocial` |
| 2.3 | Дедупликация чата по `seq` | ✅ `data-msgid`, fallback `at` → `from\|text` |
| 2.4 | Индикатор загрузки на кнопках | ✅ `withLoading()` |
| 2.5 | Фолбэк при заблокированном AudioContext | ✅ `note()` + unlock по клику |
| 2.6 | Индикаторы онлайн | ✅ `.presence-dot` + `refreshPresence()` 30 с |
| 2.7 | История чата в UI | ✅ `loadChatHistory()` при `enterChat` |
| 2.8 | Кнопка «Только аудио» | ✅ в `#call-hangup-actions` |

---

## ЭТАП 3 — Логика групп (dev-backend) — ГОТОВО

Агент упал по сети, но все задачи успел выполнить до падения. Проверено чтением кода.

| # | Задача | Статус |
|---|---|---|
| 3.1 | CAS в `joinGroup` | ✅ до 3 попыток, merge + повторная публикация |
| 3.2 | Коллизия `seq` в `sendChat` | ✅ случайный суффикс |
| 3.3 | `changeDisplayName` | ✅ social.js:240 |
| 3.4 | `renameGroup` | ✅ social.js:683 |
| 3.5 | `api.on/off` EventEmitter | ✅ `_listeners` + `emit()` |
| 3.6 | История чата API | ✅ `loadChatHistory` / `clearChatHistory` |
| 3.7 | **`leaveGroup` — убрать участника из списка** | ✅ исправлено вручную: чтение только с сети + verify-retry |

---

## ЭТАП 4 — Тестирование

| # | Тест | Статус |
|---|---|---|
| 4.1 | `verify-accounts.js` 37 проверок | ✅ прогон 1 |
| 4.2 | `probe-chat-history.js` | ✅ 9/9 |
| 4.3 | `probe-ice-restart.js` | ✅ 5/5 |
| 4.4 | `probe-concurrent-join.js` | идёт |
| 4.5 | `verify-social-ui.js` | идёт |
| 4.6 | `verify-mobile.js` | ждёт |
| 4.7 | `verify-pwa.js` | ждёт |
| 4.8 | E2E звонок двумя браузерами | ждёт |
| 4.9 | **5 полных прогонов подряд** | ждёт |

---

## ЭТАП 5 — Сборка и релиз

| # | Задача | Статус |
|---|---|---|
| 5.1 | Пересобрать `Рупор.exe` | ждёт |
| 5.2 | `Рупор.zip` | ждёт |
| 5.3 | git commit + push | ждёт |
| 5.4 | Обновить readme | ждёт |

---

## ЭТАП 6 — Дизайн

| # | Задача | Статус |
|---|---|---|
| 6.1 | Получить макет | **ждёт пользователя** |
| 6.2 | Адаптировать CSS | ждёт 6.1 |
| 6.3 | Прогнать тесты после адаптации | ждёт 6.1 |
