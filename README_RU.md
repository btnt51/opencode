# OpenCode V2 — руководство по защищённому fork

Этот документ описывает **фактическое состояние текущего V2-кода**. Он не заменяет основной
[`README.md`](README.md) и не обещает совместимость с непрочитанными версиями donor.

> Donor локально недоступен; выполнена V2-реализация по спецификации. Точное соответствие
> непрочитанному donor не проверено.

## Статус переноса и границы приёмки

| Область                    | Реализация V2                                                                                                    | Конфигурация                                        | Автоматическая проверка                               | Ограничение                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/goal`                    | встроенная command передаёт шаблон и вложения в обычный `Session.prompt`                                         | `commands` может переопределить именованные команды | `packages/core/test/plugin/command.test.ts`           | это инструкция текущей сессии, не отдельный бесконечный scheduler                                           |
| Filesystem tools           | Location-scoped проверки canonical path для read/write/edit/glob/grep; deny имеет приоритет                      | `sandbox.filesystem`                                | `sandbox.test.ts`, `tool-read-filesystem.test.ts`     | application checks подвержены TOCTOU/hardlink/mount race; raw plugin API не является sandbox API            |
| Shell/background           | команда переписывается в `bwrap`; cwd также обязан быть разрешён                                                 | `sandbox`, `environment`, `network.tools`           | `sandbox.test.ts`, `tool-shell.test.ts`, shell suites | только local Linux; pipeline на уровне `ChildProcess` запрещён; нужен `bwrap`                               |
| PTY и прочие host services | отдельные V2 services                                                                                            | штатные `shell`, `formatter`, `lsp`                 | package tests                                         | не заявлены как покрытые subprocess sandbox; при требовании изоляции не считать безопасным обходным путём   |
| Safe env                   | allowlist `COLORTERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `PATH`, `TERM`, `TZ`; явный env local MCP сохраняется       | `sandbox.environment`                               | `sandbox.test.ts`                                     | `all` доверяет host environment только для обычной sandbox command; restricted удаляет host proxy variables |
| Network `none` / `full`    | namespace без сети / `--share-net`                                                                               | `sandbox.network.tools`                             | `sandbox.test.ts`                                     | `full` снимает egress-ограничение subprocess, но не filesystem policy                                       |
| Network `restricted`       | loopback HTTP CONNECT relay + broker, проверка host/port, DNS pinning, redirect к иному endpoint не авторизуется | `{mode:"restricted",allow:[…]}`                     | `sandbox-network.test.ts`, `sandbox.test.ts`          | HTTPS/Git over HTTP proxy; in-process network tools запрещены; нужны `bwrap` и `/usr/bin/python3`           |
| Provider                   | отдельный trusted backend path                                                                                   | `network.provider`: `configured` или `disabled`     | sandbox tests                                         | не проходит через agent subprocess proxy; parent/plugins не получают egress guarantee sandbox               |
| MCP remote                 | ручные и автоматические операции проверяют allowlist до соединения/вызова                                        | `network.mcp.allow`, `mcp.servers`                  | MCP и sandbox tests                                   | remote MCP — trusted backend traffic, не restricted relay                                                   |
| MCP local                  | Location execution plane + `bwrap`, явный env, `network` по умолчанию `none`                                     | server `type: local`, `sandbox.network`             | `mcp.test.ts`, `sandbox.test.ts`                      | разрешены только `none` и `full`, restricted для child MCP отсутствует                                      |
| Telegram                   | headless plugin, dedupe на destination/location/session/event, bounded async queue                               | `notification.<name>`                               | `notification.test.ts`                                | best effort, очередь только в памяти, retry event V2 отсутствует                                            |
| Proxy destination          | `direct`, environment или конкретный HTTP(S) proxy                                                               | `notification.*.proxy`                              | `notification.test.ts`                                | proxy применяется только к destination; отказ proxy не меняет LLM/MCP routing                               |
| Несколько Location         | Sandbox, MCP, config и session runtime Location-scoped                                                           | документы config каждого Location                   | Location/MCP/session suites                           | local execution не является clustered ownership                                                             |

`PASS` в этой таблице означает наличие реализации и тестового покрытия, а не автоматически успешный
прогон в каждой машине. Итог конкретного прогона следует сверять с отчётом изменения.

