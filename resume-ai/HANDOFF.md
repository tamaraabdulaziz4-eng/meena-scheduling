# حزمة تسليم المشروع — cv.rabit.sa (ResumeAI)

> **للمالك:** هذا الملف فيه كل شي يحتاجه المطوّر الجديد **ما عدا القيم السرية نفسها**.
> القيم الحقيقية للمفاتيح محفوظة في Vercel — المطوّر يسحبها بنفسه بأمان (شرح بالأسفل)،
> بدون ما تنكشف في ملف دائم. اقرأ قسم **"تسليم الأسرار بأمان"** في آخر الملف.

آخر تحديث: يُملأ يدوياً عند التسليم · الفرع الحالي: `claude/crawl4ai-install-o0j8wf`

---

## 0) نظرة عامة سريعة

- **المنتج:** محسّن سير ذاتية بالذكاء الاصطناعي، صادق (لا يختلق حقائق)، ثنائي اللغة (عربي RTL + إنجليزي)، سوق السعودية/الخليج.
- **الإطار:** Next.js **16** (App Router) + React 19 + TypeScript + Tailwind CSS v4. **تنبيه:** هذه نسخة Next 16 فيها تغييرات جذرية — `middleware` صار اسمه `proxy` (ملف `proxy.ts`). راجع `AGENTS.md`.
- **الاستضافة:** Vercel (مشروع `resume-ai`) · الدومين `cv.rabit.sa`.
- **التخزين:** لا توجد قاعدة بيانات SQL — كله **key-value** على Vercel Edge Config (أساسي) + Upstash Redis (احتياطي). تفاصيل بالأسفل.
- **الأمان:** لا أسرار في الكود؛ كلها env vars. الجلسات والروابط السحرية **stateless** موقّعة بـHMAC.

---

## 1) وصول GitHub

- **رابط الريبو:** `https://github.com/tamaraabdulaziz4-eng/meena-scheduling`
- **مسار المشروع داخل الريبو:** `resume-ai/` (المشروع في مجلد فرعي، مو في الجذر).
- **الفرع الأحدث:** `claude/crawl4ai-install-o0j8wf` (فيه أحدث التصميم). الفرع الرئيسي: `main`.

### كيف تعطي المطوّر صلاحية Contents: Read & Write (خطوات تسويها أنت)

الخيار الأفضل — **أضفه Collaborator** (أنظف من توكين وأسهل سحب):
1. افتح: `https://github.com/tamaraabdulaziz4-eng/meena-scheduling/settings/access`
2. **Add people** → اكتب يوزره → صلاحية **Write** → Send invitation.

أو **Fine-grained PAT** إذا يبي توكين (تسويه أنت من حسابك — أنا ما أقدر أنشئه نيابة عنك):
1. `https://github.com/settings/personal-access-tokens/new`
2. Token name: `handoff-cvrabit` · Expiration: **7 days**
3. Resource owner: `tamaraabdulaziz4-eng` · Repository access: **Only select repositories** → `meena-scheduling`
4. Permissions → Repository permissions → **Contents: Read and write** (+ Metadata: Read، ينضاف تلقائي)
5. Generate token → انسخه وناوله المطوّر **عبر قناة مشفّرة** (مو إيميل/شات عادي).

---

## 2) متغيرات البيئة — الأسماء والأدوار (القيم تُسحب من Vercel)

> كل هذي مسجّلة في **Vercel → Project resume-ai → Settings → Environment Variables**.
> المطوّر يسحبها كلها دفعة وحدة بأمر واحد بعد ربط المشروع (انظر قسم 5):
> ```
> npx vercel link           # اربط المجلد resume-ai بمشروع resume-ai
> npx vercel env pull .env.local --environment=production
> ```
> هذا ينزّل ملف `.env.local` بكل القيم الحقيقية مباشرة من Vercel — بدون ما أنسخها هنا.

### أساسية لتشغيل الذكاء الاصطناعي (يشغّل /api/interview, /api/build-cv, /api/optimize, /api/suggest, /api/cover-letter, /api/refine, /api/tools)

