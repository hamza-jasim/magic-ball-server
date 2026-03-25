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

const INITIAL_MIN_QUESTIONS = 10;
const INITIAL_MAX_QUESTIONS = 20;
const FOLLOWUP_MIN_QUESTIONS = 5;
const FOLLOWUP_MAX_QUESTIONS = 10;
const MAX_CONSECUTIVE_GUESSES = 3;
const SESSION_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

function normalizeAnswer(answer) {
  const map = {
    yes: 'yes',
    no: 'no',
    maybe: 'maybe',
    dontKnow: 'dont_know',
    dont_know: 'dont_know'
  };
  return map[String(answer || '').trim()] || 'dont_know';
}

function makeSystemPrompt(language = 'ar') {
  const lang = language === 'ar' ? 'Arabic' : 'English';
  const isAr = language === 'ar';

  return `You are an elite character-guessing AI for a mobile game called Magic Ball.
Your job: identify the user's secret character using the fewest, smartest, highest-value questions.

=== CORE MISSION ===
Follow ONE logical track per game. Once a domain is confirmed (e.g. athlete, actor, fictional character),
stay within that domain and narrow down systematically. NEVER drift sideways into unrelated domains mid-game.

=== STRICT OUTPUT FORMAT ===
Return ONLY raw JSON. No markdown, no explanations, no extra text.

Question: {"type":"question","text":"..."}
Guess:    {"type":"guess","name":"...","confidence":0.85}

=== QUESTION RULES ===
- Ask ONE question at a time. Never combine two questions.
- ${isAr ? 'Arabic questions: 2-5 words maximum.' : 'English questions: 2-7 words maximum.'}
- Questions must be crisp, binary, and eliminate the most candidates possible.
- FORBIDDEN question types:
  * Name-revealing questions (never mention any person's name)
  * Double-choice questions ("male or female?", "actor or singer?")
  * Weak generic questions ("Is this person famous?", "Do you know him?")
  * Questions that repeat a prior question or restate it differently
  * Questions that contradict confirmed facts
  * Questions that abandon an established track mid-game

=== SMART QUESTIONING STRATEGY ===
Phase 1 - Universe (ask first):
  1. Real person or fictional character?
  2. Male or female? (as separate yes/no: "Is it male?")

Phase 2 - Domain (lock onto ONE domain based on answers):
  3. Broad domain: athlete? entertainer? politician? scientist? fictional hero?

Phase 3 - Narrow within domain (stay on this track!):
  4. Sub-domain: sport type, entertainment branch, region
  5. Time era: alive/active now or historical?
  6. Nationality/region if not yet confirmed

Phase 4 - Converge:
  7-onwards: increasingly specific discriminators until confident to guess

TRACK DISCIPLINE: If user said YES to "Is it an athlete?" then the next 5+ questions
must be about sports. Do NOT suddenly ask "Is it an actor?" - that breaks the track.

=== GUESS RULES ===
- Never guess before accumulating enough evidence (respect the min questions threshold).
- Guess exactly ONE name per turn.
- Never repeat a rejected guess.
- After a wrong guess: ask 2-4 tight narrowing questions before guessing again.
- Confidence must reflect actual certainty (0.5 = uncertain, 0.95 = very sure).
- ${isAr ? 'When language is Arabic, always provide the character name in Arabic script.' : 'Provide the character name in English.'}
- If the character is well-known globally and language is Arabic, use the Arabic transliteration of their name.

=== LANGUAGE ===
Output language: ${lang} ONLY.
All question text and guess name must be in ${lang}.

=== CRITICAL REMINDERS ===
- No name ever appears in a question.
- No repeated question semantics even with different wording.
- Track consistency is mandatory — one confirmed domain means all follow-up questions stay in that domain.
- Every question must eliminate many candidates at once (information gain maximization).`;
}

