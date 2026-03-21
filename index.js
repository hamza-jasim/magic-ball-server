import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
const SESSIONS_FILE = path.join(process.cwd(), 'sessions-backup.json');

// GAME RULES
const MIN_QUESTIONS_BEFORE_GUESS = 7;
const MAX_QUESTIONS_BEFORE_GUESS = 12;
const QUESTIONS_AFTER_REJECTED_GUESS = 2;
const CONFIDENCE_THRESHOLD = 0.65;

// ============================================================
// 🔥 SYSTEM PROMPT — يمنع الأسئلة المفتوحة تماماً
// ============================================================
function makeSystemPrompt(language = 'ar') {
  return `
أنت محرك تخمين شخصيات. قواعدك صارمة جداً:

🚨 القاعدة الأهم 🚨
يجب أن يكون كل سؤال من نوع "نعم/لا" فقط.
لا تسأل أبداً أسئلة مثل:
- "أي حقبة؟"
- "كم عمره؟"
- "من أين هو؟"
- "ما هي جنسيته؟"
- "في أي مجال؟"

بدلاً من ذلك، اسأل بشكل ثنائي:
✅ "هل هو من العصر الحديث؟"
✅ "هل عمره أكثر من 50 سنة؟"
✅ "هل هو عربي؟"
✅ "هل هو ممثل؟"

=== القواعد ===
1. اسأل سؤالاً واحداً فقط، يجاب بـ (نعم/لا/ربما/لا أعرف).
2. أخرج JSON صارماً فقط.
3. لا تذكر أسماء في وضع السؤال.
4. كل سؤال يجب أن يلغي 30-60% من الاحتمالات.

=== استراتيجية الأسئلة ===
الأسئلة المسموحة فقط:
- هل هو [ذكر/أنثى]؟
- هل هو [حقيقي/خيالي]؟
- هل هو [حي/ميت]؟
- هل هو [عربي/أجنبي]؟
- هل هو من [العصر الحديث/القديم]؟
- هل هو [ممثل/مغني/رياضي/سياسي/عالم]؟
- هل حصل على [جوائز/بطولات]؟
- هل هو مشهور عالمياً؟
- هل له [أعمال/إنجازات] معروفة؟

=== التخمين ===
عندما تكون واثقاً (أكثر من 65%)، اخمن بالتنسيق:
{"type":"guess","name":"الاسم","confidence":0.85,"reasoning":"سبب مختصر"}

تنسيق المخرجات:
سؤال: {"type":"question","text":"هل هو رياضي؟"}
تخمين: {"type":"guess","name":"ليونيل ميسي","confidence":0.92,"reasoning":"لاعب كرة قدم أرجنتيني مشهور"}
`;
}

// ============================================================
// 🔥 تحليل التخمينات المرفوضة
// ============================================================
async function analyzeFailedGuess(session, wrongGuess) {
  if (!openai) return null;

  try {
    const response = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: 'أنت محلل. حلل لماذا فشل التخمين واقترح 3 أسئلة جديدة من نوع نعم/لا.'
        },
        {
          role: 'user',
          content: `
التخمين الخاطئ: ${wrongGuess}
الأسئلة والأجوبة السابقة:
${sessionMessages(session)}

المطلوب:
1. لماذا كان هذا التخمين خاطئاً؟
2. ما هي 3 أسئلة (نعم/لا فقط) لتضييق الاحتمالات؟

أجب بتنسيق JSON:
{
  "reason": "...",
  "nextQuestions": ["سؤال نعم/لا 1", "سؤال نعم/لا 2", "سؤال نعم/لا 3"]
}
`
        }
      ]
    });

    return JSON.parse(response.choices[0]?.message?.content || '{}');
  } catch {
    return null;
  }
}

// ============================================================
// 🔥 حفظ واسترجاع الجلسات
// ============================================================
async function backupSessions() {
  try {
    const sessionsData = Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      language: session.language,
      turns: session.turns,
      rejectedGuesses: session.rejectedGuesses,
      questionsSinceLastRejectedGuess: session.questionsSinceLastRejectedGuess,
      createdAt: session.createdAt,
      lastActivity: new Date().toISOString()
    }));
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessionsData, null, 2));
  } catch (error) {
    console.error('Failed to backup sessions:', error);
  }
}