| المتغير | الدور | test/prod |
|---|---|---|
| `AI_PROVIDER` | مزوّد الـLLM: `nvidia` (افتراضي) أو `anthropic` | prod |
| `NVIDIA_API_KEY` | مفتاح NVIDIA (endpoint مجاني متوافق مع OpenAI) — **المحرّك الأساسي لكل نداءات الذكاء** | prod |
| `AI_MODEL` | اسم الموديل (افتراضي `meta/llama-4-maverick-17b-128e-instruct`) | prod |
| `ANTHROPIC_API_KEY` | بديل لو `AI_PROVIDER=anthropic` (Claude). اختياري | prod |

> **ملاحظة:** `/api/extract` (رفع PDF/Word/txt) **لا يستخدم أي مفتاح AI** — يستخرج النص محلياً بمكتبتي `unpdf` و`mammoth`. يشتغل دائماً.

### الدفع — Paylink (يشغّل /api/pay و /api/pay/verify)

| المتغير | الدور | test/prod |
|---|---|---|
| `PAYLINK_API_ID` | معرّف واجهة Paylink (apiId) | حسب الوضع |
| `PAYLINK_SECRET_KEY` | المفتاح السري لـPaylink — **حسّاس، وصول مالي مباشر** | حسب الوضع |
| `PAYLINK_BASE_URL` | `https://restapi.paylink.sa` (production) أو `https://restpilot.paylink.sa` (test/pilot) | **يحدد test أم live** |
| `NEXT_PUBLIC_PAY_MODE` | وضع الـSDK في الواجهة: `test` أو غيره (production) | يحدد test أم live |
| `PAY_CURRENCY` | العملة (افتراضي SAR) | prod |
| `PRICE_SINGLE` | سعر الباقة المفردة (افتراضي 35) | prod |
| `PRICE_COMPLETE` | سعر الحزمة الكاملة (افتراضي 99) | prod |
| `PRICE_MONTHLY` | سعر الاشتراك الشهري (افتراضي 75) | prod |

> **رابط الـcallback (مسجّل تلقائياً في الطلب، مو webhook منفصل):**
> `https://cv.rabit.sa/pay/callback?lang=<ar|en>` — يُمرَّر لـPaylink في `callBackUrl` عند إنشاء الفاتورة (`app/api/pay/route.ts`).
> Paylink يرجّع المستخدم لهذا الرابط، والصفحة تتحقق من الدفع عبر `/api/pay/verify` (استعلام getInvoice). **لا يعتمد المشروع على webhook وارد** — التحقق pull-based. لو Paylink مسجّل عندهم webhook، تأكد منه في لوحة Paylink.

### الإيميل — Resend (يشغّل الروابط السحرية /api/auth/request + إيصالات /api/email-results)

| المتغير | الدور | test/prod |
|---|---|---|
| `RESEND_API_KEY` | مفتاح Resend لإرسال الإيميلات (magic links + إيصالات) | prod |
| `EMAIL_FROM` | عنوان المُرسِل (لازم دومين مُتحقّق منه في Resend) | prod |
| `RESEND_AUDIENCE_ID` | معرّف جمهور Resend للنشرة/الاشتراك (اختياري) | prod |

### التخزين key-value (الحقوق/الوصول المدفوع + السير المنشورة + السير السحابية)

| المتغير | الدور | test/prod |
|---|---|---|
| `EDGE_CONFIG_ID` | معرّف Vercel Edge Config (المخزن الأساسي) | prod |
| `EDGE_CONFIG_READ_TOKEN` | توكين قراءة سريع عالمي من edge-config.vercel.com | prod |
| `EDGE_CONFIG_TEAM_ID` | معرّف الفريق (للكتابة عبر api.vercel.com) | prod |
| `VERCEL_API_TOKEN` | توكين Vercel API — **يكتب** على Edge Config عند كل عملية شراء | prod |
| `UPSTASH_REDIS_REST_URL` | بديل احتياطي لو Edge Config مو مهيّأ | prod (اختياري) |
| `UPSTASH_REDIS_REST_TOKEN` | توكين Upstash | prod (اختياري) |

### الجلسات والتوكنات

| المتغير | الدور | test/prod |
|---|---|---|
| `ACCESS_SECRET` | **سر توقيع HMAC** لكوكيز الجلسة والروابط السحرية — لو تغيّر، كل الجلسات تبطل | prod |
| `ADMIN_SECRET` | سر مسارات الأدمن (لو مستخدم) | prod |

### روابط ونطاق

