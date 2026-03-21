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
   🔥 SYSTEM PROMPT — نسخة احترافية جداً
   ============================================================ */
function makeSystemPrompt(language = 'ar') {
  return `
You are an ultra‑strategic character‑guessing engine.

MISSION:
Identify the character in 7–10 questions with maximum efficiency.

STRICT RULES:
- Ask ONE yes/no question only.
- Output STRICT JSON only.
- No explanations. No markdown.
- Never mention names during question mode.
- Questions must be extremely short and high‑information.

INTELLIGENCE FRAMEWORK:

LAYER 1 — Broad Classification (Q1–Q3)
- real vs fictional
- gender
- domain (sports, acting, politics, music, science, internet, history)

LAYER 2 — Domain Narrowing (Q4–Q6)
- actor type (film/TV)
- athlete type (football/basketball/wrestling/etc)
- singer type (arabic/western)
- politician type (era/country)
- scientist type (field)
- nationality
- alive/dead
- era (modern/classic)

LAYER 3 — Identity Convergence (Q7–Q10)
- region
- specialty
- iconic traits
- achievements
- signature roles
- team/club
- genre
- decade of fame

QUESTION QUALITY RULES:
- Every question must eliminate 30–60% of possibilities.
- Avoid vague questions.
- Avoid repeating concepts.
- Avoid decorative words.
- Avoid low‑impact questions.

GUESSING RULES:
- Never guess before question 7.
- Must guess between Q7–Q10.
- After a rejected guess, ask 2 strong trait questions before guessing again.
- Never repeat a rejected guess.

OUTPUT FORMAT:

Question:
{"type":"question","text":"..."}

Guess:
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
=== GAME STATE ===
Language: ${session.language}
Turns: ${session.turns.length}

${turns}

Rejected guesses: ${session.rejectedGuesses.join(', ') || 'none'}
Questions since last rejected guess: ${session.questionsSinceLastRejectedGuess}
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
Make your single best guess now.
Return STRICT JSON only.

Format:
{"type":"guess","name":"...","confidence":0.82}
`
      },
      {
        role: 'user',
        content: `
Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionMessages(session)}

Make the best single guess now.
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
   🔥 askEngine — قلب الذكاء
   ============================================================ */
async function askEngine(session) {
  const turnCount = session.turns.length;

  // يمنع التخمين بعد أول رفض
  const canGuessNow =
    session.rejectedGuesses.length === 0 &&
    turnCount >= MIN_QUESTIONS_BEFORE_GUESS &&
    session.questionsSinceLastRejectedGuess >= QUESTIONS_AFTER_REJECTED_GUESS;

  // نرسل الحالة للذكاء
  const result = await openai.chat.completions.create({
    model,
    temperature: 0.15,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: makeSystemPrompt(session.language) },
      {
        role: "user",
        content: sessionMessages(session)
      }
    ]
  });

  const raw = result.choices[0]?.message?.content || "{}";
  let parsed = {};

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { type: "question", text: shortFallbackQuestion(session.language, turnCount) };
  }

  // إذا اللاعب رفض التخمين الأول → امنع التخمين نهائياً
  if (session.rejectedGuesses.length > 0 && parsed.type === "guess") {
    return {
      type: "question",
      text: shortFallbackQuestion(session.language, turnCount)
    };
  }

  // إذا مو وقت التخمين → نحوله سؤال
  if (parsed.type === "guess" && !canGuessNow) {
    return {
      type: "question",
      text: shortFallbackQuestion(session.language, turnCount)
    };
  }

  return sanitizeEngineResult(parsed, session);
}

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
Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionMessages(session)}

Extra server rules:
- Ask very short questions only.
- Never guess before question ${MIN_QUESTIONS_BEFORE_GUESS}.
- Guess between question ${MIN_QUESTIONS_BEFORE_GUESS} and question ${MAX_QUESTIONS_BEFORE_GUESS}.
- If a guess was rejected, ask at least ${QUESTIONS_AFTER_REJECTED_GUESS} more questions before guessing again.
- Never mention a name in question mode.
- Prefer strong narrowing questions only.
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