## Установка и production build

Репозиторий закрепляет Bun `1.4.2` в `packageManager` и использует workspace lockfile:

```sh
bun install --frozen-lockfile
bun run check
GITHUB_ACTIONS=false bun turbo test --force --output-logs=errors-only --log-order=grouped
bun run --cwd packages/cli build --single
```

Сборщик сохраняет `minify`, bytecode, splitting, проверку simulation graph и `verifyArtifact`.
Для Linux x64 обычный single artifact находится в
`packages/cli/dist/cli-linux-x64/bin/opencode` (имя зависит от текущих OS, arch, libc и baseline).
Флаги текущего сборщика: `--single`, `--baseline`, `--target=…`, `--skip-install`,
`--skip-web-ui`, `--outdir=…`. Проверка только `--version` недостаточна: для релизной приёмки нужен
изолированный startup и локальный запрос через test/simulation fake provider без пользовательских ключей,
HOME, базы и daemon.

Точечные проверки запускаются не из корня, чтобы core test harness создал отдельные HOME/XDG:

```sh
bun run --cwd packages/core typecheck
bun run --cwd packages/cli typecheck
bun run --cwd packages/core test test/sandbox.test.ts test/sandbox-network.test.ts
bun run --cwd packages/core test test/notification.test.ts test/plugin/command.test.ts
bun run --cwd packages/cli test
```

## Canonical V2 config