| المتغير | الدور | test/prod |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | الأصل العام (`https://cv.rabit.sa`) — يُستخدم في الروابط والـcallback والإيميلات | prod |

### الصوت TTS (اختياري — يشغّل /api/tts و /api/interview-live، المقابلة الصوتية)

| المتغير | الدور | test/prod |
|---|---|---|
| `GEMINI_TTS_KEY` | Google Gemini TTS (الأكثر بشرية، مجاني عبر AI Studio) — المزوّد الأول | prod |
| `GEMINI_TTS_MODEL` | افتراضي `gemini-2.5-flash-preview-tts` | prod |
| `ELEVENLABS_KEY` | ElevenLabs (عربي مرجعي) — احتياطي ثانٍ | prod (اختياري) |
| `ELEVENLABS_VOICE_F` / `ELEVENLABS_VOICE_M` | معرّفات الأصوات أنثى/ذكر | prod (اختياري) |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | Azure Speech — احتياطي ثالث | prod (اختياري) |

### تحليلات/إعلانات (اختياري — كلها dormant لو ما تعيّنت)

| المتغير | الدور |
|---|---|
| `NEXT_PUBLIC_GOOGLE_ADS_ID` / `NEXT_PUBLIC_GOOGLE_ADS_CONV_LABEL` | تتبّع تحويل Google Ads (يُطلق فقط عند دفعة مؤكدة) |
| `NEXT_PUBLIC_META_PIXEL_ID` | Meta Pixel (PageView + Purchase) |
| `META_AD_ACCOUNT_ID` / `META_PAGE_ID` / `META_SYSTEM_USER_TOKEN` | Meta Marketing API (اختياري) |

> `@vercel/analytics` مفعّل تلقائياً في `app/layout.tsx` بدون أي env.

---

## 3) سجل الخدمات الخارجية

| الخدمة | الدور | مسار الكود | لوحة التحكم |
|---|---|---|---|
| **NVIDIA API** (LLM مجاني) | كل نداءات الذكاء (تحسين، بناء، مقابلة، اقتراح، خطاب) | `app/api/*/route.ts` عبر `streamNvidia`؛ المرجع الكامل `app/api/optimize/route.ts` | https://build.nvidia.com (integrate.api.nvidia.com) |
| **Anthropic** (بديل) | بديل الـLLM لو `AI_PROVIDER=anthropic` | `app/api/optimize/route.ts` (`callAnthropic`) | https://console.anthropic.com |
| **Paylink** | الدفع (فواتير + تحقق) | `app/api/pay/route.ts`, `app/api/pay/verify/route.ts`, `app/components/CheckoutButton.tsx` | https://my.paylink.sa |
| **Resend** | إرسال الإيميلات (روابط سحرية + إيصالات) | `app/lib/email.ts`, `app/api/auth/request/route.ts`, `app/api/email-results/route.ts` | https://resend.com/emails |
| **Vercel Edge Config** | مخزن الحقوق/الوصول المدفوع + السير المنشورة + السير السحابية | `app/lib/entitlements.ts`, `app/lib/publicresume.ts`, `app/lib/cvstore.ts` | https://vercel.com/dashboard (Storage → Edge Config) |
| **Upstash Redis** | مخزن احتياطي (fallback) لنفس ما فوق | نفس ملفات lib أعلاه | https://console.upstash.com |
| **Google Gemini TTS** | تحويل النص لصوت (المقابلة الصوتية) | `app/api/tts/route.ts` | https://aistudio.google.com |
| **ElevenLabs / Azure Speech** | احتياطي TTS | `app/api/tts/route.ts` | https://elevenlabs.io · https://portal.azure.com |
| **Vercel** | الاستضافة والنشر والدومين والـEdge Config | كل المشروع | https://vercel.com/dashboard |
| **Vercel Analytics** | تحليلات الزوار | `app/layout.tsx` (`<Analytics/>`) | Vercel → Analytics |
| **Google Ads / Meta Pixel** | تتبّع الإعلانات (اختياري، dormant) | `app/pay/callback/page.tsx`, `app/layout.tsx` | https://ads.google.com · https://business.facebook.com |

> **لا يوجد Sentry أو أي error-tracking حالياً** — يُنصح المطوّر الجديد يضيف واحد.

---

## 4) قاعدة البيانات / التخزين

