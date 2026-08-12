# Telegram sozlash va tokenni almashtirish

> **Live status (2026-08-11).** The webhook points at the active deployment
> (id ending `…DtCA2W`) and the `processPendingTelegramJobs` trigger runs every
> 5 minutes — now performing the task scan as well as the queue drain, so it is
> the only trigger needed. Debug logging no longer records request bodies, so
> the webhook secret can no longer reach `Telegram_Debug_Log` — but rows written
> *before* that change may still contain the old secret, and rotating it is
> still outstanding. See [LIVE_STATE.md](LIVE_STATE.md).
>
> **Backend deployments no longer change any of this.** CI pushes code into the
> same Apps Script project and redeploys the same deployment id, so the webhook
> URL, the verification secret and every Script Property below stay exactly as
> they are and never need re-entering. See [DEPLOYMENT.md](DEPLOYMENT.md).

> **⚠️ MUHIM — eski token buzilgan deb hisoblanadi.**
> `7752185432` bot ID'siga tegishli **ikkita** token ochiq holda GitHub'ga
> yuklangan (2026-02-02 dan buyon) va git tarixida hozir ham mavjud.
> Ular **darhol BotFather orqali bekor qilinishi** kerak. Kodni tozalash
> yetarli emas — tarixdagi nusxalarni har kim o'qiy oladi.

---

## 1. Eski tokenni bekor qilish (birinchi qadam)

1. Telegram'da [@BotFather](https://t.me/BotFather) ni oching.
2. `/mybots` → botni tanlang → **API Token** → **Revoke current token**.
3. BotFather yangi token beradi. Uni **hech qayerga nusxa qilib qo'ymang** —
   to'g'ridan-to'g'ri quyidagi 3-bosqichga o'ting.

Eski token bekor qilinganidan keyin git tarixidagi nusxalar zararsiz bo'ladi.

## 2. Script Properties'ni tayyorlash

Apps Script muharririda: **⚙️ Project Settings → Script Properties → Add script property**.

| Property | Majburiy | Nima |
|---|---|---|
| `OMAD_ADMIN_KEY` | ha | Sozlamalarni saqlash uchun maxfiy parol. O'zingiz o'ylab toping (uzun, tasodifiy). |
| `TELEGRAM_BOT_TOKEN` | ha | BotFather bergan yangi token. Panel orqali ham kiritish mumkin. |
| `TELEGRAM_AUTHORIZED_USER_ID` | ha | `/yangi` dan foydalanishga ruxsat etilgan yagona Telegram raqamli ID. |
| `TELEGRAM_GROUP_CHAT_ID` | ha | Hisobotlar yuboriladigan guruh ID (masalan `-1001234567890`). |

`OMAD_ADMIN_KEY` **faqat** shu yerda o'rnatiladi — u brauzer orqali o'zgartirilmaydi.
Qolgan uchtasini panel orqali kiritish qulayroq.

### Telegram user ID'ni qanday bilish mumkin

Telegram'da [@userinfobot](https://t.me/userinfobot) ga yozing. U sizning
doimiy raqamli `id` ingizni qaytaradi. **Username emas, raqam kerak** — username
o'zgarishi va boshqa odam tomonidan egallanishi mumkin.

### Guruh ID'ni qanday bilish mumkin

Botni guruhga qo'shing, guruhda biror xabar yozing, so'ng brauzerda oching:
`https://api.telegram.org/bot<TOKEN>/getUpdates` — javobdagi
`message.chat.id` guruh ID'si (odatda `-100...` bilan boshlanadi).

### Vazifalar guruhi uchun raqamli ID

**Vazifalar Guruhi ID** (`TELEGRAM_TASKS_GROUP_CHAT_ID`) faqat **raqamli**
chat ID bo'lishi kerak, masalan `-1001234567890`. `@username` qabul
qilinmaydi — saqlashda xato qaytariladi, va Script Properties'da eskidan
qolgan `@username` "sozlanmagan" deb o'qiladi.

Sababi: hisobot guruhidan farqli o'laroq (u faqat xabar yuboriladigan
manzil), vazifalar guruhi har bir kelayotgan tugma bosilishi va rasm uchun
`chat.id` bilan solishtiriladi. Telegram esa yangilanishlarda faqat raqamni
yuboradi — `@username` bilan xabar yuborish ishlaydi, lekin hech qanday
javob mos kelmaydi va hammasi jimgina tashlab yuboriladi.

Raqamli ID'ni olish:

1. botni guruhga qo'shing va guruhda biror xabar yozing;
2. `https://api.telegram.org/bot<TOKEN>/getUpdates` ni oching va
   `message.chat.id` ni oling; yoki
