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
   SYSTEM PROMPT
   ============================================================ */
function makeSystemPrompt(language = 'ar') {
  return `
You are an ultra‑strategic character‑guessing engine.
Ask one short yes/no question only.
Output strict JSON only.
Never mention names during question mode.
`;
}

/* ============================================================
   HISTORY BUILDER
   ============================================================ */
function sessionMessages(session) {
  const turns = session.turns
    .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`)
    .join('\n');

  return `
Language: ${session.language}
Turns: ${session.turns.length}

${turns}

Rejected guesses: ${session.rejectedGuesses.join(', ') || 'none'}
Questions since last rejected guess: ${session.questionsSinceLastRejectedGuess}
`;
}

/* ============================================================
   HELPERS
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

function shortFallbackQuestion(language = 'ar', turnCount = 0) {
  const ar = ['هل هو رجل؟','هل هو حقيقي؟','هل هو ممثل؟','هل هو عربي؟','هل هو حي؟'];
  const en = ['Is it male?','Is it real?','Is it an actor?','Is it Arab?','Is it alive?'];
  const list = language === 'ar' ? ar : en;
  return list[Math.min(turnCount, list.length - 1)];
}

function fallbackGuess(language = 'ar') {
  return language === 'ar'
    ? { type: 'guess', name: 'محمد صلاح', confidence: 0.35 }
    : { type: 'guess', name: 'Mohamed Salah', confidence: 0.35 };
}

function isQuestionTooLong(text = '', language = 'ar') {
  const words = text.trim().split(/\s+/);
  return language === 'ar' ? words.length > 5 : words.length > 7;
}

function looksLikeNameQuestion(text = '') {
  const lower = text.toLowerCase();
  return lower.startsWith('is it ') || lower.includes('محمد') || lower.includes('michael');
}
/* ============================================================
   SANITIZE RESULT
   ============================================================ */
function sanitizeEngineResult(result, session) {
  const turnCount = session.turns.length;

  if (!result || typeof result !== 'object') {
    return { type: 'question', text: shortFallbackQuestion(session.language, turnCount) };
  }

  if (result.type === 'question') {
    const text = String(result.text || '').trim();

    if (!text || isQuestionTooLong(text, session.language) || looksLikeNameQuestion(text)) {
      return { type: 'question', text: shortFallbackQuestion(session.language, turnCount) };
    }

    return { type: 'question', text };
  }

  if (result.type === 'guess') {
    const name = String(result.name || '').trim();
    if (!name) return fallbackGuess(session.language);

    return {
      type: 'guess',
      name,
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.6
    };
  }

  return { type: 'question', text: shortFallbackQuestion(session.language, turnCount) };
}

/* ============================================================
   FORCE GUESS
   ============================================================ */
async function forceGuess(session) {
  if (!openai) return fallbackGuess(session.language);

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.15,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `Make your best guess now.` },
      { role: 'user', content: sessionMessages(session) }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';
  try {
    return sanitizeEngineResult(JSON.parse(raw), session);
  } catch {
    return fallbackGuess(session.language);
  }
}

/* ============================================================
   ASK ENGINE — النسخة الصحيحة الوحيدة
   ============================================================ */
async function askEngine(session) {
  const turnCount = session.turns.length;

  const canGuessNow =
    session.rejectedGuesses.length === 0 &&
    turnCount >= MIN_QUESTIONS_BEFORE_GUESS &&
    session.questionsSinceLastRejectedGuess >= QUESTIONS_AFTER_REJECTED_GUESS;

  if (!openai) return fallbackEngine(session);

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.15,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      { role: 'user', content: sessionMessages(session) }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { type: 'question', text: shortFallbackQuestion(session.language, turnCount) };
  }

  if (session.rejectedGuesses.length > 0 && parsed.type === 'guess') {
    return { type: 'question', text: shortFallbackQuestion(session.language, turnCount) };
  }

  if (parsed.type === 'guess' && !canGuessNow) {
    return { type: 'question', text: shortFallbackQuestion(session.language, turnCount) };
  }

  const clean = sanitizeEngineResult(parsed, session);

  if (clean.type === 'question' && turnCount >= MAX_QUESTIONS_BEFORE_GUESS) {
    return await forceGuess(session);
  }

  return clean;
}

/* ============================================================
   FALLBACK ENGINE
   ============================================================ */
function fallbackEngine(session) {
  const list = session.language === 'ar'
    ? ['هل هو رجل؟','هل هو حقيقي؟','هل هو ممثل؟']
    : ['Is it male?','Is it real?','Is it an actor?'];

  return {
    type: 'question',
    text: list[Math.floor(Math.random() * list.length)]
  };
}
/* ============================================================
   API: HEALTH
   ============================================================ */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model, hasOpenAI: Boolean(openai) });
});

/* ============================================================
   API: START GAME
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
  } catch (err) {
    res.status(500).json({ error: 'Failed to start game' });
  }
});

/* ============================================================
   API: ANSWER
   ============================================================ */
app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body;
    const session = sessions.get(sessionId);

    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.turns.push({ question, answer: normalizeAnswer(answer) });
    session.questionsSinceLastRejectedGuess++;

    const result = await askEngine(session);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to process answer' });
  }
});

/* ============================================================
   API: CONFIRM GUESS
   ============================================================ */
app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body;
    const session = sessions.get(sessionId);

    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (correct) {
      return res.json({ type: 'revealed', guessName });
    }

    session.rejectedGuesses.push(guessName);
    session.questionsSinceLastRejectedGuess = 0;

    const result = await askEngine(session);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

/* ============================================================
   START SERVER
   ============================================================ */
app.listen(port, () => {
  console.log(`Magic Ball server running on http://localhost:${port}`);
});