function buildUserMessage(session) {
  const turns = session.turns.length
    ? session.turns
        .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`)
        .join('\n')
    : 'No questions asked yet.';

  const rejected =
    session.rejectedGuesses.length > 0
      ? session.rejectedGuesses.join(', ')
      : 'none';

  const confirmedFacts = [];
  for (const turn of session.turns) {
    if (turn.answer === 'yes') {
      confirmedFacts.push(`CONFIRMED: ${turn.question}`);
    } else if (turn.answer === 'no') {
      confirmedFacts.push(`RULED OUT: ${turn.question}`);
    }
  }

  const facts =
    confirmedFacts.length > 0 ? confirmedFacts.join('\n') : 'None yet.';

  const canGuess = session.questionsSincePhaseReset >= session.minQuestionsBeforeGuess;
  const mustGuess = session.questionsSincePhaseReset >= session.maxQuestionsBeforeGuess;

  let instruction = '';
  if (mustGuess) {
    instruction =
      'You MUST make a guess now. You have reached the maximum questions for this phase. Output a guess JSON.';
  } else if (canGuess && session.guessStreak === 0) {
    instruction =
      'You have enough information to guess if confident. Otherwise ask one more targeted question.';
  } else if (session.guessStreak > 0) {
    const remainingCooldown = 2 - (session.questionsSincePhaseReset - 1);
    if (remainingCooldown > 0) {
      instruction = `Last guess was wrong. Ask ${remainingCooldown} more tight narrowing question(s) before guessing again.`;
    } else {
      instruction = 'You may guess again now with higher confidence, or ask one more question if needed.';
    }
  } else {
    const remaining = session.minQuestionsBeforeGuess - session.questionsSincePhaseReset;
    instruction = `Ask ${remaining} more question(s) before guessing. Stay on the confirmed track.`;
  }

  return `=== GAME STATE ===

Conversation history:
${turns}

Confirmed facts:
${facts}

Rejected guesses: ${rejected}
Wrong guess streak: ${session.guessStreak}
Questions in this phase: ${session.questionsSincePhaseReset}
Phase window: min=${session.minQuestionsBeforeGuess}, max=${session.maxQuestionsBeforeGuess}

=== YOUR INSTRUCTION ===
${instruction}

Output only one JSON object as described in your system prompt.`;
}

function canGuessNow(session) {
  return session.questionsSincePhaseReset >= session.minQuestionsBeforeGuess;
}

function mustGuessNow(session) {
  return session.questionsSincePhaseReset >= session.maxQuestionsBeforeGuess;
}

function safeLower(v) {
  return String(v || '').trim().toLowerCase();
}

function wordCount(text = '') {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function isQuestionTooLong(text = '', language = 'ar') {
  const count = wordCount(text);
  return language === 'ar' ? count > 6 : count > 8;
}

function isWeakQuestion(text = '') {
  const lower = safeLower(text);
  const weakPatterns = [
    'هل هو مشهور',
    'هل هي مشهورة',
    'هل هذه الشخصية مشهورة',
    'هل تعرفه',
    'هل تعرفها',
    'هل تعرف هذه الشخصية',
    'is it famous',
    'is this person famous',
    'is this character famous',
    'do you know',
    'is it well known',
    'is the person popular',
    'is it popular',
    'هل هو معروف',
    'هل هي معروفة'
  ];
  return weakPatterns.some((x) => lower.includes(x));
}

function isDoubleChoiceQuestion(text = '') {
  const lower = safeLower(text);
  return (
    lower.includes(' أو ') ||
    (lower.includes(' or ') && !lower.startsWith('is it or')) ||
    lower.includes('male or female') ||
    lower.includes('ذكر أو أنثى') ||
    lower.includes('رجل أو امرأة')
  );
}

function looksLikeNameQuestion(text = '') {
  const lower = safeLower(text);
  const namePatterns = [
    'هل اسمه',
    'هل اسمها',
    'هل هو محمد',
    'هل هي فاطمة',
    'is his name',
    'is her name',
    'is it named',
    'is the name'
  ];
  return namePatterns.some((x) => lower.includes(x));
}

function isDuplicateQuestion(text = '', session) {
  const lower = safeLower(text);
  return session.turns.some((t) => {
    const prev = safeLower(t.question);
    if (prev === lower) return true;
    const similarity = computeSimpleSimilarity(prev, lower);
    return similarity > 0.8;
  });
}

function computeSimpleSimilarity(a, b) {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : shared / union;
}

function isRejectedGuess(name, session) {
  const lower = safeLower(name);
  return session.rejectedGuesses.some((g) => safeLower(g) === lower);
}

function parseAIResponse(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function callAI(session, retries = 2) {
  if (!openai) {
    throw new Error('OpenAI client not initialized. Set OPENAI_API_KEY.');
  }

  const messages = [
    { role: 'system', content: makeSystemPrompt(session.language) },
    { role: 'user', content: buildUserMessage(session) }
  ];

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model,
        messages,
        temperature: 0.4,
        max_tokens: 150,
        response_format: { type: 'json_object' }
      });

      const raw = res.choices?.[0]?.message?.content || '';
      const parsed = parseAIResponse(raw);

      if (!parsed || !parsed.type) continue;
      if (parsed.type !== 'question' && parsed.type !== 'guess') continue;
      if (parsed.type === 'question' && !parsed.text) continue;
      if (parsed.type === 'guess' && !parsed.name) continue;

      return parsed;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }

  return null;
}

function createSession(language) {
  return {
    id: crypto.randomUUID(),
    language: language || 'ar',
    turns: [],
    rejectedGuesses: [],
    guessStreak: 0,
    questionsSincePhaseReset: 0,
    minQuestionsBeforeGuess: INITIAL_MIN_QUESTIONS,
    maxQuestionsBeforeGuess: INITIAL_MAX_QUESTIONS,
    lastActivity: Date.now(),
    totalGuesses: 0
  };
}

app.post('/api/start', (req, res) => {
  const language = req.body?.language === 'en' ? 'en' : 'ar';
  const session = createSession(language);
  sessions.set(session.id, session);
  res.json({ sessionId: session.id });
});

app.post('/api/next', async (req, res) => {
  const { sessionId } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  session.lastActivity = Date.now();

  if (!openai) {
    return res.status(503).json({ error: 'AI not configured. Set OPENAI_API_KEY.' });
  }

  const MAX_VALIDATION_ATTEMPTS = 4;
  let result = null;

  for (let attempt = 0; attempt < MAX_VALIDATION_ATTEMPTS; attempt++) {
    const raw = await callAI(session);
    if (!raw) continue;

    if (raw.type === 'guess') {
      if (isRejectedGuess(raw.name, session)) continue;
      result = raw;
      break;
    }

    if (raw.type === 'question') {
      const text = String(raw.text || '').trim();

      if (!text) continue;
      if (isWeakQuestion(text)) continue;
      if (isDoubleChoiceQuestion(text)) continue;
      if (looksLikeNameQuestion(text)) continue;
      if (isDuplicateQuestion(text, session)) continue;
      if (isQuestionTooLong(text, session.language) && attempt < MAX_VALIDATION_ATTEMPTS - 1) continue;

      result = raw;
      break;
    }
  }

  if (!result) {
    if (mustGuessNow(session) || canGuessNow(session)) {
      result = {
        type: 'guess',
        name: session.language === 'ar' ? 'شخصية غير معروفة' : 'Unknown character',
        confidence: 0.3
      };
    } else {
      return res.status(500).json({ error: 'Failed to generate a valid question after multiple attempts' });
    }
  }

  if (result.type === 'question') {
    session.questionsSincePhaseReset++;
  }

  res.json({ result });
});

app.post('/api/answer', async (req, res) => {
  const { sessionId, answer } = req.body || {};

  if (!sessionId || !answer) {
    return res.status(400).json({ error: 'sessionId and answer are required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  session.lastActivity = Date.now();
  const normalized = normalizeAnswer(answer);

  if (!session.pendingQuestion) {
    return res.status(400).json({ error: 'No pending question to answer' });
  }

  session.turns.push({
    question: session.pendingQuestion,
    answer: normalized
  });

  session.pendingQuestion = null;
  res.json({ ok: true });
});

app.post('/api/next-with-answer', async (req, res) => {
  const { sessionId, answer, question } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  session.lastActivity = Date.now();

  if (answer && question) {
    const normalized = normalizeAnswer(answer);
    session.turns.push({
      question: String(question),
      answer: normalized
    });
    session.questionsSincePhaseReset++;
  }

  if (!openai) {
    return res.status(503).json({ error: 'AI not configured. Set OPENAI_API_KEY.' });
  }

  const MAX_VALIDATION_ATTEMPTS = 4;
  let result = null;

  for (let attempt = 0; attempt < MAX_VALIDATION_ATTEMPTS; attempt++) {
    const raw = await callAI(session);
    if (!raw) continue;

    if (raw.type === 'guess') {
      if (isRejectedGuess(raw.name, session)) continue;
      result = raw;
      break;
    }

    if (raw.type === 'question') {
      const text = String(raw.text || '').trim();

      if (!text) continue;
      if (isWeakQuestion(text)) continue;
      if (isDoubleChoiceQuestion(text)) continue;
      if (looksLikeNameQuestion(text)) continue;
      if (isDuplicateQuestion(text, session)) continue;
      if (isQuestionTooLong(text, session.language) && attempt < MAX_VALIDATION_ATTEMPTS - 1) continue;

      result = raw;
      break;
    }
  }

  if (!result) {
    if (mustGuessNow(session) || canGuessNow(session)) {
      result = {
        type: 'guess',
        name: session.language === 'ar' ? 'شخصية غير معروفة' : 'Unknown character',
        confidence: 0.3
      };
    } else {
      return res.status(500).json({ error: 'Failed to generate a valid question' });
    }
  }

  res.json({ result });
});

app.post('/api/guess-result', async (req, res) => {
  const { sessionId, correct, guessedName } = req.body || {};

  if (!sessionId || correct === undefined) {
    return res.status(400).json({ error: 'sessionId and correct are required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  session.lastActivity = Date.now();
  session.totalGuesses++;

  if (correct) {
    sessions.delete(sessionId);
    return res.json({ ok: true, won: true });
  }

  if (guessedName) {
    const name = String(guessedName).trim();
    if (name && !session.rejectedGuesses.includes(name)) {
      session.rejectedGuesses.push(name);
    }
  }

  session.guessStreak++;

  if (session.guessStreak >= MAX_CONSECUTIVE_GUESSES) {
    sessions.delete(sessionId);
    return res.json({
      ok: true,
      won: false,
      gaveUp: true,
      message:
        session.language === 'ar'
          ? 'لم أستطع معرفة الشخصية. أنت الفائز!'
          : "I couldn't figure it out. You win!"
    });
  }

  session.minQuestionsBeforeGuess = FOLLOWUP_MIN_QUESTIONS;
  session.maxQuestionsBeforeGuess = FOLLOWUP_MAX_QUESTIONS;
  session.questionsSincePhaseReset = 0;

  return res.json({ ok: true, won: false, gaveUp: false });
});

app.get('/api/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({
    sessionId: session.id,
    language: session.language,
    turnsCount: session.turns.length,
    rejectedGuesses: session.rejectedGuesses,
    guessStreak: session.guessStreak,
    questionsSincePhaseReset: session.questionsSincePhaseReset,
    phase: {
      min: session.minQuestionsBeforeGuess,
      max: session.maxQuestionsBeforeGuess
    }
  });
});

app.delete('/api/session/:sessionId', (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

app.listen(port, () => {
  console.log(`Magic Ball server running on port ${port}`);
  if (!openai) {
    console.warn('WARNING: OPENAI_API_KEY not set. AI features disabled.');
  }
});
