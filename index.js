/**
 * Magic Ball — Ultra-Smart AI Character Guessing Game
 *
 * Brain: GPT generates every question dynamically (like Akinator),
 *        using the full conversation history for context.
 *        Static banks are used as instant fallback when AI is unavailable.
 *
 * Rules:
 *  • Min 10, max 15 questions before first guess
 *  • Up to 3 guesses per cycle
 *  • After 3 wrong guesses → 5-10 more targeted questions → guess again
 *  • Language: 'ar' → all Arabic, 'en' → all English
 *  • GPT generates questions AND makes guesses
 */

import express from 'express';
import cors    from 'cors';
import OpenAI  from 'openai';
import crypto  from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json());

const PORT  = Number(process.env.PORT  || 3001);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const openaiApiKey  = process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const openaiBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

const openai = openaiApiKey
  ? new OpenAI({ apiKey: openaiApiKey, ...(openaiBaseUrl ? { baseURL: openaiBaseUrl } : {}) })
  : null;

// ─────────────────────────────────────────────────────────────────────────────
//  GAME CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const INITIAL_MIN  = 10;
const INITIAL_MAX  = 15;
const FOLLOWUP_MIN = 5;
const FOLLOWUP_MAX = 10;
const MAX_GUESSES  = 3;
const SESSION_TTL  = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
//  STATIC FALLBACK QUESTION BANKS (used when AI is unavailable)
// ─────────────────────────────────────────────────────────────────────────────
const FALLBACK_QUESTIONS = {
  ar: [
    'هل الشخصية حقيقية وليست خيالية؟',
    'هل الشخصية لا تزال على قيد الحياة؟',
    'هل الشخصية من الجنس الذكوري؟',
    'هل الشخصية مشهورة عالمياً؟',
    'هل الشخصية رياضي/ة محترف/ة؟',
    'هل الشخصية فنان/ة أو ممثل/ة أو مغني/ة؟',
    'هل الشخصية سياسي/ة أو رئيس/ة دولة؟',
    'هل الشخصية عالم/ة أو مخترع/ة؟',
    'هل الشخصية من العالم العربي أو الشرق الأوسط؟',
    'هل الشخصية وُلدت في القرن العشرين؟',
    'هل الشخصية تلعب كرة القدم؟',
    'هل الشخصية اشتهرت بعد عام 2000؟',
    'هل الشخصية فازت بجائزة دولية مرموقة؟',
    'هل الشخصية أوروبية الجنسية؟',
    'هل الشخصية أمريكية الجنسية؟',
    'هل الشخصية من أمريكا الجنوبية؟',
    'هل الشخصية أفريقية الجنسية؟',
    'هل الشخصية تلعب كرة السلة؟',
    'هل الشخصية ملاكم/ة؟',
    'هل الشخصية سباح/ة؟',
    'هل الشخصية مغني/ة؟',
    'هل الشخصية ممثل/ة في أفلام؟',
    'هل الشخصية من مشاهير الإنترنت؟',
    'هل الشخصية خيالية أو كرتونية؟',
    'هل الشخصية تاريخية قديمة؟',
    'هل الشخصية رجل/إمرأة أعمال؟',
    'هل الشخصية من الأسرة المالكة؟',
    'هل الشخصية كاتب/ة أو روائي/ة؟',
    'هل الشخصية مخرج/ة أفلام؟',
    'هل الشخصية تلعب التنس؟',
  ],
  en: [
    'Is it a real person (not fictional)?',
    'Is the person still alive?',
    'Is it male?',
    'Is the person world-famous?',
    'Is it a professional athlete?',
    'Is it an entertainer (actor, singer, artist)?',
    'Is it a politician or head of state?',
    'Is it a scientist or inventor?',
    'Is the person from the Arab world or Middle East?',
    'Was the person born in the 20th century?',
    'Does the person play football/soccer?',
    'Did the person rise to fame after 2000?',
    'Did the person win a prestigious international award?',
    'Is the person European?',
    'Is the person American?',
    'Is the person South American?',
    'Is the person African?',
    'Does the person play basketball?',
    'Is the person a boxer?',
    'Is the person a swimmer?',
    'Is the person a singer?',
    'Is the person an actor in films?',
    'Is the person an internet celebrity?',
    'Is it a fictional or animated character?',
    'Is it an ancient historical figure?',
    'Is it a business figure or entrepreneur?',
    'Is it royalty (king/queen/prince/princess)?',
    'Is it a writer or novelist?',
    'Is it a film director?',
    'Does the person play tennis?',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION STORE
// ─────────────────────────────────────────────────────────────────────────────
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}, 5 * 60 * 1000);

