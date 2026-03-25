import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import https from 'node:https';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3001);

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
});

const sessions = new Map();

const MIN_QUESTIONS_BEFORE_GUESS = 10;
const MAX_QUESTIONS_BEFORE_GUESS = 20;
const MIN_NARROWING_QUESTIONS = 5;
const MAX_NARROWING_QUESTIONS = 10;
const MAX_GUESSES = 3;

function detectLanguage(text) {
  if (!text) return 'ar';
  return /[\u0600-\u06FF]/.test(text) ? 'ar' : 'en';
}

function buildSystemPrompt(session, lang) {
  const isArabic = lang === 'ar';

  const rules = isArabic
    ? `أنت لعبة "الكرة السحرية" - نسخة ذكية من أكيناتور تحاول تخمين شخصية مشهورة يفكر فيها المستخدم.

قواعد صارمة يجب الالتزام بها:
1. اطرح سؤالاً واحداً فقط في كل مرة - لا أكثر أبداً
2. التزم بنفس المسار المنطقي - إذا سألت "هل هو فنان؟" وكانت الإجابة نعم، استمر في مسار الفن فقط:
   (هل هو مغني؟) → إذا لا: (هل هو ممثل؟) → إذا نعم: (هل يمثل في مسلسلات؟) → (هل هو عربي؟) ...
3. لا تنتقل عشوائياً بين المجالات المختلفة - ابقَ على المسار
4. لا تكرر سؤالاً سبق وطرحته
5. لا تذكر اسم الشخصية أبداً أثناء الأسئلة
6. ابدأ بأسئلة عامة ثم ضيّق تدريجياً:
   المرحلة 1: جنس الشخصية (ذكر/أنثى)
   المرحلة 2: مجالها الرئيسي (فن/رياضة/سياسة/علوم...)
   المرحلة 3: تخصصها داخل المجال
   المرحلة 4: جنسيتها أو بلدها
   المرحلة 5: تفاصيل أكثر تحديداً
7. اطرح بين 10 و20 سؤالاً قبل أن تخمّن
8. عند التخمين، تخمّن شخصية واحدة فقط بالاسم الكامل
9. يجب أن يكون ردك JSON صارم فقط بدون أي نص خارجه`
    : `You are the "Magic Ball" game - a smart Akinator-style game that tries to guess a famous person the user is thinking of.

Strict rules you must follow:
1. Ask only ONE question at a time - never more
2. Stay on the same logical path - if you asked "Is he an artist?" and got yes, continue in the art path only:
   (Is he a singer?) → if no: (Is he an actor?) → if yes: (Does he act in TV series?) → (Is he from the Arab world?) ...
3. Do not randomly jump between different fields - stay on track
4. Never repeat a question you've already asked
5. Never mention the character's name during questions
6. Start with general questions then narrow down gradually:
   Phase 1: Gender (male/female)
   Phase 2: Main field (arts/sports/politics/science...)
   Phase 3: Specialty within that field
   Phase 4: Nationality or country
   Phase 5: More specific details
7. Ask between 10 and 20 questions before guessing
8. When guessing, guess only ONE person with their full name
9. Your response must be strict JSON only with no text outside it`;

  const historyText = session.history.length > 0
    ? (isArabic ? '\nسجل الأسئلة والأجوبة السابقة:\n' : '\nPrevious Q&A history:\n') +
      session.history.map((h, i) =>
        `${i + 1}. ${isArabic ? 'س' : 'Q'}: ${h.question} — ${isArabic ? 'ج' : 'A'}: ${h.answer ?? (isArabic ? '(لم يُجب بعد)' : '(not yet answered)')}`
      ).join('\n')
    : '';

  const guessesText = session.guesses.length > 0
    ? (isArabic
        ? `\nالتخمينات السابقة التي رفضها المستخدم (لا تكررها):\n${session.guesses.join('، ')}`
        : `\nPrevious guesses rejected by the user (don't repeat them):\n${session.guesses.join(', ')}`)
    : '';

  const qCount = session.history.filter(h => h.answer !== undefined).length;
  const targetMin = session.narrowingRound > 0 ? MIN_NARROWING_QUESTIONS : MIN_QUESTIONS_BEFORE_GUESS;
  const targetMax = session.narrowingRound > 0 ? MAX_NARROWING_QUESTIONS : MAX_QUESTIONS_BEFORE_GUESS;

  const phaseInfo = isArabic
    ? `\nعدد الأسئلة المُجاب عليها: ${qCount} | التخمينات المستخدمة: ${session.guesses.length}/${MAX_GUESSES} | جولة التضييق: ${session.narrowingRound}`
    : `\nAnswered questions: ${qCount} | Guesses used: ${session.guesses.length}/${MAX_GUESSES} | Narrowing round: ${session.narrowingRound}`;

  const canGuess = qCount >= targetMin;
  const mustGuess = qCount >= targetMax;

  const instruction = isArabic
    ? mustGuess
      ? '\n⚠️ وصلت للحد الأقصى من الأسئلة. يجب أن تتخمن الآن.'
      : canGuess
        ? '\n✅ يمكنك الآن أن تتخمن إذا كنت واثقاً، أو استمر في الأسئلة.'
        : `\n❌ لا تتخمن بعد — تحتاج ${targetMin - qCount} أسئلة إضافية على الأقل.`
    : mustGuess
      ? '\n⚠️ You reached the maximum questions. You must guess now.'
      : canGuess
        ? '\n✅ You may guess now if confident, or continue asking questions.'
        : `\n❌ Do not guess yet — need at least ${targetMin - qCount} more questions.`;

  const format = isArabic
    ? `\nشكل الرد المطلوب (JSON فقط):
{"type": "question", "content": "نص السؤال هنا", "confidence": 50}
أو عند التخمين:
{"type": "guess", "content": "الاسم الكامل للشخصية", "confidence": 85}`
    : `\nRequired response format (JSON only):
{"type": "question", "content": "your question here", "confidence": 50}
Or when guessing:
{"type": "guess", "content": "Full Name of Person", "confidence": 85}`;

  return rules + historyText + guessesText + phaseInfo + instruction + format;
}