**لا يوجد SQL/Prisma/Mongo.** التخزين كله key-value (Vercel Edge Config أساسي، Upstash Redis احتياطي).
كل "الجداول" هي مفاتيح بأنماط ثابتة:

| المفتاح (النمط) | القيمة | يُكتب من | الكود |
|---|---|---|---|
| `ent_<base64url(email)>` | epoch ms ينتهي عنده الوصول المدفوع (unlimited) | عند شراء مؤكد | `app/lib/entitlements.ts` |
| `pub_<slug>` | JSON: `{ name, role, text, created }` — سيرة منشورة عامة | عند النشر من الباني | `app/lib/publicresume.ts` (يخدم `/r/[slug]`) |
| `res_<base64url(email)>` | JSON array: سير المستخدم المحفوظة سحابياً | عند الحفظ لحساب مسجّل | `app/lib/cvstore.ts` (يخدم `/api/resumes`) |

- **القراءة:** `https://edge-config.vercel.com/<EDGE_CONFIG_ID>/item/<key>?token=<READ_TOKEN>`
- **الكتابة:** `https://api.vercel.com/v1/edge-config/<EDGE_CONFIG_ID>/items` مع `VERCEL_API_TOKEN` (Bearer).
- **الوصول للوحة:** Vercel Dashboard → Storage → Edge Config → (المخزن) → Items (تشوف/تعدّل يدوياً).
- **بيانات على الجهاز فقط (مو في السحابة):** سجل الفحوصات، مسودّات الباني، تتبّع الوظائف — كلها `localStorage` عبر `app/lib/localdata.ts`. لا تُرفع لأي سيرفر.

**"المخطط" الكامل موجود كتعليقات موثّقة في رؤوس هذي الملفات** — افتح `app/lib/entitlements.ts`, `publicresume.ts`, `cvstore.ts`, `session.ts`.

---

## 5) التشغيل المحلي — خطوة بخطوة

```bash
# 1) استنسخ وادخل مجلد المشروع (المشروع في مجلد فرعي!)
git clone https://github.com/tamaraabdulaziz4-eng/meena-scheduling.git
cd meena-scheduling/resume-ai
git checkout claude/crawl4ai-install-o0j8wf   # أحدث فرع

# 2) نصّب الحزم
npm install

# 3) اسحب متغيرات البيئة الحقيقية من Vercel (يتطلب صلاحية على المشروع)
npm i -g vercel        # أو npx vercel
vercel login
vercel link            # اختر مشروع resume-ai
vercel env pull .env.local --environment=production

# 4) شغّل التطوير
npm run dev            # http://localhost:3000

# أوامر ثانية:
npm run build          # بناء إنتاجي (Turbopack)
npm run start          # تشغيل نسخة مبنية
npm run lint           # فحص ESLint
```

### أجزاء ما تشتغل محلياً (ووش السبب)

- **بدون `.env.local`:** كل نداءات الذكاء (`/api/interview`, `/api/build-cv`, `/api/optimize`) ترجع 502/503 لأن `NVIDIA_API_KEY` مفقود. لازم `vercel env pull` أولاً.
- **الدفع محلياً:** يشتغل مقابل Paylink الحقيقي/التجريبي حسب `PAYLINK_BASE_URL`، لكن رجعة الـcallback تروح لـ`NEXT_PUBLIC_APP_URL` (الإنتاج) — للاختبار المحلي بدّلها لـ`http://localhost:3000` مؤقتاً.
- **التخزين محلياً:** يحتاج توكنات Edge Config؛ بدونها الحقوق/النشر ما تُحفظ (يرجع "no-access" بلطف بدل ما ينكسر).
- **الصوت TTS:** يحتاج `GEMINI_TTS_KEY`؛ بدونه المقابلة الصوتية معطّلة (النص يشتغل عادي).

---

## 6) النشر (Vercel) وربط الدومين

- **المشروع:** Vercel project `resume-ai` (Root Directory = `resume-ai/`).
- **الإعدادات (من `vercel.json`):**
  - Framework: **nextjs**
  - Build command: **`npm run build`**
  - Output: `.next`
  - Region: **`iad1`**
  - Functions بمهلة ممتدة: `app/api/optimize/route.ts` و `app/api/cover-letter/route.ts` → `maxDuration: 300`.
  - (بعض المسارات الأخرى تعرّف `maxDuration` داخل الملف نفسه، مثل build-cv=300، extract=30.)
