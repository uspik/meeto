# Развёртывание Meeto с нуля

Инструкция рассчитана на то, что у вас нет ничего, кроме компьютера с Windows
и токена бота. Все команды можно копировать целиком.

Ориентировочно: **40–60 минут**, из них минут пятнадцать — ожидание DNS.

Обозначения: `meeto.example.com` замените на свой домен, `123.45.67.89` — на IP
вашего сервера. Строки, начинающиеся с `#`, — комментарии, их копировать не нужно.

---

## Шаг 0. Что нужно подготовить

| Что | Где взять | Примерная цена |
|---|---|---|
| Токен бота | [@BotFather](https://t.me/BotFather), команда `/newbot` | бесплатно |
| Домен | Reg.ru, Beget, Timeweb, NIC.ru | 120–1700 ₽ в год |
| VPS | Timeweb, Beget, Selectel, aeza | 300–600 ₽ в месяц |

Минимальная конфигурация сервера: **2 ГБ RAM, 1–2 vCPU, 20 ГБ диска,
Ubuntu 24.04 LTS**. Меньше 2 ГБ не берите — сборка фронтенда не влезет
(на 1 ГБ спасёт swap из шага 3, но лучше не экономить).

---

## Шаг 1. Покупка домена и сервера

1. Купите домен у регистратора. Про выбор зоны и про идентификацию
   через Госуслуги для `.ru` — см. переписку выше.
2. Закажите VPS с **Ubuntu 24.04**. При заказе выберите вход **по SSH-ключу**,
   если провайдер предлагает, — но проще заказать с паролем root и настроить
   ключ вручную на шаге 2, инструкция ниже это учитывает.
3. Запишите IP-адрес сервера — он понадобится дальше.

---

## Шаг 2. Первое подключение с Windows

Откройте **PowerShell** (Win+X → Терминал). OpenSSH встроен в Windows 10/11,
ставить ничего не надо.

Создайте ключ, если у вас его ещё нет:

```powershell
ssh-keygen -t ed25519 -C "meeto"
# три раза Enter: путь по умолчанию, пароль можно не задавать
```

Скопируйте ключ на сервер (введёте пароль root от провайдера один раз):

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@123.45.67.89 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
```

Проверьте вход без пароля:

```powershell
ssh root@123.45.67.89
```

Дальше все команды выполняются **на сервере**, внутри этой SSH-сессии.

---

## Шаг 3. Базовая настройка сервера

Обновите систему и поставьте утилиты:

```bash
apt update && apt upgrade -y
apt install -y curl git ufw fail2ban
```

Заведите отдельного пользователя — под root постоянно работать не стоит:

```bash
adduser --gecos "" meeto          # спросит пароль, придумайте и запомните
usermod -aG sudo meeto
rsync -a ~/.ssh /home/meeto/      # переносим ключ
chown -R meeto:meeto /home/meeto/.ssh
```

Запретите вход по паролю и под root:

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

> Не закрывайте текущую сессию, пока не проверите вход под новым пользователем
> в **соседнем окне** PowerShell: `ssh meeto@123.45.67.89`. Если что-то пойдёт
> не так, старая сессия останется вашим запасным входом.

Настройте фаервол:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

Если на сервере меньше 2 ГБ памяти, добавьте swap:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Дальше работаем под новым пользователем:

```bash
exit                              # выход из root-сессии
```
```powershell
ssh meeto@123.45.67.89
```

---

## Шаг 4. Установка Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Чтобы группа применилась, переподключитесь:

```bash
exit
```
```powershell
ssh meeto@123.45.67.89
```

Проверка — обе команды должны вывести версии, без `sudo`:

```bash
docker --version
docker compose version
```

---

## Шаг 5. DNS: направляем домен на сервер

В панели регистратора откройте управление DNS вашего домена и создайте
**A-запись**:

| Тип | Имя (хост) | Значение | TTL |
|---|---|---|---|
| A | `@` | `123.45.67.89` | 3600 |

Если mini-app будет жить на поддомене (например `app.example.com`),
в поле «Имя» укажите `app` вместо `@`.

Проверьте, что запись разошлась (на сервере):

```bash
dig +short meeto.example.com
# должен вывести ваш IP; если пусто — подождите 10–30 минут и повторите
```

**Не переходите к следующему шагу, пока команда не вернёт IP.** Let's Encrypt
проверяет домен обращением к нему, и без DNS сертификат не выдадут.

---

## Шаг 6. Проект в git

Можно и без git — тогда пропустите этот шаг и переходите к 6Б. Но с git
обновление сервера сводится к одной команде `git pull`, а история правок
позволяет откатиться, если что-то сломали.

### 6А. Создание репозитория (на компьютере, один раз)

Установите git, если его нет, — в PowerShell:

```powershell
winget install --id Git.Git -e
```

Закройте и заново откройте PowerShell, затем представьтесь:

```powershell
git config --global user.name "Ваше Имя"
git config --global user.email "you@example.com"
```

Windows по умолчанию подменяет переводы строк на CRLF, из-за чего shell-скрипты
на Linux перестают запускаться. В репозитории лежит `.gitattributes`, который
это чинит, но проверьте, что git его не перебивает:

```powershell
git config --global core.autocrlf input
```

**Сначала уберите вложенный репозиторий.** В папке `app` уже лежит пустой `.git`,
попавший туда случайно. Если его не удалить, git посчитает `app` подмодулем и
`git add` упадёт с ошибкой `'app/' does not have a commit checked out`:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\Documents\Meeto\app\.git"
```

Создайте репозиторий:

```powershell
cd "$env:USERPROFILE\Documents\Meeto"
git init -b main
git add .
git status
```

**Остановитесь и посмотрите вывод `git status`.** В списке не должно быть
`app/.env`, файлов `*.pem` и папки `node_modules`. Если что-то из этого
попало — значит, `.gitignore` не подхватился, разбирайтесь до коммита:
токен бота и пароль базы, однажды попавшие в историю, оттуда просто так
не убрать.

```powershell
git commit -m "Meeto: бэкенд, бот, mini-app, спецификация и прототип"
```

### 6Б. Выкладка на GitHub

Создайте пустой репозиторий на [github.com/new](https://github.com/new):
имя `meeto`, **без** README, .gitignore и лицензии — они уже есть локально.

Репозиторий делайте **приватным**, если не готовы показывать код публично.
Секретов в нём нет, но приватный проще.

```powershell
git remote add origin https://github.com/ВАШ-АККАУНТ/meeto.git
git push -u origin main
```

При первом `push` откроется окно входа в GitHub — авторизуйтесь через браузер.

### 6В. Клонирование на сервер

**Если репозиторий публичный** — на сервере просто:

```bash
cd ~
git clone https://github.com/ВАШ-АККАУНТ/meeto.git
cd meeto/app
```

**Если приватный** — нужен ключ доступа. На сервере:

```bash
ssh-keygen -t ed25519 -C "meeto-server" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Скопируйте выведенную строку. В GitHub откройте ваш репозиторий →
**Settings** → **Deploy keys** → **Add deploy key** → вставьте ключ,
название `server`, галочку «Allow write access» **не** ставьте.

Затем на сервере:

```bash
ssh -T git@github.com          # ответьте yes на вопрос про отпечаток
git clone git@github.com:ВАШ-АККАУНТ/meeto.git
cd meeto/app
```

Проверьте, что всё на месте:

```bash
ls
# backend  miniapp  nginx  scripts  certbot  docker-compose.yml  .env.example  DEPLOY.md
```

Сделайте скрипты исполняемыми — git сохраняет флаг, но при копировании
через ZIP он теряется:

```bash
chmod +x scripts/*.sh
```

### 6Б-альтернатива. Без git, копированием

Если git не нужен, скопируйте папку с компьютера. В **PowerShell**:

```powershell
scp -r "$env:USERPROFILE\Documents\Meeto\app" meeto@123.45.67.89:~/meeto
```

И на сервере:

```bash
cd ~/meeto
sed -i 's/\r$//' scripts/*.sh      # убираем возможные CRLF от Windows
chmod +x scripts/*.sh
```

---

## Шаг 7. Заполнение .env

```bash
cp .env.example .env
```

Сгенерируйте секреты и сразу посмотрите их:

```bash
echo "JWT_SECRET=$(openssl rand -base64 48)"
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)"
```

Откройте файл и заполните:

```bash
nano .env
```

Что именно менять:

| Переменная | Значение |
|---|---|
| `BOT_TOKEN` | токен от BotFather целиком |
| `BOT_USERNAME` | имя бота без `@` |
| `DOMAIN` | `meeto.example.com` — без `https://` и без слеша |
| `PUBLIC_URL` | `https://meeto.example.com` |
| `LETSENCRYPT_EMAIL` | ваша почта |
| `JWT_SECRET` | из команды выше |
| `POSTGRES_PASSWORD` | из команды выше |
| `DATABASE_URL` | подставьте тот же пароль вместо `ОБЯЗАТЕЛЬНО-ЗАМЕНИТЬ` |

В `nano`: сохранить — `Ctrl+O`, `Enter`; выйти — `Ctrl+X`.

Проверьте, что заглушек не осталось:

```bash
grep -n "ОБЯЗАТЕЛЬНО-ЗАМЕНИТЬ\|example.com" .env
# вывод должен быть пустым
```

---

## Шаг 8. Получение сертификата

Порт 80 сейчас свободен, поэтому certbot возьмёт его сам:

```bash
chmod +x scripts/*.sh
./scripts/init-cert.sh
```

Успешный результат заканчивается строкой вида
`Successfully received certificate` и путём до файлов.

Проверка:

```bash
ls certbot/conf/live/meeto.example.com/
# fullchain.pem  privkey.pem  cert.pem  chain.pem
```

Если получили ошибку — смотрите раздел «Если что-то пошло не так» в конце.

---

## Шаг 9. Запуск

```bash
docker compose up -d --build
```

Первая сборка занимает 3–6 минут: собираются образ Python и фронтенд.

Посмотрите, что всё поднялось:

```bash
docker compose ps
# у db, redis, api, bot, worker, miniapp, nginx, certbot должно быть Up
```

Логи (выход — `Ctrl+C`, контейнеры при этом продолжат работать):

```bash
docker compose logs -f api bot worker
```

Ожидаемые строки: `Application startup complete` у api, `бот запущен` у bot,
`воркер запущен` у worker.

---

## Шаг 10. Проверка

```bash
curl https://meeto.example.com/api/v1/health
# {"status":"ok"}
```

Откройте `https://meeto.example.com` в браузере — увидите экран с замком и
текстом «Откройте приложение из Telegram». **Это правильное поведение**: вход
возможен только через Telegram, потому что подпись `initData` ставит он.

---

## Шаг 11. Настройка бота в BotFather

Откройте [@BotFather](https://t.me/BotFather) и выполните по очереди.

**1. Разрешить домен для авторизации**

```
/setdomain
```
выберите бота → отправьте `meeto.example.com`

**2. Подключить Mini App** — без этого не работают ссылки-приглашения

```
/newapp
```
выберите бота → название `Meeto` → короткое описание → картинку 640×360 →
GIF пропустите (`/empty`) → URL `https://meeto.example.com` →
короткое имя `app`

**3. Кнопка меню в чате с ботом**

```
/mybots
```
ваш бот → **Bot Settings** → **Menu Button** → **Configure menu button** →
отправьте `https://meeto.example.com` → подпись `Открыть Meeto`

**4. Список команд**

```
/setcommands
```
выберите бота и отправьте одним сообщением:

```
today - что сегодня
week - ближайшая неделя
new - создать мероприятие
```

**5. Проверка.** Напишите боту `/start` — придёт приветствие с кнопкой
«Открыть Meeto». Нажмите: должен открыться календарь. Создайте группу,
мероприятие, отметьтесь «Иду».

---

## Шаг 12. Ежедневная эксплуатация

**Обновить код после правок.** На компьютере:

```powershell
cd "$env:USERPROFILE\Documents\Meeto"
git add .
git commit -m "коротко, что поменяли"
git push
```

На сервере:

```bash
cd ~/meeto/app
git pull
docker compose up -d --build
```

Пересобираются только изменившиеся слои, обычно это 20–40 секунд.
Если правили только фронтенд, хватит `docker compose up -d --build miniapp`.

**Откатиться на предыдущую версию,** если обновление всё сломало:

```bash
git log --oneline -5        # найдите хеш рабочего коммита
git checkout <хеш>
docker compose up -d --build
```

Вернуться к последней версии: `git checkout main`.

**Перезапустить один сервис:**

```bash
docker compose restart api
```

**Логи за последний час:**

```bash
docker compose logs --since 1h api
```

**Резервная копия базы:**

```bash
./scripts/backup-db.sh
```

Поставьте её в расписание — раз в сутки в 4 утра:

```bash
crontab -e
# добавьте строку:
0 4 * * * cd /home/meeto/meeto && ./scripts/backup-db.sh >> /var/log/meeto-backup.log 2>&1
```

Скрипт хранит 14 последних дампов. Копию держите **вне сервера** — например,
раз в неделю забирайте на компьютер:

```powershell
scp meeto@123.45.67.89:~/meeto/backups/*.sql.gz "$env:USERPROFILE\Documents\Meeto\backups\"
```

**Восстановление из дампа:**

```bash
gunzip -c backups/meeto-20260809-0400.sql.gz | docker compose exec -T db psql -U meeto meeto
```

**Сертификат** продлевается сам: контейнер `certbot` проверяет каждые 12 часов,
nginx перечитывает конфиг каждые 6 часов. Ничего делать не нужно. Убедиться,
что механизм жив, можно так:

```bash
docker compose run --rm certbot certbot renew --dry-run
```

---

## Приложение А. Если на сервере уже есть nginx или другие сайты

Так бывает, когда на VPS уже живут другие проекты. Занимать порты 80 и 443
нашим контейнером в этом случае нельзя — они уже отданы системному веб-серверу.
Правильное решение: пусть существующий nginx проксирует запросы к Meeto.

### 1. Выяснить, кто занимает порт

```bash
sudo ss -ltnp | grep -E ':80 |:443 '
```

В последней колонке будет имя процесса: `nginx`, `apache2`, `caddy`
или `docker-proxy` (значит, порт держит другой контейнер).

### 2. Переключить Meeto в режим «за чужим nginx»

```bash
cd ~/meeto/app
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.behind-nginx.yml' >> .env
docker compose up -d --build
docker compose ps
```

Теперь наши nginx и certbot не запускаются, а `api` и `miniapp` слушают
только localhost — снаружи они недоступны, что и нужно.

Проверка:

```bash
curl http://127.0.0.1:8000/api/v1/health   # {"status":"ok"}
curl -I http://127.0.0.1:8080              # 200 OK
```

### 3. Добавить сайт в системный nginx

```bash
sudo cp nginx/meeto-site.conf.example /etc/nginx/sites-available/meeto.conf
sudo sed -i "s/MEETO_DOMAIN/$(grep '^DOMAIN=' .env | cut -d= -f2)/" /etc/nginx/sites-available/meeto.conf
sudo ln -s /etc/nginx/sites-available/meeto.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` обязателен: если в конфиге опечатка, reload уронит **все** сайты
на сервере, а не только Meeto.

### 4. Сертификат через системный certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ваш-домен
```

Certbot сам допишет TLS в конфиг, включит редирект с http и поставит
автопродление через systemd-таймер. Проверить:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

Дальше возвращайтесь к шагу 10 основной инструкции — проверке и настройке
BotFather. Скрипт `init-cert.sh` в этом режиме не нужен.

### Если другой веб-сервер — не системный nginx

* **Apache**: аналогично, `ProxyPass /api/ http://127.0.0.1:8000/` и
  `ProxyPass / http://127.0.0.1:8080/`, сертификат — `certbot --apache`.
* **Порты держит контейнер** (в выводе `ss` виден `docker-proxy`): смотрите
  Приложение Б — Meeto подключается к сети прокси, а не публикует порты.

---

## Приложение Б. Если 80/443 держит контейнер Caddy

Caddy получает и продлевает сертификаты сам, поэтому `init-cert.sh` и наш
`certbot` не нужны. Meeto подключается к docker-сети Caddy и наружу не смотрит
вообще — это безопаснее, чем публиковать порты на localhost.

### 1. Узнать сеть и расположение Caddyfile

```bash
docker inspect caddy --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
docker inspect caddy --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Первая команда выведет имя сети (например `remnawave-network`), вторая —
где на хосте лежит `Caddyfile`.

### 2. Включить режим и поднять Meeto

```bash
cd ~/meeto/app
cat >> .env <<'CONF'
COMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml
PROXY_NETWORK=имя-сети-из-первой-команды
CONF

docker compose up -d --build
docker compose ps
```

Проверка, что Caddy видит наши контейнеры по именам:

```bash
docker exec caddy wget -qO- http://meeto-api:8000/api/v1/health
# {"status":"ok"}
```

Если команда не отвечает — контейнеры в разных сетях, перепроверьте
`PROXY_NETWORK`.

### 3. Добавить сайт в Caddyfile

Откройте `Caddyfile` по пути из первой команды и допишите в конец блок из
[`nginx/Caddyfile.snippet`](nginx/Caddyfile.snippet), заменив домен.
Отступы в Caddyfile — табуляции.

Проверьте и примените без перезапуска контейнера:

```bash
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

`validate` перед `reload` обязателен: ошибка в конфиге положит **все** сайты
на этом Caddy, а не только Meeto.

### 4. Проверка

```bash
curl https://ваш-домен/api/v1/health     # {"status":"ok"}
docker logs caddy --tail 20 | grep -i "certificate obtained"
```

Сертификат выдаётся за 10–30 секунд после первого обращения к домену.
Дальше возвращайтесь к шагу 11 — настройке BotFather.

---

## Если что-то пошло не так

**`init-cert.sh` пишет «Порт 80 занят»**
Сначала посмотрите, кто его держит:
```bash
sudo ss -ltnp | grep ':80 '
```
Если это наш же старый запуск — `docker compose down` и повторите.
Если там **чужой** nginx, apache или контейнер другого проекта — не гасите его,
а переходите к **Приложению А**: Meeto встанет за существующий веб-сервер.

**Let's Encrypt: `Timeout during connect` или `DNS problem`**
DNS ещё не разошёлся либо A-запись указывает не туда. Проверьте:
```bash
dig +short meeto.example.com
```
Значение должно совпадать с `curl -s ifconfig.me` на сервере. Также убедитесь,
что 80-й порт открыт: `sudo ufw status`.

**Telegram: «Bot domain invalid» при открытии mini-app**
Не выполнен `/setdomain` либо домен указан с `https://`. Отправляйте только
`meeto.example.com`.

**Mini-app открывается, но виден только замок**
Так и должно быть в обычном браузере. Внутри Telegram — если тоже замок,
проверьте, что `BOT_TOKEN` в `.env` совпадает с токеном бота, через которого
открываете, и что `PUBLIC_URL` совпадает с адресом в BotFather:
```bash
docker compose logs api | grep -i "401\|initData"
```

**`docker compose up` падает на сборке miniapp**
Не хватает памяти. Добавьте swap (шаг 3) и повторите.

**api не стартует, в логах ошибка подключения к базе**
Пароль в `DATABASE_URL` не совпадает с `POSTGRES_PASSWORD`. Исправьте `.env` и:
```bash
docker compose up -d --force-recreate api
```

**Бот молчит**
```bash
docker compose logs bot | tail -50
```
Чаще всего — неверный `BOT_TOKEN` или где-то ещё запущена вторая копия бота
с тем же токеном: Telegram отдаёт обновления только одному получателю.

**Полный сброс данных** (удалит базу, сертификаты останутся):
```bash
docker compose down -v
docker compose up -d --build
```

**`./scripts/init-cert.sh: bad interpreter: /usr/bin/env bash^M`**
Файл приехал из Windows с переводами строк CRLF. Лечится так:
```bash
sed -i 's/\r$//' scripts/*.sh
```
Чтобы не повторялось, на компьютере выполните `git config --global core.autocrlf input`
и убедитесь, что `.gitattributes` лежит в корне репозитория.

**`Unable to create '.git/index.lock': File exists`**
Остался файл блокировки от прерванной или упавшей команды git. Убедитесь, что
никакой git сейчас не работает, и удалите его:
```powershell
Remove-Item -Force "$env:USERPROFILE\Documents\Meeto\.git\index.lock"
```
На сервере: `rm -f .git/index.lock`. Данные при этом не теряются — в `index.lock`
git держит промежуточное состояние индекса, а не ваши файлы.

**`git pull` ругается на локальные изменения**
На сервере вы что-то правили руками. Посмотрите что и решите, нужно ли это:
```bash
git status
git diff
git checkout -- .        # выбросить правки и взять версию из репозитория
```
Файл `.env` под контроль версий не попадает, так что `git pull` его не тронет.