Ниже пример с действующими plural-полями `permissions`, `agents`, `commands`, `providers` и
`mcp.servers`. Подстановка `{env:NAME}` выполняется loader до schema validation; секреты не нужно
вставлять непосредственно в JSON.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [],
  "agents": {},
  "commands": {},
  "providers": {},
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "read": ["../shared-readonly"],
      "write": ["./generated"],
      "deny": ["./secrets"]
    },
    "environment": "safe",
    "network": {
      "tools": {
        "mode": "restricted",
        "allow": [
          { "host": "github.com", "ports": [443] },
          { "host": "git.example.test", "ports": [443], "includeSubdomains": true }
        ]
      },
      "provider": "configured",
      "mcp": { "allow": ["company"] }
    }
  },
  "mcp": {
    "timeout": { "startup": 10000, "catalog": 10000, "execution": 30000 },
    "servers": {
      "local-tools": {
        "type": "local",
        "command": ["example-mcp"],
        "environment": { "EXAMPLE_TOKEN": "{env:EXAMPLE_MCP_TOKEN}" },
        "sandbox": { "network": "none" }
      },
      "company": {
        "type": "remote",
        "url": "https://mcp.example.test/api",
        "headers": { "Authorization": "Bearer {env:EXAMPLE_MCP_TOKEN}" },
        "oauth": false
      }
    }
  },
  "notification": {
    "ops": {
      "type": "telegram",
      "botToken": "{env:OPENCODE_TELEGRAM_TOKEN}",
      "chatId": "{env:OPENCODE_TELEGRAM_CHAT_ID}",
      "proxy": { "mode": "environment" },
      "events": {
        "attention": true,
        "completed": { "enabled": true, "after": "30s" },
        "failed": true,
        "retry": false
      }
    }
  }
}
```

### Defaults

| Поле                                 | Effective default                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `sandbox` отсутствует / `false`      | выключен; штатное поведение V2                                                    |
| `sandbox: true`                      | workspace read/write, внешние roots отсутствуют, tools network `none`, env `safe` |
| `filesystem.read` / `write` / `deny` | пустые дополнительные списки; workspace всё равно write/read root                 |
| `network.tools`                      | `none`                                                                            |
| `network.provider`                   | `configured`                                                                      |
| `network.mcp.allow`                  | пустой список при включённом sandbox                                              |
| local MCP `sandbox.network`          | `none`                                                                            |
| Telegram `enabled`                   | `true`                                                                            |
| attention/completed/failed           | `true`                                                                            |
| completed `after`                    | `0ms`                                                                             |
| retry                                | всегда `false`: V2 retry event отсутствует                                        |
| notification proxy                   | `direct` при отсутствии поля                                                      |

`network: true` эквивалентен full tool networking; `network: false` оставляет tools без сети.
Filesystem остаётся ограниченной при `none`, `restricted` и `full`.

### Legacy migration и приоритет

| Legacy                         | Canonical V2  | Правило                                                               |
| ------------------------------ | ------------- | --------------------------------------------------------------------- |
| `permission`, `tools`          | `permissions` | мигрированные правила сохраняют порядок, native добавляются после них |
| `agent`, `mode`, `small_model` | `agents`      | native named entry имеет приоритет; конфликты диагностируются         |
| `command`                      | `commands`    | merge по имени, native валидная запись приоритетна                    |
| `provider`                     | `providers`   | merge по имени                                                        |
| старый map в `mcp`             | `mcp.servers` | распознанные записи мигрируются; `mcp.timeout` остаётся отдельно      |
| `plugin`                       | `plugins`     | списки объединяются                                                   |
| `snapshot`                     | `snapshots`   | значение переносится                                                  |

Malformed элементы обычных named maps могут быть пропущены с redacted diagnostic. Но неверный
`sandbox` или неизвестное security-поле (`sandbox.*`) отвергает документ целиком: защита fail-closed.
Разрешающие filesystem/network значения берутся только из trusted config documents вне workspace;
workspace config может добавлять `deny`, но не расширять roots/network. Effective sandbox policy
фиксируется на lifetime Location: model-edited config и reload не снимают уже включённую защиту.

## Модель sandbox

### Filesystem

Application policy проверяет lexical и `realpath`-canonical path. `deny` применяется раньше allow;
write root также разрешает чтение. Смена `cwd` не расширяет roots: cwd должен пройти и read, и write.
После проверки остаются обычные TOCTOU, hardlink и mount races. Поэтому для agent subprocess поверх
checks используется mount namespace `bwrap`: runtime roots read-only, workspace/write roots bind-write,
deny маскируется. Это не делает allowed endpoint безопасным от утечки данных, которые агент уже может
читать.

`read`, `write`, `edit`, `glob`, `grep` и shell интегрированы с policy. Raw filesystem override внутри
доверенного plugin, host search index, PTY, formatter, LSP, browser, CodeMode и attachment processing
не должны использоваться как обход. Текущая реализация не доказывает единый OS sandbox для всех этих
host/in-process путей; при строгом режиме их следует отключить или не предоставлять агенту до появления
явной интеграции и security tests.

### Network

- `none`: subprocess получает новый network namespace без host network.
- `full`: subprocess делит host network (`--share-net`).
- `restricted`: relay внутри namespace принимает proxy traffic, а host broker разрешает только
  configured host/port. Правила нормализуют IDN/trailing dot, соблюдают DNS label boundaries, требуют
  `private: true` для private/local адресов и pin выбранного DNS address.

Restricted предназначен для HTTP(S), включая Git через HTTP proxy. Raw sockets не получают route.
Host proxy variables удаляются, чтобы исключить bypass; relay задаёт `HTTP_PROXY`/`HTTPS_PROXY` на
`127.0.0.1:18080`. Redirect на другой host/port требует новой авторизации и иначе блокируется.
Корпоративный endpoint добавляйте точно по имени и порту; `includeSubdomains` расширяет capability,
а `private` разрешает private/local адреса — включайте их только осознанно. Bun build/runtime использует
system CA; корпоративный CA должен быть установлен в trust store процесса/образа. Наличие endpoint в
allowlist означает, что разрешённая сторона может принять любые доступные агенту данные.

Provider, allowed remote MCP и Telegram — trusted backend paths, поэтому работают независимо от
agent tool mode `none`. `provider: disabled` запрещает configured provider при включённом sandbox.
MCP, отсутствующий в `network.mcp.allow`, не подключается и не вызывается вручную. Эти правила не
ограничивают сеть самого trusted parent process или произвольного plugin.

### Platform failure

Sandbox включается только для local Linux Location. Workspace driver/remote Location и иная OS
завершают создание защищённого runtime ошибкой; команда не запускается без защиты. Отсутствующий
`bwrap`, Python или security primitive также не должен трактоваться как успешная изоляция. При
`sandbox: false` сохраняется обычная V2 работа.

## Telegram notifications

Plugin работает без TUI и наблюдает V2 события:

- permission/form created → `attention`;
- execution succeeded → `completed`, только если нет pending attention и выдержан `after`;
- execution failed → `failed`;
- interrupted/cancelled очищает state и не создаёт success;
- V2 retry event отсутствует, поэтому `retry: true` только вызывает warning и не включает доставку.

Один event доставляется не более одного раза на destination + Location directory + session + event key.
Parent sessions уведомляются, child sessions — нет. Очередь ограничена 128 сообщениями, concurrency — 4;
доставка best effort, timeout 10 секунд, HTTP 429 повторяется один раз с bounded delay. Ошибка Telegram
логируется redacted и не ломает goal/session.

`proxy.mode`:

- `direct` — proxy не используется;
- `environment` — backend читает lower/uppercase `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`;
- `url` — только указанный HTTP(S) proxy.

`127.0.0.1` в proxy URL означает машину trusted backend/server, а не remote workspace или компьютер
пользователя. PAC и системные GUI proxy settings не читаются. При недоступности выбранного proxy нет
fallback в direct. Настройка destination не меняет provider/MCP/LLM routing.

## Секреты и диагностика

Храните токены в environment или отдельном файле с ограниченными правами и используйте
`{env:VAR}` / поддерживаемую loader подстановку, а не literal token в versioned config. Не передавайте
agent subprocess `environment: all`, если это не требуется. Local MCP получает только явно заданный
`environment` плюс safe runtime variables. Config diagnostics не должны включать invalid values,
permission resources или credentials; transport errors Telegram содержат destination и общую причину,
но не bot token/response description. Перед публикацией logs/API payload всё равно выполняйте
операционную redaction: arbitrary plugins и внешние процессы находятся вне этой гарантии.

## Disposable manual fixture

Не используйте настоящий HOME, daemon или API key:

```sh
ROOT="$(mktemp -d)"
export HOME="$ROOT/home" XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" XDG_CACHE_HOME="$ROOT/cache"
mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_CACHE_HOME" "$ROOT/work" "$ROOT/outside"
printf 'outside-canary\n' >"$ROOT/outside/canary"
printf 'workspace-canary\n' >"$ROOT/work/canary"
export OPENCODE_TELEGRAM_TOKEN='dummy-not-a-real-token'
export OPENCODE_TELEGRAM_CHAT_ID='dummy-chat'
```

Запишите config только внутрь disposable `$XDG_CONFIG_HOME`. Положительный control сначала должен
доказать, что compiled CLI, fake provider и локальный HTTP fixture реально стартовали. Затем проверьте:

1. workspace read/write успешны;
2. read/write `outside/canary` отклонены;
3. symlink из workspace наружу отклонён;
4. `none` не соединяется даже с локальным fixture;
5. `restricted` соединяется с явно разрешённым endpoint, но не с другим host/port, private IP без
   `private`, raw socket или cross-endpoint redirect;
6. `full` соединяется, но всё ещё не читает outside canary;
7. две Location используют разные canary/config/credentials и закрытие одной не ломает другую.

Не засчитывайте отсутствие `curl`, `python3`, `bwrap`, namespaces, server или fake model как PASS.
Mocked construction подтверждает форму command, но не live security enforcement.

## AppArmor и `EPERM`

`EPERM` сам по себе не доказывает конфликт AppArmor: возможны seccomp, user namespace policy,
container capability, mount flags, LSM, filesystem или CI restrictions. Проверьте kernel/audit journal,
профиль конкретного executable, доступность unprivileged user namespaces и минимальный disposable
`bwrap` smoke test. Исправляйте узкое правило профиля или окружение запуска. Не отключайте AppArmor
глобально/навсегда и не запускайте OpenCode от root как workaround.

## Известные риски и breaking changes

- Canonical config использует plural collections и `mcp.servers`; security-поля с неизвестными ключами
  теперь fail-closed.
- Sandbox on на non-Linux или workspace-driver Location несовместим со штатным запуском и намеренно
  завершается ошибкой.
- Restricted не поддерживает произвольные raw protocols и in-process network tools.
- Полной egress-изоляции trusted parent/plugins нет.
- Application filesystem checks не заменяют kernel isolation и сохраняют TOCTOU/hardlink risks.
- Telegram — best effort, без durable queue; restart может потерять pending delivery.
- Полный legacy/donor parity: **NOT VERIFIED**.
