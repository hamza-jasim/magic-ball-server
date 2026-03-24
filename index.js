import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import crypto from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || 'gpt-4o';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ========================
// CONSTANTS
// ========================
const INITIAL_MIN = 7;
const INITIAL_MAX = 12;
const FOLLOWUP_MIN = 4;
const FOLLOWUP_MAX = 7;
const MAX_CONSECUTIVE_GUESSES = 3;
const SESSION_TTL_MS = 60 * 60 * 1000;

// ========================
// SESSION STORE
// ========================
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ========================
// HELPERS
// ========================
function normalizeAnswer(answer) {
  const map = {
    yes: 'yes',
    no: 'no',
    maybe: 'maybe',
    dontknow: 'dont_know',
    dont_know: 'dont_know',
  };
  return map[String(answer ?? '').trim().toLowerCase().replace(/[^a-z_]/g, '')] ?? 'dont_know';
}

function safeLower(v) {
  return String(v ?? '').trim().toLowerCase();
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function inferState(turns) {
  const state = {
    real: null, fictional: null,
    male: null, female: null,
    arab: null, alive: null,
    athlete: null, actor: null, singer: null,
    footballer: null, politician: null, scientist: null,
    director: null, presenter: null, historical: null,
    animated: null, villain: null, hero: null,
    royalty: null, businessPerson: null, comedian: null, writer: null,
  };

  for (const turn of turns) {
    const q = safeLower(turn.question);
    const isYes = turn.answer === 'yes';
    const isNo = turn.answer === 'no';
    if (!isYes && !isNo) continue;
    const val = isYes;

    if (q.includes('حقيقي') || q.includes('real') || q.includes('واقعي')) state.real = val;
    if (q.includes('خيالي') || q.includes('fiction') || q.includes('كرتون') || q.includes('cartoon')) state.fictional = val;
    if (q.includes('رجل') || q.includes('ذكر') || q.includes('male') || q.includes(' man') || q.includes('boy')) state.male = val;
    if (q.includes('امرأة') || q.includes('أنثى') || q.includes('female') || q.includes('woman') || q.includes('girl')) state.female = val;
    if (q.includes('عربي') || q.includes('arab') || q.includes('خليجي') || q.includes('مصري') || q.includes('سعودي') || q.includes('gulf')) state.arab = val;
    if (q.includes('حي') || q.includes('alive') || q.includes('living')) state.alive = val;
    if (q.includes('متوفى') || q.includes('dead') || q.includes('مات') || q.includes('deceased')) state.alive = isNo ? true : false;
    if (q.includes('رياضي') || q.includes('athlete') || q.includes('sport')) state.athlete = val;
    if (q.includes('ممثل') || q.includes('actor') || q.includes('actress')) state.actor = val;
    if (q.includes('مغني') || q.includes('مطرب') || q.includes('singer') || q.includes('موسيق') || q.includes('music')) state.singer = val;
    if (q.includes('كرة') || q.includes('football') || q.includes('soccer') || q.includes('لاعب كرة')) state.footballer = val;
    if (q.includes('سياسي') || q.includes('politician') || q.includes('رئيس') || q.includes('president') || q.includes('وزير')) state.politician = val;
    if (q.includes('عالم') || q.includes('scientist') || q.includes('مخترع') || q.includes('inventor')) state.scientist = val;
    if (q.includes('مخرج') || q.includes('director') || q.includes('filmmaker')) state.director = val;
    if (q.includes('مقدم') || q.includes('presenter') || q.includes('host') || q.includes('مذيع')) state.presenter = val;
    if (q.includes('تاريخي') || q.includes('historical') || q.includes('قديم') || q.includes('ancient')) state.historical = val;
    if (q.includes('انيميشن') || q.includes('animated') || q.includes('رسوم متحركة')) state.animated = val;
    if (q.includes('شرير') || q.includes('villain') || q.includes('antagonist')) state.villain = val;
    if (q.includes('بطل') || q.includes('hero') || q.includes('superhero') || q.includes('خارق')) state.hero = val;
    if (q.includes('ملكي') || q.includes('royal') || q.includes('ملك') || q.includes('أمير') || q.includes('king') || q.includes('prince')) state.royalty = val;
    if (q.includes('رجل أعمال') || q.includes('business') || q.includes('ceo') || q.includes('مليارد')) state.businessPerson = val;
    if (q.includes('كوميدي') || q.includes('comedian') || q.includes('comic')) state.comedian = val;
    if (q.includes('كاتب') || q.includes('writer') || q.includes('روائي') || q.includes('author')) state.writer = val;
  }

  return state;
}

function conceptKey(text) {
  const q = safeLower(text);
  if (q.includes('حقيقي') || q.includes('real') || q.includes('خيالي') || q.includes('fiction')) return 'reality';
  if (q.includes('رجل') || q.includes('امرأة') || q.includes('male') || q.includes('female') || q.includes('ذكر') || q.includes('أنثى')) return 'gender';
  if (q.includes('عربي') || q.includes('arab') || q.includes('أجنبي') || q.includes('foreign') || q.includes('خليجي')) return 'region';
  if (q.includes('حي') || q.includes('alive') || q.includes('متوفى') || q.includes('dead')) return 'alive';
  if (q.includes('رياضي') || q.includes('athlete') || q.includes('sport')) return 'sport';
  if (q.includes('فنان') || q.includes('artist') || q.includes('مغني') || q.includes('singer') || q.includes('ممثل') || q.includes('actor') || q.includes('موسيق')) return 'arts';
  if (q.includes('سياسي') || q.includes('politician') || q.includes('رئيس') || q.includes('president')) return 'politics';
  if (q.includes('كرة') || q.includes('football') || q.includes('soccer')) return 'football';
  if (q.includes('مخرج') || q.includes('director')) return 'director';
  if (q.includes('بطل') || q.includes('hero') || q.includes('شرير') || q.includes('villain')) return 'role';
  if (q.includes('كاتب') || q.includes('writer') || q.includes('author')) return 'writer';
  return q.replace(/\s+/g, '_').slice(0, 40);
}

function repeatedConcept(text, session) {
  const key = conceptKey(text);
  return session.turns.some((t) => conceptKey(t.question) === key);
}

function contradictsState(text, state) {
  const q = safeLower(text);
  if (state.male === true && (q.includes('امرأة') || q.includes('female') || q.includes('أنثى'))) return true;
  if (state.female === true && (q.includes('رجل') || q.includes('male') || q.includes('ذكر'))) return true;
  if (state.alive === true && (q.includes('متوفى') || q.includes('dead'))) return true;
  if (state.alive === false && (q.includes(' حي') || q.includes('alive') || q.includes('living'))) return true;
  if (state.real === true && (q.includes('خيالي') || q.includes('fiction') || q.includes('كرتون'))) return true;
  if (state.fictional === true && (q.includes('حقيقي') || q.includes('real') || q.includes('واقعي'))) return true;
  if (state.arab === true && (q.includes('أجنبي') || q.includes('foreign') || q.includes('غير عربي'))) return true;
  if (state.arab === false && (q.includes('عربي') || q.includes('arab') || q.includes('خليجي') || q.includes('مصري'))) return true;
  return false;
}

function isWeakQuestion(text) {
  const q = safeLower(text);
  const weak = ['مشهور', 'famous', 'do you know', 'تعرفه', 'popular', 'well known', 'كبير', 'هل تعرف', 'معروف'];
  return weak.some((p) => q.includes(p));
}

function isDoubleChoice(text) {
  const q = safeLower(text);
  return q.includes(' أو ') || q.includes(' or ') || q.includes('ذكر أم') || q.includes('male or female');
}

function isTooLong(text, lang) {
  const wc = wordCount(text);
  return lang === 'ar' ? wc > 6 : wc > 9;
}

function isNameQuestion(text) {
  const q = safeLower(text);
  const namePatterns = ['is it ', 'could it be ', 'is this person ', 'هل هو نفسه', 'هل هي نفسها'];
  return namePatterns.some((p) => q.startsWith(p) && wordCount(q) <= 4);
}

function bestFallbackQuestion(lang, session) {
  const state = inferState(session.turns);
  const asked = new Set(session.turns.map((t) => conceptKey(t.question)));

  const candidatesAr = [
    ['reality', 'هل هي حقيقية؟'],
    ['gender', 'هل هو رجل؟'],
    ['region', 'هل هو عربي؟'],
    ['alive', 'هل هو حي؟'],
    ['sport', 'هل هو رياضي؟'],
    ['arts', 'هل هو فنان؟'],
    ['politics', 'هل هو سياسي؟'],
    ['football', 'هل هو لاعب كرة قدم؟'],
    ['director', 'هل هو مخرج؟'],
    ['writer', 'هل هو كاتب؟'],
    ['role', 'هل هو بطل؟'],
  ];

  const candidatesEn = [
    ['reality', 'Is it real?'],
    ['gender', 'Is it male?'],
    ['region', 'Is it Arab?'],
    ['alive', 'Is it alive?'],
    ['sport', 'Is it an athlete?'],
    ['arts', 'Is it an artist?'],
    ['politics', 'Is it a politician?'],
    ['football', 'Is it a footballer?'],
    ['director', 'Is it a director?'],
    ['writer', 'Is it a writer?'],
    ['role', 'Is it a hero?'],
  ];

  const candidates = lang === 'ar' ? candidatesAr : candidatesEn;

  for (const [key, question] of candidates) {
    if (!asked.has(key) && !contradictsState(question, state)) {
      return question;
    }
  }

  if (state.athlete === true && !asked.has('football')) return lang === 'ar' ? 'هل هو لاعب كرة قدم؟' : 'Is it a footballer?';
  if (state.actor === true && !asked.has('movie_type')) return lang === 'ar' ? 'هل هو في أفلام أكشن؟' : 'Is it in action movies?';
  if (state.singer === true && !asked.has('music_type')) return lang === 'ar' ? 'هل موسيقاه عربية؟' : 'Is the music Arabic?';

  return lang === 'ar' ? 'هل هو موجود الآن؟' : 'Is it alive today?';
}

function fallbackGuess(lang) {
  return lang === 'ar'
    ? { type: 'guess', name: 'شخصية مشهورة', confidence: 0.2 }
    : { type: 'guess', name: 'A famous person', confidence: 0.2 };
}

function sanitize(raw, session) {
  if (!raw || typeof raw !== 'object') {
    return { type: 'question', text: bestFallbackQuestion(session.language, session) };
  }

  const state = inferState(session.turns);

  if (raw.type === 'question') {
    const text = String(raw.text ?? '').trim();
    if (!text) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (isTooLong(text, session.language)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (isWeakQuestion(text)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (isDoubleChoice(text)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (isNameQuestion(text)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (repeatedConcept(text, session)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (contradictsState(text, state)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    return { type: 'question', text };
  }

  if (raw.type === 'guess') {
    const name = String(raw.name ?? '').trim();
    if (!name) return fallbackGuess(session.language);
    if (session.rejectedGuesses.includes(name)) {
      return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    }
    return {
      type: 'guess',
      name,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.7,
    };
  }

  return { type: 'question', text: bestFallbackQuestion(session.language, session) };
}

function makeSystemPrompt(lang) {
  return `You are the world's best character-guessing AI, powering a "20 Questions" style mobile game called Magic Ball.

CORE MISSION: Identify ANY character the user thinks of — real person, fictional character, historical figure, animated character, athlete, politician, celebrity, superhero — as fast and accurately as possible.

LANGUAGE: ${lang === 'ar' ? 'Respond ONLY in Arabic. Questions must be 2-5 Arabic words.' : 'Respond ONLY in English. Questions must be 2-7 English words.'}

STRICT JSON OUTPUT — no markdown, no comments, no explanations:
- Question: {"type":"question","text":"..."}
- Guess:    {"type":"guess","name":"...","confidence":0.92}

STRATEGIC QUESTION ORDERING (optimal information gain per question):
1. FIRST: Real person vs fictional/animated character
2. SECOND: Male vs female
3. THIRD: If real → Arab vs non-Arab. If fictional → from which franchise/world
4. FOURTH: Alive vs deceased (for real people). Hero vs villain (for fictional)
5. FIFTH: Broad domain — sports / entertainment / politics / science / royalty / business
6. SIXTH: Narrow domain — footballer / singer / actor / politician / director
7. SEVENTH: Specific discriminators — nationality, era, most famous achievement
8. EIGHTH+: Close in on the answer with targeted discriminators

SUPERIOR QUESTION EXAMPLES (Arabic):
✓ "هل هو حقيقي؟" — real vs fictional
✓ "هل هو رجل؟" — gender
✓ "هل هو عربي؟" — region
✓ "هل هو حي؟" — alive
✓ "هل هو رياضي؟" — broad domain
✓ "هل يلعب كرة القدم؟" — narrow sport
✓ "هل فاز بكأس العالم؟" — achievement discriminator
✓ "هل هو ممثل هوليوود؟" — narrow entertainment
✓ "هل هو شرير؟" — fictional role

BAD QUESTIONS (never ask these):
✗ "هل هو مشهور؟" — useless
✗ "هل تعرفه؟" — useless
✗ "هل هو ذكر أو أنثى؟" — double choice
✗ Any question mentioning a name
✗ Repeating same concept with different words

GUESSING RULES:
- Guess only ONE person at a time
- State name exactly as commonly known (e.g., "محمد صلاح" not "صلاح")
- Never repeat a rejected guess
- Be decisive — high confidence means commit to the guess
- After wrong guesses, ask 4-6 smart questions then guess again

CONFIDENCE GUIDE:
- 0.95+ = near certain, very strong evidence
- 0.80-0.94 = strong guess, multiple confirming clues
- 0.60-0.79 = good guess, most clues point here
- below 0.60 = uncertain, need more questions

REMEMBER: Every question must eliminate the MAXIMUM number of possibilities. Think binary search over character-space.`;
}

function sessionContext(session) {
  const turns = session.turns.length
    ? session.turns.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`).join('\n')
    : 'No questions asked yet.';

  const state = inferState(session.turns);
  const knownFacts = Object.entries(state)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`);

  return [
    `=== CONVERSATION HISTORY ===\n${turns}`,
    `=== CONFIRMED FACTS ===\n${knownFacts.length ? knownFacts.join(', ') : 'none yet'}`,
    `=== REJECTED GUESSES ===\n${session.rejectedGuesses.length ? session.rejectedGuesses.join(', ') : 'none'}`,
    `=== PHASE INFO ===\nQuestions this phase: ${session.questionsSincePhaseReset} | Window: ${session.minQuestionsBeforeGuess}–${session.maxQuestionsBeforeGuess} | Wrong streak: ${session.guessStreak}`,
  ].join('\n\n');
}

function canGuess(session) {
  return session.questionsSincePhaseReset >= session.minQuestionsBeforeGuess;
}

function mustGuess(session) {
  return session.questionsSincePhaseReset >= session.maxQuestionsBeforeGuess;
}

async function runEngine(session) {
  if (!openai) {
    if (mustGuess(session)) return fallbackGuess(session.language);
    return { type: 'question', text: bestFallbackQuestion(session.language, session) };
  }

  const userContent = `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

${sessionContext(session)}

INSTRUCTIONS FOR THIS TURN:
- canGuessNow: ${canGuess(session)}
- mustGuessNow: ${mustGuess(session)}
- If mustGuessNow is true → output a guess immediately, no more questions
- If canGuessNow is false → output a question only
- If canGuessNow is true → output question OR guess depending on confidence
- NEVER repeat rejected guesses
- NEVER contradict confirmed facts
- Pick the single best question if asking`;

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.25,
    max_tokens: 80,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      { role: 'user', content: userContent },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (mustGuess(session)) return await forceGuess(session);
    return { type: 'question', text: bestFallbackQuestion(session.language, session) };
  }

  let result = sanitize(parsed, session);

  if (result.type === 'guess' && !canGuess(session)) {
    result = { type: 'question', text: bestFallbackQuestion(session.language, session) };
  }

  if (mustGuess(session) && result.type !== 'guess') {
    return await forceGuess(session);
  }

  return result;
}

async function forceGuess(session) {
  if (!openai) return fallbackGuess(session.language);

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: 60,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You must make your single best guess now. Return STRICT JSON only.\nFormat: {"type":"guess","name":"...","confidence":0.82}\nDo NOT repeat: ${session.rejectedGuesses.join(', ') || 'none'}`,
      },
      {
        role: 'user',
        content: `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}\n\n${sessionContext(session)}\n\nMake your best guess RIGHT NOW.`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  try {
    const parsed = JSON.parse(raw);
    const cleaned = sanitize(parsed, session);
    return cleaned.type === 'guess' ? cleaned : fallbackGuess(session.language);
  } catch {
    return fallbackGuess(session.language);
  }
}

async function fetchWiki(name, lang) {
  const l = lang === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(String(name).replace(/ /g, '_'));
  const url = `https://${l}.wikipedia.org/api/rest_v1/page/summary/${title}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    return {
      title: json.title ?? name,
      extract: json.extract ?? '',
      imageURL: json.thumbnail?.source ?? null,
      articleURL: json.content_urls?.desktop?.page ?? `https://${l}.wikipedia.org/wiki/${title}`,
    };
  } catch {
    return {
      title: name,
      extract: lang === 'ar' ? 'لا توجد معلومات متاحة' : 'No information available',
      imageURL: null,
      articleURL: `https://${l}.wikipedia.org/wiki/${title}`,
    };
  }
}

// ========================
// ROUTES
// ========================

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model, hasOpenAI: Boolean(openai) });
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
      guessStreak: 0,
      questionsSincePhaseReset: 0,
      minQuestionsBeforeGuess: INITIAL_MIN,
      maxQuestionsBeforeGuess: INITIAL_MAX,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };

    sessions.set(sessionId, session);
    const result = await runEngine(session);
    return res.json({ sessionId, ...result });
  } catch (error) {
    console.error('/api/game/start error:', error);
    return res.status(500).json({ error: 'Failed to start game' });
  }
});