async function getWikipediaInfo(name, lang) {
  return new Promise((resolve) => {
    const searchLang = lang === 'ar' ? 'ar' : 'en';
    const encodedName = encodeURIComponent(name);
    const searchUrl = `https://${searchLang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodedName}&format=json&srlimit=1&origin=*`;

    https.get(searchUrl, { headers: { 'User-Agent': 'MagicBallGame/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const results = parsed?.query?.search;
          if (!results || results.length === 0) { resolve(null); return; }

          const pageTitle = results[0].title;
          const encodedTitle = encodeURIComponent(pageTitle);
          const summaryUrl = `https://${searchLang}.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`;

          https.get(summaryUrl, { headers: { 'User-Agent': 'MagicBallGame/1.0' } }, (res2) => {
            let data2 = '';
            res2.on('data', chunk => { data2 += chunk; });
            res2.on('end', () => {
              try {
                const summary = JSON.parse(data2);
                resolve({
                  title: summary.title,
                  extract: summary.extract || '',
                  image: summary.thumbnail?.source || summary.originalimage?.source || null,
                  wikiUrl: summary.content_urls?.desktop?.page || `https://${searchLang}.wikipedia.org/wiki/${encodedTitle}`,
                });
              } catch { resolve(null); }
            });
          }).on('error', () => resolve(null));
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// بدء جلسة جديدة
app.post('/api/session/start', (req, res) => {
  const sessionId = crypto.randomUUID();
  const { language } = req.body || {};

  sessions.set(sessionId, {
    id: sessionId,
    history: [],
    guesses: [],
    narrowingRound: 0,
    language: language || null,
    status: 'playing',
    createdAt: Date.now(),
  });

  res.json({ sessionId });
});

// الخطوة التالية: سؤال أو تخمين
app.post('/api/session/:id/next', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'playing') return res.status(400).json({ error: 'Session is not active' });

  const { answer, language } = req.body || {};

  // تسجيل إجابة السؤال الأخير إذا أُرسلت مع الطلب
  if (answer !== undefined && answer !== null && session.history.length > 0) {
    const last = session.history[session.history.length - 1];
    if (last.answer === undefined) {
      last.answer = answer;
      if (!session.language) session.language = detectLanguage(answer);
    }
  }

  if (!session.language && language) session.language = language;

  const lang = session.language || 'ar';
  const systemPrompt = buildSystemPrompt(session, lang);
  const userMessage = session.history.length === 0
    ? (lang === 'ar' ? 'ابدأ اللعبة واطرح أول سؤال' : 'Start the game and ask the first question')
    : (lang === 'ar' ? 'استمر بناءً على الأجوبة السابقة' : 'Continue based on previous answers');

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';

    let parsed;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { type: 'question', content: raw, confidence: 50 };
    } catch {
      parsed = { type: 'question', content: raw, confidence: 50 };
    }

    if (parsed.type === 'guess') {
      const guessName = String(parsed.content).trim();

      // منع تكرار نفس التخمين
      if (session.guesses.includes(guessName)) {
        session.history.push({ question: lang === 'ar' ? 'هل الشخصية معروفة دولياً؟' : 'Is this person internationally known?', answer: undefined });
        return res.json({ type: 'question', question: session.history[session.history.length - 1].question, questionNumber: session.history.length, confidence: 50 });
      }

      session.guesses.push(guessName);
      const wikiInfo = await getWikipediaInfo(guessName, lang);

      return res.json({
        type: 'guess',
        guess: guessName,
        guessNumber: session.guesses.length,
        maxGuesses: MAX_GUESSES,
        confidence: parsed.confidence ?? 80,
        wikipedia: wikiInfo,
      });
    }

    // سؤال عادي
    const question = String(parsed.content || (lang === 'ar' ? 'هل الشخصية مشهورة جداً؟' : 'Is this person very famous?')).trim();
    session.history.push({ question, answer: undefined });

    return res.json({
      type: 'question',
      question,
      questionNumber: session.history.length,
      confidence: parsed.confidence ?? 50,
    });

  } catch (err) {
    console.error('OpenAI error:', err);
    return res.status(500).json({ error: 'AI error', details: String(err) });
  }
});

// تسجيل الإجابة على السؤال الأخير
app.post('/api/session/:id/answer', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { answer } = req.body || {};
  if (!answer) return res.status(400).json({ error: 'Answer is required' });
  if (session.history.length === 0) return res.status(400).json({ error: 'No question to answer' });

  const last = session.history[session.history.length - 1];
  if (last.answer !== undefined) return res.status(400).json({ error: 'Already answered' });

  last.answer = answer;
  if (!session.language) session.language = detectLanguage(answer);

  res.json({ ok: true });
});

// نتيجة التخمين
app.post('/api/session/:id/guess-result', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { correct } = req.body || {};
  const lang = session.language || 'ar';

  if (correct === true) {
    session.status = 'won';
    return res.json({
      status: 'won',
      message: lang === 'ar' ? '🎉 رائع! لقد خمّنت الشخصية!' : '🎉 Amazing! I guessed it!',
    });
  }

  if (session.guesses.length >= MAX_GUESSES) {
    session.status = 'lost';
    return res.json({
      status: 'lost',
      message: lang === 'ar' ? 'استنفذت كل تخميناتي! من كانت الشخصية؟' : "I've used all my guesses! Who was the person?",
    });
  }

  // فشل التخمين - جولة تضييق جديدة
  session.narrowingRound += 1;
  session.status = 'playing';

  return res.json({
    status: 'narrowing',
    message: lang === 'ar'
      ? `حسناً! سأطرح المزيد من الأسئلة لأضيّق البحث (تخمين ${session.guesses.length + 1} من ${MAX_GUESSES})`
      : `Alright! Let me ask more to narrow it down (guess ${session.guesses.length + 1} of ${MAX_GUESSES})`,
    guessesLeft: MAX_GUESSES - session.guesses.length,
  });
});

// حالة الجلسة
app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    id: session.id,
    questionCount: session.history.length,
    guessCount: session.guesses.length,
    status: session.status,
    language: session.language,
    narrowingRound: session.narrowingRound,
  });
});

// حذف الجلسة
app.delete('/api/session/:id', (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

// Health check
app.get('/api/healthz', (_req, res) => res.json({ status: 'ok' }));

// تنظيف الجلسات القديمة (كل 30 دقيقة، تحذف الجلسات التي مضى عليها ساعتان)
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions.entries()) {
    if (now - session.createdAt > 2 * 60 * 60 * 1000) sessions.delete(key);
  }
}, 30 * 60 * 1000);
cleanup.unref();

app.listen(port, () => {
  console.log(`🔮 Magic Ball server running on port ${port}`);
});

export default app;
