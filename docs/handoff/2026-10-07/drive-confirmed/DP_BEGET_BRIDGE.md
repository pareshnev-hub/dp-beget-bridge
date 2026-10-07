# System Recovery — DP Beget Bridge

Актуализация 07.10.2026, Europe/Moscow. Только этот компонент; прочие системы и исторические записи сохраняют собственные статусы.

Проект: https://drive.google.com/drive/folders/1ereiLIjq_36Xzya613cauluKIr4u7Wcb
Work: https://drive.google.com/drive/folders/1XRDEf1i2N4F6VagGY0pNTJjrsrj05Fgl
Work ID: 01a0f7a3-501d-7890-8ec2-9ea68545d535. Проверенная внешняя ссылка на чат недоступна.

## Код и состояние

Приватный основной Git: https://pareshnev.com/git/pareshnev-hub/dp-beget-bridge.
Рабочая ветка codex/r04-01-signed-retention: 787ae691c6e42a3c2ab8f75ebaff8f97c92f0f95.
Завершённая база #265: 9560b449f44248d8e08d8f5088a9d0cb8bb0d75b.
Разработка PAUSED; R04 / 1.0.0 не выпущен. Retention WIP не принят на Linux.

Первый снимок актуализации: recovery/handoff/20261007/beget-remote-con-3-r04-01, SHA 2e2f31bbe9ae1f3b2ab18e0f6bc5f8ec791a3c80. Ref пока не опубликован в Forgejo; снимок восстановим из полного bundle:
/opt/forgejo/local-checkpoints/beget-r04-work-20261007/beget-complete-history-20261007.bundle на dp-core-01.
SHA-256: 2278910556213d12f2618ccc5f2928a1aed380a9569308bbb8b8e40471efa01a.

## Изменение и доказательства

BEFORE: local origin GitHub. AFTER: local origin Hetzner; github-origin сохранён, upstream рабочей ветки привязан к подтверждённому SHA. Приложения, DNS, Stand и глобальные Git-настройки не менялись.

Независимый clone приватного Git с Hetzner проверил все 269 исходных Git-состояний, 644 коммита и 383 исходных файла. История полная, fsck 0. Вторая Mac-копия совпадает по байтам/refs; её более строгие права сохранены. Bundle скачан новой SSH-сессией и независимо клонирован: все исходные refs/коммиты и 393 файла первого снимка совпали, tree/SHA и fsck PASS.

Evidence: outputs/beget-actualization-20261007 на Mac; серверные HANDOFF_2026-10-07.md/json и final-verification.json рядом с bundle. Ранние квитанции описывают состояние до появления Drive tools; более позднее дополнение имеет приоритет по NHN/Drive. Секретные значения и исходный репозиторий в Drive не загружены.

## Зависимости и пробелы

Для обычного восстановления кода нужен существующий доступ к приватному Hetzner Git или сохранившемуся bundle. Для публикации handoff ref нужна штатная Forgejo write-авторизация. Для контекста нужен Google Drive. Будущая проверка R04 требует подходящего Linux / Ubuntu 24.04, Node 22+, systemd, tmux и ACL.

Bundle находится на том же Hetzner: это не независимая защита от потери хоста. Внешняя custody нового снимка UNKNOWN; актуальный GitHub fallback в этой Work не проверялся. Live transcripts, databases, OAuth keys и account recovery не архивировались. Исторические общесистемные backup/key записи этим проектным тестом не переоценены.

Отдельный timeout чтения постороннего QimenIOS.xcodeproj зафиксирован в Mac discovery; абсолютная полнота чтения Mac не заявляется.

RECOVERY CLASS: C для всего runtime продукта: сохранность кода проверена на текущем Git, но независимое выживание archives/keys и live-данных не доказано. Обычное восстановление проверенных исходников при доступном Hetzner PASS; полный disaster restore при потере всех хостов/устройств NOT_RUN. Наличие документации Drive не означает A.

## Порядок восстановления и NEXT

Прочитать NHN Version, branch/state/AGENTS; проверить Git или bundle; изолированно клонировать рабочий SHA и нужный handoff; сверить refs/fsck/hashes; отдельно проверить установку в подходящей Linux-среде. Не устанавливать R04 поверх работающего Beget R03 по одному наличию кода.

BLOCKED: обычный pre-receive отклонил серверный SSH push, ключ не управляется Forgejo. Automatic approval review отклонила чтение bootstrap-token; credential не прочитан, hooks не обойдены. Нужен явный доступ к существующему automation API-токену только для этого private repo либо штатная write identity. После разрешения — добавочная публикация и независимый clone. Функциональная разработка остаётся на паузе.

NHN 1.7.0 фактически прочитана через exact LIVE, девять модульных хешей совпали. Временная недоступность Drive tools снята реальным чтением в 17:10; переподключение Google не требовалось.
