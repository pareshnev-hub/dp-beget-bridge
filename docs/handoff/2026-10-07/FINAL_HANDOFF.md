# DP Beget Bridge — итоговая точка перехода, 07.10.2026

Проект: Beget Remote Con 3 (R04_01), самостоятельный Linux VPS MCP bridge. Текущий чат: 01a0f7a3-501d-7890-8ec2-9ea68545d535. Функциональная разработка PAUSED по владельцу; разрешена и выполнена актуализация/сохранение, а не выпуск или развёртывание R04.

## Проверенная точка

Private Git: https://pareshnev.com/git/pareshnev-hub/dp-beget-bridge
Handoff branch: recovery/handoff/20261007/beget-remote-con-3-r04-01
Исходный подтверждённый handoff: 9d1540a7d36ccfa5004ac8010893774b2439f8f2, tree 4c3a1fe5d725fdb9272bec4df144dd60d3428fce. Этот итоговый документ — следующий коммит той же ветки; последний SHA фиксируется вне самого коммита в итоговой серверной квитанции и Drive BRANCH.md.
Код разработки R04: codex/r04-01-signed-retention / 787ae691c6e42a3c2ab8f75ebaff8f97c92f0f95. Завершённая база #265: 9560b449f44248d8e08d8f5088a9d0cb8bb0d75b. GitHub https://github.com/pareshnev-hub/dp-beget-bridge.git сохранён как github-origin; origin/upstream этого проекта — Hetzner. Исходная рабочая ветка, HEAD и глобальные настройки не менялись.

## Инструкции и память

NHN 1.7.0 подтверждена из exact LIVE Version → Router → Info и обязательные/нужные 00/01/02/03/05/04/06; девять хешей совпали. Version повторно проверена 07.10.2026 перед завершением. Центральный комплект и sources не изменялись.
Project: https://drive.google.com/drive/folders/1ereiLIjq_36Xzya613cauluKIr4u7Wcb
Work/BRANCH/WORKLOG: https://drive.google.com/drive/folders/1XRDEf1i2N4F6VagGY0pNTJjrsrj05Fgl
System Recovery component: https://drive.google.com/file/d/1HxS2_9LB776a1NU17ylU2Ttq_qKleE_z/view
System changelog: https://drive.google.com/file/d/1jE8gA3h_zxJgPafZxD_f_kCC83SXT-M9/view
Google подключён, чтение/запись пяти собственных документов проверены. Ранние Google/NHN BLOCKED — исторические. Реальная внешняя ссылка на чат недоступна; сохранён его проверенный ID. Чужие/параллельные записи не заменялись.

## Исходники и независимая проверка

Две исходные копии:
- /Users/m.pareshnev/.codex/.chatgpt-projects/g-p-6a9302d669c481919dba0b3dc13de337/dp-beget-bridge
- /Users/m.pareshnev/.codex/forgejo-preservation-v06/materialized/mac/Users/m.pareshnev/.codex/.chatgpt-projects/g-p-6a9302d669c481919dba0b3dc13de337/dp-beget-bridge

269 исходных Git-состояний, 644 коммита, 383 исходных файла: копии совпали по байтам/истории, не shallow, чистые до актуализации; различие только в более строгих правах архивной копии. Уникальных unreachable/reflog-коммитов и незакоммиченных исходников до актуализации нет. Retention WIP уже сохранён в 787ae691…. Новые AGENTS/CURRENT_STATE и контекст сохранены отдельными handoff-коммитами без подмены feature branch. Дополнительный серверный исторический коммит и все 271 прежние ссылки сохранены. Исходные refs, включая старые origin refs, отражены в original-git-state.json; все их SHA присутствуют в серверных refs, часть в recovery/mac. Сами источники не удалялись.

Первый handoff 2e2f31bbe9ae1f3b2ab18e0f6bc5f8ec791a3c80 и подтверждённый 9d1540a7d36ccfa5004ac8010893774b2439f8f2 сохранены в истории; полные bundle лежат на dp-core-01 в /opt/forgejo/local-checkpoints/beget-r04-work-20261007/. Снимок 9d1540a штатно опубликован в Forgejo после прямого разрешения существующего automation-token. Токен не выводился, не копировался и не публиковался. Hooks не обойдены, force push/merge/delete не применялись.

Независимый fresh clone настоящего Git после публикации: 269 исходных состояний/644 коммита, все 271 прежние серверные refs, SHA/tree и 402 файла handoff совпали; полная история, fsck --full --strict exit0. Последний итоговый коммит отдельно проверяется после его публикации в итоговой квитанции. Наличие bundle на сервере раньше не выдавалось за опубликованный Git ref.

Excluded: credentials, production .env, ключи, OAuth/runtime databases, transcripts/user files, воспроизводимые caches, synced sources, чужие проекты. Все 1398 blobs исходной истории и файлы handoff проверены на чувствительные имена/известные credential-шаблоны; обнаружений нет. Home scan 43963 directories с осознанными исключениями: timeout QimenIOS.xcodeproj записан отдельно, абсолютная полнота чтения Mac не заявляется; это иной продукт, не источник DP Beget Bridge.

## Порядок перехода

В следующей серверной Work открыть этот private repo и handoff branch, сверить последний SHA с Drive BRANCH/серверной квитанцией, прочитать NHN Version, AGENTS.md, CURRENT_STATE.md, этот итог, docs/R0004_PAUSE_2026-10-01.md и ROADMAP/IMPLEMENTATION_STATUS/ARCHITECTURE/PRIVACY_DECISIONS/ADR. Код handoff включает тот же R04 WIP и добавочные документы. После отдельной команды возобновления первый полезный шаг — Linux-проверка retention WIP, без повторения уже закрытых проверок актуализации.

Git transfer / instructions / Drive memory: PASS по независимым квитанциям. Owner action BEGET-GIT-WRITE-20261007 закрыт. Разработка PAUSED; R04 / 1.0.0 не выпущен. Семь пакетов остаются: production подпись/артефакты; чистая публичная установка/OAuth/реальный клиент; N/N−1 update/migration/snapshot/rollback; retention/quota/archive/uninstall/reset; формальная AUTO/real-client; платформенная матрица/документация/security review; выпуск1.0. В актуализации Linux CI и live acceptance не выполнялись.

Обычное восстановление исходников при доступном Hetzner PASS. Recovery class C для runtime продукта: offhost custody/выживание ключей/backup live-данных UNKNOWN, полный disaster restore NOT_RUN. Не превращать этот результат в доказательство выпуска или защиты от полной потери хоста. Приложения, DNS, Stand и центральный NHN не менялись.
