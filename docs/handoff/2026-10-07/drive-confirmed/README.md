# DP Beget Bridge

Обновлено 07.10.2026, Europe/Moscow. Алиасы: Beget Connector, Beget Remote Con, Beget Remote Con 3, R04/R0004. Это самостоятельный Linux VPS MCP bridge с устойчивыми терминалами, файловыми операциями и локальной OAuth-авторизацией. Не объединять с Desktop Connector, Yandex Connector или веб-проектами.

Состав: Session Host, Agent, MCP/OAuth; необязательная аналитика; установка/подпись/обновление/восстановление; unit и Linux integration проверки. Direct Mode автономен от центрального сайта, аналитики и будущего Relay.

Основной приватный Git: https://pareshnev.com/git/pareshnev-hub/dp-beget-bridge.
Рабочее состояние разработки: codex/r04-01-signed-retention / 787ae691c6e42a3c2ab8f75ebaff8f97c92f0f95. Завершённая база #265: 9560b449f44248d8e08d8f5088a9d0cb8bb0d75b.
Первый снимок актуализации: recovery/handoff/20261007/beget-remote-con-3-r04-01 / 2e2f31bbe9ae1f3b2ab18e0f6bc5f8ec791a3c80. Сохранён в полном Git bundle, но Forgejo ref пока не опубликован.
Bundle: dp-core-01:/opt/forgejo/local-checkpoints/beget-r04-work-20261007/beget-complete-history-20261007.bundle; SHA-256 2278910556213d12f2618ccc5f2928a1aed380a9569308bbb8b8e40471efa01a. Ранний HANDOFF_2026-10-07.md/json рядом с bundle описывает состояние до появления Drive tools; по NHN/Drive его BLOCKED-записи исторические.

Прежний GitHub: https://github.com/pareshnev-hub/dp-beget-bridge.git — сохранён как github-origin. Локальный origin теперь Hetzner, upstream рабочей ветки — подтверждённый 787ae691…. Глобальные настройки не менялись.

Продолжение этой Work: https://drive.google.com/drive/folders/1XRDEf1i2N4F6VagGY0pNTJjrsrj05Fgl (Branches/Beget Remote Con 3 — R04 и сохранение исходников); читать BRANCH.md и датированный WORKLOG. Work ID 01a0f7a3-501d-7890-8ec2-9ea68545d535; проверенная внешняя ссылка на чат недоступна.

NHN 1.7.0 прочитана через точный NHN-AGENT-POLICY-LIVE, Version → Router → Info, 00/01/02/03/05/04/06. Все девять хешей модулей совпали с Version. Сначала была недоступна выдача Drive tools; 17:10 доступ появился и проверен чтением. Повторное подключение Google не требовалось.

Восстановление: клонировать рабочую ветку с Hetzner; читать CURRENT_STATE.md, AGENTS.md, docs/R0004_PAUSE_2026-10-01.md, ROADMAP/ARCHITECTURE/IMPLEMENTATION_STATUS/PRIVACY_DECISIONS/ADR. При необходимости отдельного снимка использовать указанный bundle в изолированной копии; не применять его как live-установку. Независимая проверка Git с Hetzner и bundle: полный исходный набор 269 Git-состояний/644 коммита, 383 исходных файла и 393 файла первого снимка совпадают; fsck 0, не shallow.

R04 не выпущен, package 0.1.0. Разработка на паузе по владельцу. Последний retention WIP не проверен на целевом Linux. Семь крупных блоков релиза остаются открытыми. Сохранение источников не является приёмкой релиза или восстановлением live-данных.