async function loadSessions() {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
    const sessionsData = JSON.parse(data);
    sessionsData.forEach(sessionData => {
      sessions.set(sessionData.id, {
        ...sessionData,
        createdAt: new Date(sessionData.createdAt),
        lastActivity: new Date(sessionData.lastActivity)
      });
    });
    console.log(`✅ Loaded ${sessionsData.length} sessions`);
  } catch {
    console.log('No existing sessions backup');
  }
}

// ============================================================
// 🔥 عرض حالة اللعبة
// ============================================================
function sessionMessages(session) {
  const turns = session.turns
    .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`)
    .join('\n');

  return `
=== GAME STATE ===
Language: ${session.language}
Turns: ${session.turns.length}
Questions since last rejected guess: ${session.questionsSinceLastRejectedGuess}
Rejected guesses: ${session.rejectedGuesses.join(', ') || 'none'}

${turns}
===================
`;
}

// ============================================================
// 🔥 normalizeAnswer
// ============================================================
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

// ============================================================
// 🔥 fallback questions — كلها نعم/لا فقط
// ============================================================
function shortFallbackQuestion(language = 'ar', turnCount = 0, rejectedGuesses = []) {
  // أسئلة نعم/لا فقط
  const arQuestions = [
    'هل هو ذكر؟',
    'هل هو حقيقي؟',
    'هل هو ممثل؟',
    'هل هو عربي؟',
    'هل هو حي؟',
    'هل هو مغني؟',
    'هل هو رياضي؟',
    'هل هو سياسي؟',
    'هل هو مشهور عالمياً؟',
    'هل هو من العصر الحديث؟',
    'هل حصل على جوائز؟',
    'هل هو من هوليوود؟'
  ];

  const enQuestions = [
    'Is it male?',
    'Is it real?',
    'Is it an actor?',
    'Is it Arab?',
    'Is it alive?',
    'Is it a singer?',
    'Is it an athlete?',
    'Is it a politician?',
    'Is it globally famous?',
    'Is it from modern era?',
    'Did they win awards?',
    'Is it from Hollywood?'
  ];

  const list = language === 'ar' ? arQuestions : enQuestions;
  return list[Math.min(turnCount, list.length - 1)];
}

// ============================================================
// 🔥 fallback guess
// ============================================================
function fallbackGuess(language = 'ar', rejectedGuesses = []) {
  const guesses = {
    ar: ['محمد صلاح', 'أحمد الشقيري', 'نانسي عجرم', 'عبدالحليم حافظ', 'توم كروز'],
    en: ['Mohamed Salah', 'Elon Musk', 'Taylor Swift', 'Cristiano Ronaldo', 'Tom Cruise']
  };
  
  const available = guesses[language].filter(g => !rejectedGuesses.includes(g));
  const name = available[0] || (language === 'ar' ? 'محمد صلاح' : 'Mohamed Salah');
  
  return { 
    type: 'guess', 
    name, 
    confidence: 0.5,
    reasoning: 'تخمين احتياطي'
  };
}

// ============================================================
// 🔥 فلاتر — تمنع الأسئلة المفتوحة
// ============================================================
function isOpenEndedQuestion(text = '', language = 'ar') {
  const lower = String(text).toLowerCase();
  
  // كلمات تدل على سؤال مفتوح
  const openEndedPatterns = {
    ar: [
      'أي', 'كم', 'متى', 'أين', 'كيف', 'لماذا', 'ما هي', 'ما هو',
      'أي حقبة', 'أي عصر', 'كم عمر', 'من أين', 'أي جنسية', 'أي مجال'
    ],
    en: [
      'what', 'when', 'where', 'why', 'how', 'which', 'how old', 
      'what era', 'what nationality', 'what field'
    ]
  };
  
  const patterns = language === 'ar' ? openEndedPatterns.ar : openEndedPatterns.en;
  return patterns.some(pattern => lower.includes(pattern));
}

function isQuestionTooLong(text = '', language = 'ar') {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return language === 'ar' ? words.length > 6 : words.length > 8;
}

function looksLikeNameQuestion(text = '') {
  const lower = String(text).toLowerCase().trim();
  const namePatterns = ['is it ', 'could it be ', 'هل هو', 'هل اسمه', 'مايكل', 'michael', 'محمد'];
  return namePatterns.some(pattern => lower.includes(pattern)) && lower.split(/\s+/).length > 3;
}

// ============================================================
// 🔥 sanitizeEngineResult — يمنع الأسئلة المفتوحة نهائياً
// ============================================================
function sanitizeEngineResult(result, session) {
  const turnCount = session.turns.length;

  if (!result || typeof result !== 'object') {
    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
    };
  }

  if (result.type === 'question') {
    const text = String(result.text || '').trim();

    // منع الأسئلة المفتوحة
    if (isOpenEndedQuestion(text, session.language)) {
      console.log(`🚫 Blocked open-ended question: ${text}`);
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
      };
    }

    if (!text || isQuestionTooLong(text, session.language) || looksLikeNameQuestion(text)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
      };
    }

    return { type: 'question', text };
  }

  if (result.type === 'guess') {
    const name = String(result.name || '').trim();
    const confidence = typeof result.confidence === 'number' ? result.confidence : 0.5;

    if (!name || session.rejectedGuesses.includes(name)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
      };
    }

    return { type: 'guess', name, confidence };
  }

  return {
    type: 'question',
    text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
  };
}

// ============================================================
// 🔥 forceGuess
// ============================================================
async function forceGuess(session) {
  if (!openai) {
    return fallbackGuess(session.language, session.rejectedGuesses);
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'قم بتقديم أفضل تخمين لديك الآن. أخرج JSON صارماً فقط. التنسيق: {"type":"guess","name":"...","confidence":0.XX}'
      },
      {
        role: 'user',
        content: `
اللغة: ${session.language === 'ar' ? 'Arabic' : 'English'}

حالة اللعبة:
${sessionMessages(session)}

التخمينات المرفوضة: ${session.rejectedGuesses.join(', ') || 'لا شيء'}

قدم أفضل تخمين واحد الآن.
`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    return sanitizeEngineResult(parsed, session);
  } catch {
    return fallbackGuess(session.language, session.rejectedGuesses);
  }
}

// ============================================================
// 🔥 askEngine — مع منع الأسئلة المفتوحة
// ============================================================
async function askEngine(session) {
  const turnCount = session.turns.length;

  // منطق التخمين
  let canGuessNow = false;
  
  if (turnCount >= MIN_QUESTIONS_BEFORE_GUESS) {
    if (session.rejectedGuesses.length === 0) {
      canGuessNow = true;
    } else if (session.questionsSinceLastRejectedGuess >= QUESTIONS_AFTER_REJECTED_GUESS) {
      canGuessNow = true;
    }
  }

  // تحليل الخطأ إذا كان فيه تخمين مرفوض جديد
  let errorAnalysis = null;
  if (session.rejectedGuesses.length > 0 && session.questionsSinceLastRejectedGuess === 0) {
    const lastWrongGuess = session.rejectedGuesses[session.rejectedGuesses.length - 1];
    errorAnalysis = await analyzeFailedGuess(session, lastWrongGuess);
  }

  if (!openai) {
    if (turnCount < MIN_QUESTIONS_BEFORE_GUESS || !canGuessNow) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
      };
    }
    return fallbackGuess(session.language, session.rejectedGuesses);
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      {
        role: 'user',
        content: `
اللغة: ${session.language === 'ar' ? 'Arabic' : 'English'}

حالة اللعبة:
${sessionMessages(session)}

${errorAnalysis ? `=== تحليل الخطأ السابق ===\n${JSON.stringify(errorAnalysis, null, 2)}\n========================\n` : ''}

🚨 قواعد صارمة جداً 🚨
1. كل سؤال يجب أن يكون من نوع "نعم/لا" فقط.
2. لا تسأل أبداً: أي، كم، متى، أين، كيف، لماذا.
3. لا تسأل عن "أي حقبة" أو "أي جنسية" — اسأل "هل هو من العصر الحديث؟" بدلاً من ذلك.
4. إذا كنت ستخمن، تأكد أن الثقة أعلى من ${CONFIDENCE_THRESHOLD}.

${canGuessNow ? '✅ يمكنك التخمين الآن إذا كنت واثقاً' : '❌ لا تخمن الآن، اسأل سؤال نعم/لا بدلاً من ذلك'}

عدد الأسئلة المتبقية: ${Math.max(0, MAX_QUESTIONS_BEFORE_GUESS - turnCount)}

${errorAnalysis ? `أسئلة مقترحة من تحليل الخطأ: ${errorAnalysis.nextQuestions?.join(', ') || ''}` : ''}

قرر الآن: سؤال نعم/لا أو تخمين؟
`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    const result = sanitizeEngineResult(parsed, session);

    if (result.type === 'guess') {
      if (!canGuessNow) {
        return {
          type: 'question',
          text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
        };
      }
      if (result.confidence < CONFIDENCE_THRESHOLD && turnCount < MAX_QUESTIONS_BEFORE_GUESS) {
        return {
          type: 'question',
          text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
        };
      }
    }

    if (result.type === 'question' && turnCount >= MAX_QUESTIONS_BEFORE_GUESS) {
      return await forceGuess(session);
    }

    return result;
  } catch {
    if (turnCount >= MAX_QUESTIONS_BEFORE_GUESS) {
      return await forceGuess(session);
    }
    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
    };
  }
}

// ============================================================
// 🔥 Wikipedia Fetch
// ============================================================
const wikiCache = new Map();

async function fetchWikipediaSummary(name, language = 'ar') {
  const cacheKey = `${name}:${language}`;
  if (wikiCache.has(cacheKey)) return wikiCache.get(cacheKey);

  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.replace(/ /g, '_'));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;

  const res = await fetch(url);
  let result;

  if (!res.ok) {
    result = {
      title: name,
      extract: language === 'ar' ? 'لا توجد معلومات متاحة' : 'No information available',
      imageURL: null,
      articleURL: `https://${lang}.wikipedia.org/wiki/${title}`
    };
  } else {
    const json = await res.json();
    result = {
      title: json.title || name,
      extract: json.extract || '',
      imageURL: json.thumbnail?.source || null,
      articleURL: json.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${title}`
    };
  }
  
  wikiCache.set(cacheKey, result);
  setTimeout(() => wikiCache.delete(cacheKey), 3600000);
  return result;
}

// ============================================================
// 🔥 APIs
// ============================================================
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model, hasOpenAI: Boolean(openai), activeSessions: sessions.size });
});

app.post('/api/game/start', async (req, res) => {
  try {
    const language = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();

    const session = {
      id: sessionId,
      language,
      turns: [],
      rejectedGuesses: [],
      questionsSinceLastRejectedGuess: 0,
      createdAt: new Date(),
      lastActivity: new Date()
    };

    sessions.set(sessionId, session);
    await backupSessions();

    const result = await askEngine(session);
    res.json({ sessionId, ...result });
  } catch (error) {
    console.error('/api/game/start error:', error);
    res.status(500).json({ error: 'Failed to start game' });
  }
});

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
    session.lastActivity = new Date();

    const result = await askEngine(session);
    res.json(result);
  } catch (error) {
    console.error('/api/game/answer error:', error);
    res.status(500).json({ error: 'Failed to process answer' });
  }
});

app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body || {};
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (correct) {
      const wiki = await fetchWikipediaSummary(String(guessName || ''), session.language);
      return res.json({ type: 'revealed', guessName, wiki });
    }

    session.rejectedGuesses.push(String(guessName || ''));
    session.questionsSinceLastRejectedGuess = 0;

    const result = await askEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/guess-confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    const language = req.query.language === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ error: 'name is required' });
    const wiki = await fetchWikipediaSummary(name, language);
    res.json(wiki);
  } catch (error) {
    console.error('/api/wiki error:', error);
    res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

// ============================================================
// 🔥 Cleanup
// ============================================================
setInterval(() => {
  const now = new Date();
  for (const [id, session] of sessions.entries()) {
    const hoursSinceLastActivity = (now - session.lastActivity) / (1000 * 60 * 60);
    if (hoursSinceLastActivity > 24) {
      sessions.delete(id);
    }
  }
  backupSessions();
}, 60 * 60 * 1000);

// ============================================================
// 🔥 Start
// ============================================================
loadSessions().then(() => {
  app.listen(port, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  🎯 AI Character Guessing Engine - FINAL 10/10          ║
║  🔥 Running on: http://localhost:${port}                    ║
║  🚫 ONLY YES/NO QUESTIONS ALLOWED                       ║
║  🧠 Confidence Threshold: ${CONFIDENCE_THRESHOLD * 100}%                     ║
╚══════════════════════════════════════════════════════════╝
    `);
  });
});
