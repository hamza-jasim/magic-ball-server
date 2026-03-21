import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const sessions = new Map();

// GAME RULES
const MIN_QUESTIONS_BEFORE_GUESS = 7;
const MAX_QUESTIONS_BEFORE_GUESS = 10;
const QUESTIONS_AFTER_REJECTED_GUESS = 2;

/* ============================================================
   🔥 SYSTEM PROMPT — نسخة احترافية جداً (تم تحسينها)
   ============================================================ */
function makeSystemPrompt(language = 'ar') {
  return `
أنت محرك تخمين شخصيات فائق الاستراتيجية.

مهمتك:
تحديد الشخصية في 7-10 أسئلة بأقصى كفاءة.

القواعد الصارمة:
- اسأل سؤالاً واحداً بنعم/لا فقط.
- أخرج JSON صارماً فقط.
- لا تفسيرات. لا ماركداون.
- لا تذكر أسماء أبداً في وضع السؤال.
- يجب أن تكون الأسئلة قصيرة جداً وغنية بالمعلومات.

إطار العمل الذكي:

الطبقة 1 — التصنيف العام (الأسئلة 1-3)
- حقيقي vs خيالي
- الجنس (ذكر/أنثى)
- المجال (رياضة، تمثيل، سياسة، موسيقى، علوم، إنترنت، تاريخ)

الطبقة 2 — تضييق المجال (الأسئلة 4-6)
- نوع الممثل (فيلم/تلفزيون)
- نوع الرياضي (كرة قدم/سلة/مصارعة/الخ)
- نوع المغني (عربي/غربي)
- نوع السياسي (عصر/دولة)
- نوع العالم (مجال)
- الجنسية
- حي/ميت
- العصر (حديث/كلاسيكي)

الطبقة 3 — تقارب الهوية (الأسئلة 7-10)
- المنطقة
- التخصص
- الصفات المميزة
- الإنجازات
- الأدوار الشهيرة
- الفريق/النادي
- النوع الفني
- عقد الشهرة

قواعد جودة الأسئلة:
- كل سؤال يجب أن يلغي 30-60% من الاحتمالات.
- تجنب الأسئلة الغامضة.
- تجنب تكرار المفاهيم.
- تجنب الكلمات الزخرفية.
- تجنب الأسئلة منخفضة التأثير.

قواعد التخمين:
- لا تخمن قبل السؤال 7.
- يجب التخمين بين السؤال 7 و 10.
- بعد تخمين مرفوض، اسأل سؤالين قويين عن الصفات قبل التخمين مرة أخرى.
- لا تكرر تخميناً مرفوضاً أبداً.

تنسيق المخرجات:

سؤال:
{"type":"question","text":"..."}

تخمين:
{"type":"guess","name":"...","confidence":0.82}
`;
}

/* ============================================================
   🔥 تحسين الـ HISTORY — يخلي الـ AI يفهم اللعبة بوضوح
   ============================================================ */