app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));

    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL_MS;
    session.turns.push({
      question: String(question ?? ''),
      answer: normalizeAnswer(answer),
    });
    session.questionsSincePhaseReset += 1;

    const result = await runEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/answer error:', error);
    return res.status(500).json({ error: 'Failed to process answer' });
  }
});

app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));

    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL_MS;

    if (correct) {
      const wiki = await fetchWiki(String(guessName ?? ''), session.language);
      session.guessStreak = 0;
      session.questionsSincePhaseReset = 0;
      session.minQuestionsBeforeGuess = INITIAL_MIN;
      session.maxQuestionsBeforeGuess = INITIAL_MAX;
      return res.json({ type: 'revealed', guessName, wiki });
    }

    if (guessName) session.rejectedGuesses.push(String(guessName));
    session.guessStreak += 1;

    if (session.guessStreak < MAX_CONSECUTIVE_GUESSES) {
      const result = await forceGuess(session);
      return res.json(result);
    }

    session.guessStreak = 0;
    session.questionsSincePhaseReset = 0;
    session.minQuestionsBeforeGuess = FOLLOWUP_MIN;
    session.maxQuestionsBeforeGuess = FOLLOWUP_MAX;

    const result = await runEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/guess-confirm error:', error);
    return res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name ?? '');
    const lang = req.query.language === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ error: 'name is required' });
    const wiki = await fetchWiki(name, lang);
    return res.json(wiki);
  } catch (error) {
    console.error('/api/wiki error:', error);
    return res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

// ========================
// START SERVER
// ========================
app.listen(port, () => {
  console.log(`✅ Magic Ball server running → http://localhost:${port}`);
  console.log(`🤖 Model: ${model} | OpenAI: ${Boolean(openai)}`);
});