function newSession(language) {
  return {
    language,
    messages: [],            // full conversation: [{role,content}]
    turns: [],               // structured: [{question,answer}]
    rejectedGuesses: [],
    guessStreak: 0,
    questionsThisPhase: 0,
    totalQuestions: 0,
    minQ: INITIAL_MIN,
    maxQ: INITIAL_MAX,
    cycleCount: 0,
    expiresAt: Date.now() + SESSION_TTL,
    fallbackIndex: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SYSTEM PROMPTS — crafted for maximum Akinator-quality question flow
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(session) {
  const { language: lang, rejectedGuesses, questionsThisPhase, minQ, maxQ, totalQuestions } = session;
  const ar = lang === 'ar';

  const rejectedStr = rejectedGuesses.length > 0
    ? (ar ? `الأسماء المرفوضة (لا تكررها): ${rejectedGuesses.join('، ')}`
           : `Rejected names (do not repeat): ${rejectedGuesses.join(', ')}`)
    : '';

  const canGuess = questionsThisPhase >= minQ;
  const mustGuess = questionsThisPhase >= maxQ;

  if (ar) {
    return `أنت "الكرة السحرية" — لعبة ذكاء اصطناعي لتخمين الشخصيات بأسلوب Akinator.

🎯 مهمتك: اكتشف الشخصية التي يفكر فيها المستخدم من خلال أسئلة ذكية ومدروسة.

📋 قواعد اللعبة:
- اطرح أسئلة بنعم/لا فقط، بالعربية الفصحى السلسة
- ابدأ بأسئلة عامة ثم ضيّق تدريجياً (من الفئة العامة → الجنس → الجنسية → الإنجازات → التفاصيل)
- لا تكرر أسئلة سبق طرحها في المحادثة
- كل سؤال يجب أن يقلّص قائمة المحتملين بشكل كبير
- اطرح سؤالاً واحداً فقط في كل مرة
- لا تذكر اسم الشخصية أثناء الأسئلة

🔢 عدد الأسئلة: طرحت حتى الآن ${questionsThisPhase} سؤال (الحد الأدنى: ${minQ}، الحد الأقصى: ${maxQ})

${mustGuess
  ? '🚨 وصلت للحد الأقصى — يجب التخمين الآن!'
  : canGuess
    ? '✅ يمكنك التخمين إذا كنت واثقاً، أو أكمل الأسئلة إذا أردت مزيداً من الدقة.'
    : `⏳ لا تزال بحاجة لـ ${minQ - questionsThisPhase} سؤال على الأقل قبل التخمين.`
}

${rejectedStr}

📤 صيغة الإجابة:
- للسؤال: {"type":"question","text":"سؤالك هنا؟"}
- للتخمين: {"type":"guess","name":"اسم الشخصية الكامل"}

أجب بـ JSON فقط، بدون أي نص خارجه.`;
  } else {
    return `You are "Magic Ball" — an Akinator-style AI character guessing game.

🎯 Your mission: Identify the character the user is thinking of through smart, strategic questions.

📋 Game Rules:
- Ask yes/no questions only, in natural English
- Start broad, then narrow down progressively (category → gender → nationality → achievements → details)
- NEVER repeat a question already asked in the conversation
- Each question should significantly narrow down the candidates
- Ask exactly ONE question at a time
- Do NOT reveal the character's name during questioning

🔢 Questions asked so far: ${questionsThisPhase} (min: ${minQ}, max: ${maxQ})

${mustGuess
  ? '🚨 Reached maximum — you MUST guess now!'
  : canGuess
    ? '✅ You may guess if confident, or continue asking for more precision.'
    : `⏳ Need at least ${minQ - questionsThisPhase} more questions before guessing.`
}

${rejectedStr}

📤 Response format:
- For a question: {"type":"question","text":"Your question here?"}
- For a guess: {"type":"guess","name":"Full character name"}

Reply with JSON ONLY, no text outside it.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  AI QUESTION / GUESS ENGINE
// ─────────────────────────────────────────────────────────────────────────────
async function runAIEngine(session) {
  if (!openai) return null;

  const systemPrompt = buildSystemPrompt(session);

  // Build the conversation for GPT
  const gptMessages = [
    { role: 'system', content: systemPrompt },
    ...session.messages,
  ];

  // If conversation is empty, start it
  if (session.messages.length === 0) {
    gptMessages.push({
      role: 'user',
      content: session.language === 'ar'
        ? 'فكّرت في شخصية. ابدأ الأسئلة.'
        : "I've thought of a character. Start asking questions.",
    });
  }

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: session.questionsThisPhase >= session.minQ ? 0.1 : 0.7,
      max_tokens: 120,
      messages: gptMessages,
      response_format: { type: 'json_object' },
    });

    const raw = resp.choices?.[0]?.message?.content ?? '';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }

    if (!parsed?.type) return null;

    if (parsed.type === 'question' && parsed.text) {
      return { type: 'question', text: String(parsed.text).trim() };
    }
    if (parsed.type === 'guess' && parsed.name) {
      const name = String(parsed.name).trim();
      // Ensure not returning a rejected name
      if (session.rejectedGuesses.map(r => r.toLowerCase()).includes(name.toLowerCase())) {
        return null; // Force retry
      }
      return { type: 'guess', name };
    }

    return null;
  } catch (e) {
    console.error('[runAIEngine] Error:', e?.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATIC FALLBACK QUESTION
// ─────────────────────────────────────────────────────────────────────────────
function getFallbackQuestion(session) {
  const list = FALLBACK_QUESTIONS[session.language] ?? FALLBACK_QUESTIONS.en;
  const asked = new Set(session.turns.map(t => t.question));
  for (let i = session.fallbackIndex; i < list.length; i++) {
    if (!asked.has(list[i])) {
      session.fallbackIndex = i + 1;
      return { type: 'question', text: list[i] };
    }
  }
  // All fallbacks exhausted
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIKIPEDIA FETCH
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWiki(name, lang) {
  if (!name?.trim()) return null;
  const primaryLang = lang === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.trim().replace(/ /g, '_'));

  const fetchFromLang = async (l) => {
    const url = `https://${l}.wikipedia.org/api/rest_v1/page/summary/${title}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'MagicBallGame/3.0' } });
    if (!r.ok) throw new Error(`Wiki ${l}: ${r.status}`);
    return r.json();
  };

  try {
    const j = await fetchFromLang(primaryLang);
    let imageURL = j.thumbnail?.source ?? null;
    if (!imageURL && primaryLang === 'ar') {
      try { const en = await fetchFromLang('en'); imageURL = en.thumbnail?.source ?? null; } catch {}
    }
    return {
      title:      j.title ?? name,
      extract:    j.extract ?? '',
      imageURL,
      articleURL: j.content_urls?.desktop?.page ?? `https://${primaryLang}.wikipedia.org/wiki/${title}`,
    };
  } catch {
    if (primaryLang === 'ar') {
      try {
        const en = await fetchFromLang('en');
        return {
          title:      en.title ?? name,
          extract:    en.extract ?? '',
          imageURL:   en.thumbnail?.source ?? null,
          articleURL: en.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${title}`,
        };
      } catch {}
    }
    return {
      title:      name,
      extract:    lang === 'ar' ? 'لا توجد معلومات متاحة' : 'No information available.',
      imageURL:   null,
      articleURL: `https://${primaryLang}.wikipedia.org/wiki/${title}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ENGINE — orchestrates question/guess flow
// ─────────────────────────────────────────────────────────────────────────────
async function runEngine(session) {
  const mustGuess = session.questionsThisPhase >= session.maxQ;

  // ── Try AI first ──────────────────────────────────────────────────────────
  let aiResult = await runAIEngine(session);

  // If AI returned a question but we must guess → force guess from AI
  if (mustGuess && aiResult?.type === 'question') {
    // Override: force the AI to guess by asking again with must-guess signal
    aiResult = null; // Will retry below with a direct guess prompt
  }

  // If AI must guess and returned null, use a direct guess prompt
  if (mustGuess && !aiResult) {
    aiResult = await forceAIGuess(session);
  }

  if (aiResult) {
    if (aiResult.type === 'question') {
      // Check we haven't hit minimum yet (AI might try to guess early)
      if (session.questionsThisPhase < session.minQ) {
        // Good — ask the question
        session.messages.push({ role: 'assistant', content: aiResult.text });
        return {
          type: 'question',
          text: aiResult.text,
          questionNumber: session.totalQuestions + 1,
        };
      }
      // Between min and max — ask the question
      session.messages.push({ role: 'assistant', content: aiResult.text });
      return {
        type: 'question',
        text: aiResult.text,
        questionNumber: session.totalQuestions + 1,
      };
    }

    if (aiResult.type === 'guess') {
      if (session.questionsThisPhase < session.minQ) {
        // AI tried to guess too early — override, ask fallback question
        const fallback = getFallbackQuestion(session);
        if (fallback) {
          session.messages.push({ role: 'assistant', content: fallback.text });
          return {
            type: 'question',
            text: fallback.text,
            questionNumber: session.totalQuestions + 1,
          };
        }
      }

      // Ready to guess
      const wiki = await fetchWiki(aiResult.name, session.language);
      return {
        type: 'guess',
        name: aiResult.name,
        confidence: 0.85,
        wiki,
        guessNumber: session.guessStreak + 1,
        questionNumber: session.totalQuestions,
      };
    }
  }

  // ── Fallback: static questions ────────────────────────────────────────────
  if (session.questionsThisPhase < session.minQ || !mustGuess) {
    const fallback = getFallbackQuestion(session);
    if (fallback) {
      session.messages.push({ role: 'assistant', content: fallback.text });
      return {
        type: 'question',
        text: fallback.text,
        questionNumber: session.totalQuestions + 1,
      };
    }
  }

  // ── Last resort: force AI guess ───────────────────────────────────────────
  const forced = await forceAIGuess(session);
  if (forced?.name) {
    const wiki = await fetchWiki(forced.name, session.language);
    return {
      type: 'guess',
      name: forced.name,
      confidence: 0.6,
      wiki,
      guessNumber: session.guessStreak + 1,
      questionNumber: session.totalQuestions,
    };
  }

  // Absolute fallback
  const fallbackName = session.language === 'ar' ? 'محمد صلاح' : 'Cristiano Ronaldo';
  const wiki = await fetchWiki(fallbackName, session.language);
  return {
    type: 'guess',
    name: fallbackName,
    confidence: 0.3,
    wiki,
    guessNumber: session.guessStreak + 1,
    questionNumber: session.totalQuestions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  FORCE AI GUESS — dedicated prompt that MUST return a name
// ─────────────────────────────────────────────────────────────────────────────
async function forceAIGuess(session) {
  if (!openai) return null;
  const ar = session.language === 'ar';
  const rejected = session.rejectedGuesses;

  const qa = session.turns.map((t, i) => `${ar ? 'س' : 'Q'}${i + 1}: ${t.question} → ${t.answer}`).join('\n');

  const system = ar
    ? `أنت محقق بارع. بناءً على سجل الأسئلة والأجوبة التالي، خمّن الشخصية.
لا تكرر: [${rejected.join('، ') || 'لا شيء'}]
أجب بـ JSON فقط: {"type":"guess","name":"الاسم الكامل"}`
    : `You are a master detective. Based on the Q&A log below, guess the character.
Do NOT repeat: [${rejected.join(', ') || 'none'}]
Reply with JSON only: {"type":"guess","name":"Full name"}`;

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.05,
      max_tokens: 80,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: `${ar ? 'سجل الأسئلة' : 'Q&A Log'}:\n${qa || (ar ? 'لا يوجد' : 'none')}` },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw);
    if (parsed?.name) return { type: 'guess', name: String(parsed.name).trim() };
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health',     (_req, res) => res.json({ ok: true, model: MODEL, hasOpenAI: Boolean(openai) }));
app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL, hasOpenAI: Boolean(openai) }));

// ── POST /api/game/start ──────────────────────────────────────────────────────
app.post('/api/game/start', async (req, res) => {
  try {
    const language  = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();
    const session   = newSession(language);
    sessions.set(sessionId, session);

    const result = await runEngine(session);
    if (result.type === 'question') {
      session.totalQuestions++;
      session.questionsThisPhase++;
    }

    return res.json({ sessionId, ...result });
  } catch (e) {
    console.error('[start]', e);
    return res.status(500).json({ error: 'Failed to start game' });
  }
});

// Alias
app.post('/api/start', async (req, res) => {
  try {
    const language  = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();
    const session   = newSession(language);
    sessions.set(sessionId, session);

    const result = await runEngine(session);
    if (result.type === 'question') {
      session.totalQuestions++;
      session.questionsThisPhase++;
    }

    return res.json({ sessionId, ...result });
  } catch (e) {
    console.error('[start]', e);
    return res.status(500).json({ error: 'Failed to start game' });
  }
});

// ── POST /api/magic-ball/question (same interface as the other app) ───────────
app.post('/api/magic-ball/question', async (req, res) => {
  try {
    const { messages = [], lang = 'ar', sessionId } = req.body ?? {};
    const language = lang === 'en' ? 'en' : 'ar';

    let session = sessionId ? sessions.get(String(sessionId)) : null;
    if (!session) {
      const id = sessionId || crypto.randomUUID();
      session  = newSession(language);
      session.messages = Array.isArray(messages) ? messages : [];
      sessions.set(id, session);
    }

    session.expiresAt = Date.now() + SESSION_TTL;
    const result = await runEngine(session);

    if (result.type === 'question') {
      session.totalQuestions++;
      session.questionsThisPhase++;
      return res.json({
        content: result.text,
        isGuess: false,
        guessName: null,
        questionNumber: session.totalQuestions,
      });
    }

    if (result.type === 'guess') {
      return res.json({
        content: language === 'ar'
          ? `تخميني هو... ${result.name}`
          : `My guess is... ${result.name}`,
        isGuess: true,
        guessName: result.name,
        confidence: result.confidence,
        wiki: result.wiki,
        guessNumber: result.guessNumber,
      });
    }

    return res.json({ content: '', isGuess: false, guessName: null });
  } catch (e) {
    console.error('[magic-ball/question]', e);
    return res.status(500).json({ error: 'Failed to process' });
  }
});

// ── POST /api/game/answer ─────────────────────────────────────────────────────
app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    const normAnswer = normalizeAnswer(answer, session.language);

    // Add to conversation history for GPT context
    if (question) session.messages.push({ role: 'user', content: `${question}` });
    session.messages.push({ role: 'user', content: normAnswer });
    session.turns.push({ question: String(question ?? ''), answer: normAnswer });
    session.totalQuestions++;
    session.questionsThisPhase++;

    const result = await runEngine(session);

    if (result.type === 'question') {
      session.totalQuestions++;
      session.questionsThisPhase++;
    }

    return res.json(result);
  } catch (e) {
    console.error('[answer]', e);
    return res.status(500).json({ error: 'Failed to process answer' });
  }
});

// Alias
app.post('/api/next', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    const normAnswer = normalizeAnswer(answer, session.language);
    if (question) session.messages.push({ role: 'user', content: String(question) });
    session.messages.push({ role: 'user', content: normAnswer });
    session.turns.push({ question: String(question ?? ''), answer: normAnswer });
    session.totalQuestions++;
    session.questionsThisPhase++;

    const result = await runEngine(session);
    if (result.type === 'question') {
      session.totalQuestions++;
      session.questionsThisPhase++;
    }

    return res.json({ result });
  } catch (e) {
    console.error('[next]', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ── POST /api/game/guess-confirm ──────────────────────────────────────────────
app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    // ✅ Correct!
    if (correct) {
      const wiki = await fetchWiki(String(guessName ?? ''), session.language);
      sessions.delete(String(sessionId));
      return res.json({ type: 'revealed', guessName, wiki });
    }

    // ❌ Wrong
    if (guessName) {
      session.rejectedGuesses.push(String(guessName));
      const ar = session.language === 'ar';
      session.messages.push({ role: 'user', content: ar ? 'لا، هذا خاطئ.' : 'No, that is wrong.' });
    }
    session.guessStreak++;

    // Still have guesses left
    if (session.guessStreak < MAX_GUESSES) {
      const result = await forceAIGuess(session);
      if (result?.name) {
        const wiki = await fetchWiki(result.name, session.language);
        return res.json({
          type: 'guess',
          name: result.name,
          confidence: 0.75,
          wiki,
          guessNumber: session.guessStreak + 1,
          questionNumber: session.totalQuestions,
        });
      }
    }

    // All guesses used — ask more questions
    session.guessStreak = 0;
    session.questionsThisPhase = 0;
    session.minQ = FOLLOWUP_MIN;
    session.maxQ = FOLLOWUP_MAX;
    session.cycleCount++;

    const ar = session.language === 'ar';
    session.messages.push({
      role: 'assistant',
      content: ar
        ? 'سأطرح بعض الأسئلة الإضافية للتضييق أكثر.'
        : 'Let me ask a few more targeted questions to narrow it down.',
    });

    const result = await runEngine(session);
    if (result.type === 'question') {
      session.totalQuestions++;
      session.questionsThisPhase++;
    }

    return res.json(result);
  } catch (e) {
    console.error('[guess-confirm]', e);
    return res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

// Alias
app.post('/api/guess-result', async (req, res) => {
  try {
    const { sessionId, correct, guessedName } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    if (correct) {
      const wiki = await fetchWiki(String(guessedName ?? ''), session.language);
      sessions.delete(String(sessionId));
      return res.json({ ok: true, won: true, wiki });
    }

    const name = String(guessedName || '').trim();
    if (name && !session.rejectedGuesses.includes(name)) {
      session.rejectedGuesses.push(name);
      session.messages.push({
        role: 'user',
        content: session.language === 'ar' ? `لا، ليس ${name}` : `No, it's not ${name}`,
      });
    }
    session.guessStreak++;

    if (session.guessStreak < MAX_GUESSES) {
      const next = await forceAIGuess(session);
      if (next?.name) {
        const wiki = await fetchWiki(next.name, session.language);
        return res.json({ ok: false, won: false, type: 'guess', name: next.name, wiki });
      }
    }

    // Back to questions
    session.guessStreak = 0;
    session.questionsThisPhase = 0;
    session.minQ = FOLLOWUP_MIN;
    session.maxQ = FOLLOWUP_MAX;
    session.cycleCount++;

    return res.json({ ok: true, won: false, gaveUp: false, continuePlaying: true });
  } catch (e) {
    console.error('[guess-result]', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ── GET /api/wiki ──────────────────────────────────────────────────────────────
app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name ?? '');
    const lang = req.query.language === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ error: 'name is required' });
    return res.json(await fetchWiki(name, lang));
  } catch (e) {
    console.error('[wiki]', e);
    return res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

// ── GET /api/person-info (alias for the other app's endpoint) ─────────────────
app.get('/api/person-info', async (req, res) => {
  try {
    const name = String(req.query.name ?? '');
    const lang = req.query.lang === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ imageUrl: null, bio: null });
    const wiki = await fetchWiki(name, lang);
    return res.json({
      imageUrl: wiki?.imageURL ?? null,
      bio:      wiki?.extract  ?? null,
    });
  } catch (e) {
    console.error('[person-info]', e);
    return res.status(500).json({ imageUrl: null, bio: null });
  }
});

// ── GET /api/session/:id — debug ───────────────────────────────────────────────
app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId:          req.params.id,
    language:           s.language,
    totalQuestions:     s.totalQuestions,
    questionsThisPhase: s.questionsThisPhase,
    phase:              { min: s.minQ, max: s.maxQ },
    rejectedGuesses:    s.rejectedGuesses,
    guessStreak:        s.guessStreak,
    cycleCount:         s.cycleCount,
    turns:              s.turns,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function normalizeAnswer(answer, language) {
  const s = String(answer ?? '').trim().toLowerCase();
  const ar = language === 'ar';

  // Arabic answers
  if (s === 'نعم' || s === 'yes')   return ar ? 'نعم' : 'yes';
  if (s === 'لا'  || s === 'no')    return ar ? 'لا'  : 'no';
  if (s === 'ربما' || s === 'maybe') return ar ? 'ربما' : 'maybe';
  if (s.includes('لا أعرف') || s.includes("don't know") || s.includes('dont know') || s.includes('dunno'))
    return ar ? 'لا أعرف' : "I don't know";

  return answer ?? (ar ? 'لا أعرف' : "I don't know");
}

// ─────────────────────────────────────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎱 Magic Ball server running on port ${PORT}`);
  console.log(`   Model: ${MODEL} | OpenAI: ${openai ? '✅' : '❌'}`);
  console.log(`   Rules: ${INITIAL_MIN}–${INITIAL_MAX} questions → up to ${MAX_GUESSES} guesses → ${INITIAL_MIN}–${INITIAL_MAX} more`);
  console.log(`   AI brain: ${openai ? 'GPT generates questions dynamically' : 'Static fallback mode'}`);
});