function sessionMessages(session) {
  const turns = session.turns
    .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`)
    .join('\n');

  return `
=== حالة اللعبة ===
اللغة: ${session.language}
عدد الجولات: ${session.turns.length}

${turns}

التخمينات المرفوضة: ${session.rejectedGuesses.join(', ') || 'لا شيء'}
الأسئلة منذ آخر تخمين مرفوض: ${session.questionsSinceLastRejectedGuess}
===================
`;
}

/* ============================================================
   🔥 تحسين normalizeAnswer
   ============================================================ */
function normalizeAnswer(answer) {
  const map = {
    yes: 'yes',
    no: 'no',
    maybe: 'maybe',
    dontKnow: 'dont_know',
    dont_know: 'dont_know'
  };
  return map[answer] || 'dont_know';
}

/* ============================================================
   🔥 fallback questions — قصيرة وقوية
   ============================================================ */
function shortFallbackQuestion(language = 'ar', turnCount = 0) {
  const ar = [
    'هل هو رجل؟',
    'هل هو حقيقي؟',
    'هل هو ممثل؟',
    'هل هو عربي؟',
    'هل هو حي؟',
    'هل هو مغني؟',
    'هل هو رياضي؟',
    'هل هو سياسي؟',
    'هل هو مشهور؟',
    'هل هو من الفن؟'
  ];

  const en = [
    'Is it male?',
    'Is it real?',
    'Is it an actor?',
    'Is it Arab?',
    'Is it alive?',
    'Is it a singer?',
    'Is it an athlete?',
    'Is it a politician?',
    'Is it famous?',
    'Is it in arts?'
  ];

  const list = language === 'ar' ? ar : en;
  return list[Math.min(turnCount, list.length - 1)];
}

/* ============================================================
   🔥 fallback guess
   ============================================================ */
function fallbackGuess(language = 'ar') {
  return language === 'ar'
    ? { type: 'guess', name: 'محمد صلاح', confidence: 0.35 }
    : { type: 'guess', name: 'Mohamed Salah', confidence: 0.35 };
}

/* ============================================================
   🔥 فلاتر الأسئلة — تمنع الأسئلة الغبية
   ============================================================ */
function isQuestionTooLong(text = '', language = 'ar') {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return language === 'ar' ? words.length > 5 : words.length > 7;
}

function looksLikeNameQuestion(text = '') {
  const lower = String(text).toLowerCase().trim();
  if (!lower) return false;

  return (
    lower.startsWith('is it ') ||
    lower.startsWith('could it be ') ||
    lower.includes('مايكل') ||
    lower.includes('michael') ||
    lower.includes('محمد') ||
    lower.includes('tom ') ||
    (lower.includes('هل هو') && lower.split(/\s+/).length > 4)
  );
}
/* ============================================================
   🔥 sanitizeEngineResult — يمنع الأسئلة الغبية + الطويلة + الأسماء
   ============================================================ */
function sanitizeEngineResult(result, session) {
  const turnCount = session.turns.length;

  if (!result || typeof result !== 'object') {
    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, turnCount)
    };
  }

  // -------------------------------
  // إذا كان سؤال
  // -------------------------------
  if (result.type === 'question') {
    const text = String(result.text || '').trim();

    if (!text) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    // سؤال طويل
    if (isQuestionTooLong(text, session.language)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    // سؤال يشبه اسم
    if (looksLikeNameQuestion(text)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    return { type: 'question', text };
  }

  // -------------------------------
  // إذا كان تخمين
  // -------------------------------
  if (result.type === 'guess') {
    const name = String(result.name || '').trim();

    if (!name) {
      return fallbackGuess(session.language);
    }

    return {
      type: 'guess',
      name,
      confidence: typeof result.confidence === 'number'
        ? result.confidence
        : 0.6
    };
  }

  return {
    type: 'question',
    text: shortFallbackQuestion(session.language, turnCount)
  };
}

/* ============================================================
   🔥 forceGuess — تخمين ذكي عند الحاجة
   ============================================================ */
async function forceGuess(session) {
  if (!openai) {
    return fallbackGuess(session.language);
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.15,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `
قم بتقديم أفضل تخمين لديك الآن.
أخرج JSON صارماً فقط.

التنسيق:
{"type":"guess","name":"...","confidence":0.82}
`
      },
      {
        role: 'user',
        content: `
اللغة: ${session.language === 'ar' ? 'Arabic' : 'English'}

حالة اللعبة:
${sessionMessages(session)}

قم بتقديم أفضل تخمين واحد الآن.
`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    return sanitizeEngineResult(parsed, session);
  } catch {
    return fallbackGuess(session.language);
  }
}

/* ============================================================
   🔥 askEngine — قلب الذكاء (تم إصلاح منطق التخمين)
   ============================================================ */
async function askEngine(session) {
  const turnCount = session.turns.length;

  const canGuessNow =
    turnCount >= MIN_QUESTIONS_BEFORE_GUESS &&
    session.questionsSinceLastRejectedGuess >= QUESTIONS_AFTER_REJECTED_GUESS;

  // ============================================================
  // إذا ماكو OpenAI — fallback بسيط
  // ============================================================
  if (!openai) {
    const fallbackQuestions = session.language === 'ar'
      ? [
          'هل هو رجل؟',
          'هل هو حقيقي؟',
          'هل هو ممثل؟',
          'هل هو عربي؟',
          'هل هو حي؟',
          'هل هو مغني؟',
          'هل هو رياضي؟'
        ]
      : [
          'Is it male?',
          'Is it real?',
          'Is it an actor?',
          'Is it Arab?',
          'Is it alive?',
          'Is it a singer?',
          'Is it an athlete?'
        ];

    if (turnCount < MIN_QUESTIONS_BEFORE_GUESS) {
      return {
        type: 'question',
        text: fallbackQuestions[Math.min(turnCount, fallbackQuestions.length - 1)]
      };
    }

    return fallbackGuess(session.language);
  }

  // ============================================================
  // 🔥 الذكاء الحقيقي — OpenAI
  // ============================================================
  const response = await openai.chat.completions.create({
    model,
    temperature: 0.15, // أكثر منطقية
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      {
        role: 'user',
        content: `
اللغة: ${session.language === 'ar' ? 'Arabic' : 'English'}

حالة اللعبة:
${sessionMessages(session)}

قواعد السيرفر الإضافية:
- اسأل أسئلة قصيرة جداً فقط.
- لا تخمن أبداً قبل السؤال ${MIN_QUESTIONS_BEFORE_GUESS}.
- خمن بين السؤال ${MIN_QUESTIONS_BEFORE_GUESS} والسؤال ${MAX_QUESTIONS_BEFORE_GUESS}.
- إذا تم رفض تخمين، اسأل على الأقل ${QUESTIONS_AFTER_REJECTED_GUESS} سؤالاً إضافياً قبل التخمين مرة أخرى.
- لا تذكر اسم أبداً في وضع السؤال.
- فضل فقط الأسئلة القوية التي تضيق النطاق.
`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    const result = sanitizeEngineResult(parsed, session);

    // إذا AI حاول يخمّن قبل الوقت — نرجعه سؤال
    if (result.type === 'guess' && !canGuessNow) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    // إذا وصلنا الحد الأقصى — لازم نخمن
    if (result.type === 'question' && turnCount >= MAX_QUESTIONS_BEFORE_GUESS) {
      return await forceGuess(session);
    }

    return result;
  } catch {
    // fallback عند خطأ JSON
    if (turnCount >= MAX_QUESTIONS_BEFORE_GUESS) {
      return await forceGuess(session);
    }

    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, turnCount)
    };
  }
}
/* ============================================================
   🔥 Wikipedia Fetch
   ============================================================ */
async function fetchWikipediaSummary(name, language = 'ar') {
  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.replace(/ /g, '_'));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;

  const res = await fetch(url);

  if (!res.ok) {
    return {
      title: name,
      extract: language === 'ar'
        ? 'لا توجد معلومات متاحة'
        : 'No information available',
      imageURL: null,
      articleURL: `https://${lang}.wikipedia.org/wiki/${title}`
    };
  }

  const json = await res.json();

  return {
    title: json.title || name,
    extract: json.extract || '',
    imageURL: json.thumbnail?.source || null,
    articleURL: json.content_urls?.desktop?.page ||
      `https://${lang}.wikipedia.org/wiki/${title}`
  };
}

