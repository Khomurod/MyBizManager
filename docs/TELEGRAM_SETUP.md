# Telegram sozlash va tokenni almashtirish

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

- Frontend hech qachon `api.telegram.org` ga to'g'ridan-to'g'ri murojaat qilmaydi.
  Barcha Telegram chaqiruvlari Apps Script backend orqali o'tadi
  (`telegram_send`, `telegram_edit`, `telegram_delete`).
- Loglar va xato xabarlari `redactSecrets_()` orqali filtrlanadi — token
  ko'rinishidagi har qanday satr `[REDACTED]` bilan almashtiriladi.
- Audit jurnali (`Omad_Audit_Log`) faqat **qaysi maydonlar** o'zgarganini
  yozadi, qiymatlarni emas.

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

Hisobot guruhi faqat hisobot oladi — guruh ichida yozilgan har qanday xabar
(hatto admindan bo'lsa ham) tranzaksiya oqimini boshlamaydi.

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