3. guruhga `@userinfobot` kabi botni qo'shib, u ko'rsatgan ID'ni oling.

Superguruhga aylantirilgan guruhning ID'si o'zgaradi (`-100...` prefiksi
qo'shiladi) — bunday holda ID'ni qayta kiriting.

## 3. Panel orqali kiritish

**Omad Admin → Sozlamalar → Telegram**:

1. **Admin Kaliti** — `OMAD_ADMIN_KEY` qiymatini kiriting.
2. **Bot Tokeni** — BotFather bergan yangi token.
3. **Ruxsat Etilgan Telegram User ID** — 2-bosqichdagi raqam.
4. **Hisobot Guruhi ID** — guruh ID.
5. **💾 Saqlash / Tokenni Almashtirish** tugmasini bosing.
6. **🔌 Ulanish** — bot javob berayotganini tekshiradi (`getMe`).
7. **✉️ Test Xabar** — guruhga sinov xabari yuboradi.
8. **🔄 Webhook** — webhook'ni Apps Script `/exec` manziliga ulaydi.

Saqlangandan keyin token maydoni tozalanadi va token **hech qachon qaytarib
ko'rsatilmaydi**. Panel faqat "O'rnatilgan / O'rnatilmagan" holatini ko'rsatadi.
Tokenni almashtirish uchun shunchaki yangi tokenni kiritib qayta saqlang.

## 4. Tokenni almashtirish (rotatsiya)

1. BotFather → **Revoke current token** → yangi token.
2. Panelda **Bot Tokeni** ga yangi tokenni kiriting → **Saqlash**.
3. **🔌 Ulanish** va **✉️ Test Xabar** bilan tekshiring.
4. **🔄 Webhook** ni qayta ishga tushiring (token almashgach webhook qayta ulanishi kerak).

Eski token shu zahoti ishlamay qoladi. Ilova kodini o'zgartirish shart emas.

---

## Xavfsizlik modeli

| | Qayerda saqlanadi | Brauzerga yuboriladimi |
|---|---|---|
| Bot token | Apps Script Script Properties | ❌ hech qachon |
| Admin kaliti | Apps Script Script Properties | ❌ hech qachon (faqat kiritiladi) |
| Ruxsat etilgan user ID | Script Properties | ✅ ha (maxfiy emas) |
| Guruh ID | Script Properties | ✅ ha (maxfiy emas) |

| Webhook maxfiy kaliti | Script Properties (`TELEGRAM_WEBHOOK_SECRET`) | ❌ hech qachon |

- Frontend hech qachon `api.telegram.org` ga to'g'ridan-to'g'ri murojaat qilmaydi.
- **Umumiy Telegram proksi yo'q.** Ilgari mavjud bo'lgan `telegram_send`,
  `telegram_edit` va `telegram_delete` amallari butunlay olib tashlandi — ular
  autorizatsiyasiz har kimga ixtiyoriy xabar yuborish imkonini berardi.
  Brauzer endi faqat **biznes amalini** yuboradi (`save_omad` +
  `telegramReport: { operation }`, `close_day`), xabar matni esa serverda,
  saqlangan ma'lumot asosida tuziladi.
- Telegram hisoboti **alohida qayta urinuvchi vazifa** (`Omad_Job_Queue`).
  Telegram ishlamasa ham moliyaviy yozuv saqlanadi va hisobot keyinroq
  yuboriladi.
- Tashqaridan chaqiriladigan Telegram amallari (`save_telegram_settings`,
  `test_telegram_connection`, `send_telegram_test_message`,
  `configure_telegram_webhook`) **admin kaliti**, **so'rov chastotasi
  cheklovi** (daqiqasiga 10 ta) va **maydon uzunligi cheklovi** bilan
  himoyalangan.
- Loglar va xato xabarlari `redactSecrets_()` orqali filtrlanadi — token
  ko'rinishidagi har qanday satr `[REDACTED]` bilan almashtiriladi.
- Audit jurnali (`Omad_Audit_Log`) faqat **qaysi maydonlar** o'zgarganini
  yozadi, qiymatlarni emas.

## Webhook'ni tekshirish

Apps Script veb-ilovasi HTTP sarlavhalarini o'qiy olmaydi, shuning uchun
Telegram'ning `X-Telegram-Bot-Api-Secret-Token` sarlavhasini ko'rib bo'lmaydi.
Hozirda mavjud eng ishonchli usul — **maxfiy kalitni webhook manzilining
o'ziga joylash**:

1. **🔄 Webhook** tugmasi bosilganda server tasodifiy kalit yaratadi va uni
   `TELEGRAM_WEBHOOK_SECRET` Script Property'sida saqlaydi.
2. `setWebhook` ga `https://.../exec?wh=<kalit>` manzili va qo'shimcha
   `secret_token` yuboriladi.
3. Har bir kelayotgan yangilanish `wh` parametri bo'yicha tekshiriladi.
   Kalitsiz so'rov hech narsani o'zgartirmasdan rad etiladi.

Kalitni faqat Telegram biladi; u brauzerga hech qachon qaytarilmaydi.
Panel faqat "kalit o'rnatilganmi" holatini ko'rsatadi.

> Kalit hali o'rnatilmagan bo'lsa (eski o'rnatish), webhook vaqtincha
> tekshirilmasdan qabul qilinadi. **🔄 Webhook** ni bir marta bosish kifoya.

### Kalitni almashtirish (rotatsiya)

**Sozlamalar → Tizim → Ma'lumotlarni Tuzatish → Webhook Kalitini Almashtirish**
(`rotate_telegram_webhook_secret`, admin kaliti talab qilinadi):

1. yangi tasodifiy kalit yaratiladi;
2. **eski kalit vaqtincha qabul qilinaveradi** — shu sababli Telegram hali
   yangi manzilni bilmagan paytda kelgan yangilanish ham rad etilmaydi;
3. `setWebhook` yangi manzil bilan chaqiriladi;
4. `getWebhookInfo` bilan tasdiqlanadi;
5. tasdiqlangach eski kalit darhol o'chiriladi.

Biror bosqich muvaffaqiyatsiz bo'lsa, eski kalit qaytariladi **va webhook
o'sha eski kalitga qayta ulanadi** — ya'ni muvaffaqiyatsiz rotatsiya botni
ishlamay qolgan holatda qoldirmaydi. Kalit hech qachon brauzerga
qaytarilmaydi va logga yozilmaydi.

Eski loglarni tozalash uchun avval **Loglarni Tozalash**
(`purge_telegram_debug_secrets`) ni bosing: `Telegram_Debug_Log` nusxasi
olinadi, so'ng har bir qator qaytadan redaksiya qilinadi.

**Tavsiya etilgan tartib:** avval loglarni tozalang, keyin kalitni
almashtiring.

## Hisobot navbati (qayta urinish)

`Omad_Job_Queue` varag'i barcha Telegram hisobot vazifalarini saqlaydi:
`Job_ID, Related_ID, Type, Payload_JSON, Status, Attempts, Next_Attempt_At,
Last_Error, Created_At, Completed_At`.

- Holatlar: `Pending`, `Processing`, `Completed`, `Failed`.
- Birinchi qayta urinish ~30 soniyadan keyin, keyingilari ikki barobar
  ortib boradi. Ko'pi bilan 5 urinish.
- Ikki ishchi bir vazifani bajara olmaydi (`Processing` holati + skript lock).
- Yakunlanmagan vazifalarni muntazam yuborish uchun **vaqt bo'yicha trigger**
  qo'shing: Apps Script → **Triggers** → **Add Trigger** →
  funksiya `processPendingTelegramJobs`, manba *Time-driven*, *Minutes timer*,
  *Every 5 minutes*. **Bu — kerak bo'lgan yagona trigger.** Shu funksiya har
  ishga tushganda avval vazifa jadvalini tekshiradi (kerakli eslatmalarni
  navbatga qo'yadi), keyin navbatni yuboradi. `processTaskSchedules` uchun
  alohida ikkinchi trigger kerak emas.
- Holatni ko'rish: `get_job_queue_status` amali (kalit talab qilinmaydi,
  faqat sanoq qaytaradi). Qo'lda qayta ishga tushirish: `process_jobs`
  (admin kaliti talab qilinadi).

## `/yangi` ruxsati

`/yangi` oqimining **har bir bosqichida** Telegram'ning doimiy raqamli
`from.id` si tekshiriladi:

| Bosqich | Tekshiruv |
|---|---|
| `/yangi` buyrug'i | Gate #1 (`handleOmadTelegramUpdate_`) |
| Turi (Kirim/Chiqim) tugmasi | Gate #1 + Gate #2 (`processOmadCallback_`) |
| Ijarachi / chiqim manbasi tugmasi | Gate #1 + Gate #2 |
| Valyuta tugmasi | Gate #1 + Gate #2 |
| Summa kiritish | Gate #1 + Gate #3 (`processOmadTextStep_`) |
| Izoh kiritish | Gate #1 + Gate #3 |
| Yakuniy saqlash | Gate #4 (yozishdan bevosita oldin) |

Ruxsatsiz foydalanuvchi qisqa rad javobini oladi. Uning uchun **sessiya, cache
yozuvi yoki moliyaviy yozuv yaratilmaydi**.

### Takrorlanishdan himoya

Har bir `/yangi` seansi noyob `sessionId` oladi; u tranzaksiyaning
`Request_ID` ustuniga yoziladi. Yozishdan oldin shu `Request_ID` qidiriladi,
shuning uchun:

- Telegram yangilanishni qayta yuborsa — ikkinchi yozuv yaratilmaydi;
- hisobot yuborishdagi xatolik tranzaksiyani takrorlamaydi;
- seans faqat tranzaksiya saqlangandan **keyin** yopiladi;
- foydalanuvchi hisobot hali yuborilmagan bo'lsa ham "saqlandi" tasdiqini oladi.

Hisobot guruhi faqat hisobot oladi — guruh ichida yozilgan har qanday xabar
(hatto admindan bo'lsa ham) tranzaksiya oqimini boshlamaydi.

---

## Mini App (Telegram ichidagi ilova)

Mini App faqat **`TELEGRAM_AUTHORIZED_USER_ID`** dagi foydalanuvchi uchun
ochiladi — `/yangi` va vazifa yaratish uchun ishlatiladigan **aynan o'sha**
sozlama. Ikkinchi foydalanuvchilar ro'yxati yo'q.

### Qanday tekshiriladi

Telegram Mini App'ga `initData` beradi va uni bot tokenidan olingan kalit bilan
imzolaydi:

```
secret_key = HMAC_SHA256(bot_token, kalit = "WebAppData")
kutilgan   = hex(HMAC_SHA256(data_check_string, kalit = secret_key))
```

Server imzoni tekshiradi, so'ng imzolangan **raqamli** `user.id` ni
`TELEGRAM_AUTHORIZED_USER_ID` bilan solishtiradi. Faqat ikkalasi ham to'g'ri
bo'lsa ma'lumot qaytariladi.

**Ishonilmaydi:** URL'dagi user ID, username, `initDataUnsafe`, brauzerdagi
har qanday saqlangan qiymat. Imzo o'zgartirilsa yoki boshqa token bilan
imzolansa — rad etiladi.

`auth_date` 24 soatdan eski bo'lsa sessiya muddati tugagan hisoblanadi va
ilovani qaytadan ochish kerak bo'ladi.

**Admin kaliti Mini App'ga yuborilmaydi va undan qabul qilinmaydi.** Telefon
ekrani sozlamalarni ochadigan kalit uchun to'g'ri joy emas.

### Sozlash

Mini App manzilini BotFather'da qo'lda saqlash **shart emas**.

**Sozlamalar → Tizim → Mini Appni Sozlash** tugmasi:

1. `getMe` bilan bot ulanishini tekshiradi;
2. `setChatMenuButton` orqali menyu tugmasini Mini App'ga ulaydi;
3. `getChatMenuButton` bilan **qayta o'qib tasdiqlaydi** — `setChatMenuButton`
   Telegram keyinroq ochishdan bosh tortadigan manzil uchun ham `ok: true`
   qaytaradi, shuning uchun yozib qo'yishning o'zi yetarli emas;
4. ruxsat etilgan foydalanuvchi o'rnatilganini tekshiradi;
5. webhook holatini tekshiradi;
6. Mini App tayyor yoki yo'qligini aytadi.

Manzil: `https://mybizmanager.pages.dev/mini` (Cloudflare Pages).

---

## Git tarixidan sirni o'chirish (ixtiyoriy)

Token BotFather orqali bekor qilingandan keyin tarixni tozalash **majburiy
emas**, lekin toza tarix uchun:

```bash
# 1. To'liq zaxira
git clone --mirror https://github.com/Khomurod/MyBizManager.git mybizmanager-backup.git

# 2. git-filter-repo (tavsiya etiladi)
pip install git-filter-repo
printf '<ESKI_TOKEN_1>==>[REDACTED]\n<ESKI_TOKEN_2>==>[REDACTED]\n' > /tmp/replacements.txt
git filter-repo --replace-text /tmp/replacements.txt

# 3. Majburiy push (BARCHA fork/clone'lar buziladi)
git push --force --all
git push --force --tags
```

⚠️ Bu barcha commit SHA'larini o'zgartiradi va ochiq PR'larni buzadi.
Buni faqat barcha hamkorlar xabardor bo'lgandan keyin bajaring.
Tarix tozalangach, CI'da `FAIL_ON_HISTORY=1` ni yoqing.

## Tekshirish

```bash
npm test                              # barcha testlar
node scripts/scan-secrets.js          # ishchi katalogni skanerlash
node scripts/scan-secrets.js --history # git tarixini ham skanerlash
```