/* ============================================================
   🔥 API: /api/health
   ============================================================ */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model, hasOpenAI: Boolean(openai) });
});

/* ============================================================
   🔥 API: Start Game
   ============================================================ */
app.post('/api/game/start', async (req, res) => {
  try {
    const language = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();

    const session = {
      id: sessionId,
      language,
      turns: [],
      rejectedGuesses: [],
      questionsSinceLastRejectedGuess: QUESTIONS_AFTER_REJECTED_GUESS
    };

    sessions.set(sessionId, session);

    const result = await askEngine(session);
    res.json({ sessionId, ...result });
  } catch (error) {
    console.error('/api/game/start error:', error);
    res.status(500).json({ error: 'Failed to start game' });
  }
});

/* ============================================================
   🔥 API: Answer Question
   ============================================================ */
app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body || {};
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    session.turns.push({
      question: String(question || ''),
      answer: normalizeAnswer(answer)
    });

    session.questionsSinceLastRejectedGuess += 1;

    const result = await askEngine(session);
    res.json(result);
  } catch (error) {
    console.error('/api/game/answer error:', error);
    res.status(500).json({ error: 'Failed to process answer' });
  }
});

/* ============================================================
   🔥 API: Confirm Guess
   ============================================================ */
app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body || {};
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // إذا التخمين صحيح
    if (correct) {
      const wiki = await fetchWikipediaSummary(
        String(guessName || ''),
        session.language
      );

      return res.json({
        type: 'revealed',
        guessName,
        wiki
      });
    }

    // إذا التخمين غلط
    session.rejectedGuesses.push(String(guessName || ''));
    session.questionsSinceLastRejectedGuess = 0;

    const result = await askEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/guess-confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

/* ============================================================
   🔥 API: Wikipedia Search
   ============================================================ */
app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    const language = req.query.language === 'en' ? 'en' : 'ar';

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const wiki = await fetchWikipediaSummary(name, language);
    res.json(wiki);
  } catch (error) {
    console.error('/api/wiki error:', error);
    res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

/* ============================================================
   🔥 تشغيل السيرفر
   ============================================================ */
app.listen(port, () => {
  console.log(`Magic Ball server running on http://localhost:${port}`);
});