- **النشر:** أي push على الفرع المنشور، أو يدوياً:
  ```bash
  cd resume-ai
  vercel deploy --prod
  ```
- **قائمة env vars المسجّلة في Vercel:** كلها في القسم 2 أعلاه — شوفها في Settings → Environment Variables، أو `vercel env ls`.
- **الدومين cv.rabit.sa:**
  - مربوط في Vercel → Project `resume-ai` → Settings → **Domains** → `cv.rabit.sa`.
  - الدومين `rabit.sa` مُدار عبر مزوّد DNS (تحقق من السجل: عادة `CNAME cv → cname.vercel-dns.com` أو A record لـVercel).
  - `NEXT_PUBLIC_APP_URL=https://cv.rabit.sa` لازم يطابق الدومين المُنتَج.

---

## 7) خريطة معمارية سريعة (للمطوّر الجديد)

- `app/page.tsx` + `app/ar/page.tsx` → اللاندينق = **"المستشار"** (`app/components/AdvisorLanding.tsx`) — مقابلة محادثة مدفوعة بالعقل.
- **رابط (الـOrb الواحد):** `app/components/orb/OrbProvider.tsx` مركّب في `app/layout.tsx` — orb واحد يعيش عبر كل المسارات؛ كل صفحة تصف مشهده بـ`useOrbScene`. الـCSS في `app/globals.css` (`.ai-orb`).
- **العقل:** `app/api/interview/route.ts` — actions: `turn` (العقل الكامل)، `rephrase`، `gaps`. قانون الصدق (لا اختلاق).
- **القوالب:** `app/components/ResumeTemplate.tsx` + `app/lib/templateCatalog.ts` (10 قوالب، single-column ATS، كشف الاتجاه تلقائياً).
- **الدفع:** `app/components/CheckoutButton.tsx` → `app/api/pay` → `app/pay/callback/page.tsx` → `app/api/pay/verify`.
- **المصادقة:** روابط سحرية stateless — `app/api/auth/{request,verify,me,logout}`, `app/lib/session.ts`.

---

## 8) قضايا معروفة يبدأ منها المطوّر الجديد

- ⚠️ **الميكروفون معطّل بالهيدر:** `next.config.ts` فيه `Permissions-Policy: microphone=()` — هذا **يمنع** ميزة الإدخال الصوتي (المقابلة الصوتية / زر المايك). لو تبي الصوت، عدّلها لـ`microphone=(self)`.
- 🔑 **تدوير المفاتيح:** بعض المفاتيح انكشفت أثناء التطوير — يُنصح **تجديد** `NVIDIA_API_KEY`, `PAYLINK_SECRET_KEY`, `GEMINI_TTS_KEY`, `RESEND_API_KEY`, `ACCESS_SECRET` قبل التسليم النهائي (المهمة #2 في قائمة العمل).
- 🌐 **مزوّد NVIDIA المجاني متذبذب** (~أحياناً 502) — فيه retry صامت، لكن للإنتاج الجاد يُنصح مزوّد مدفوع مستقر أو `AI_PROVIDER=anthropic`.
- 📊 **لا error-tracking** (Sentry مثلاً) — يُنصح إضافته.

---

## تسليم الأسرار بأمان (اقرأه)

**لا تنسخ القيم السرية في هذا الملف ولا في أي شات/إيميل.** الطرق الآمنة:

1. **الأفضل — أضف المطوّر Collaborator على Vercel:**
   Vercel → Project `resume-ai` → Settings → Members → Invite. بعدها هو يسوي `vercel env pull` ويسحب كل القيم بنفسه. **صفر نسخ يدوي.**
2. **أو قناة مشفّرة لمرة واحدة:** شارك المفاتيح عبر 1Password / Bitwarden Send / رسالة تنتهي بالحذف. لا Slack/إيميل عادي.
3. **بعد التسليم:** لو انتهت مهمة المطوّر، احذفه من Vercel/GitHub وجدّد المفاتيح الحسّاسة.

> السبب: المفتاح السري لـPaylink = وصول مالي مباشر، و`ACCESS_SECRET` = انتحال أي مستخدم. تسريبها في ملف يبقى في السجلات والنسخ الاحتياطية حتى بعد حذف الملف.
