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

// ============================
// CONSTANTS
// ============================
const INITIAL_MIN_Q  = 10;
const INITIAL_MAX_Q  = 20;
const FOLLOWUP_MIN_Q = 5;
const FOLLOWUP_MAX_Q = 10;
const MAX_WRONG_GUESSES = 3;
const SESSION_TTL_MS = 30 * 60 * 1000;

// Clean expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ============================
// SESSION FACTORY
// ============================
function createSession(language) {
  return {
    id: crypto.randomUUID(),
    language: language === 'en' ? 'en' : 'ar',
    turns: [],               // { question, answer }
    rejectedGuesses: [],     // names that were wrong
    guessStreak: 0,          // consecutive wrong guesses
    phaseQ: 0,               // questions asked in current phase
    minQ: INITIAL_MIN_Q,
    maxQ: INITIAL_MAX_Q,
    lastActivity: Date.now()
  };
}

// ============================
// NORMALIZE ANSWER
// ============================
function normalizeAnswer(answer) {
  const map = {
    yes: 'yes', no: 'no', maybe: 'maybe',
    dontKnow: 'dont_know', dont_know: 'dont_know'
  };
  return map[String(answer || '').trim()] || 'dont_know';
}

// ============================
// SYSTEM PROMPT
// ============================
function makeSystemPrompt(language) {
  const isAr = language === 'ar';
  const lang  = isAr ? 'Arabic' : 'English';

  return `You are an elite AI engine for a character-guessing mobile game called "Magic Ball."
Your goal: identify the user's secret character using smart, focused, information-rich questions.

━━━ OUTPUT FORMAT (STRICT) ━━━
Return ONLY valid JSON. No markdown. No explanation. No extra text.

Question → {"type":"question","text":"..."}
Guess    → {"type":"guess","name":"...","confidence":0.90}

━━━ TRACK DISCIPLINE (CRITICAL) ━━━
Once a domain is confirmed (e.g. athlete, actor, fictional character, politician), you MUST stay
inside that domain for ALL subsequent questions. Never switch domains mid-game.
Example: if user said YES to "Is it a sportsperson?" → every next question must be about sports.

━━━ QUESTION RULES ━━━
1. Ask only ONE question per turn — never combine two.
2. ${isAr ? 'Arabic: max 5 words per question.' : 'English: max 7 words per question.'}
3. Each question must eliminate as many candidates as possible (maximum information gain).
4. NEVER ask about a person's name during question mode.
5. NEVER ask weak questions ("Is this person famous?", "Do you know them?").
6. NEVER ask double-choice questions ("male or female?", "actor or singer?").
7. NEVER repeat a previous question, even with different wording.
8. NEVER contradict confirmed facts from the conversation history.

━━━ OPTIMAL QUESTION ORDER ━━━
Phase 1 – Universe:
  • Real person vs. fictional character?
  • Male (if real: man; if fictional: male character)?

Phase 2 – Domain (lock ONE domain and never leave):
  • Broad field: athlete / entertainer / politician / scientist / fictional hero…

Phase 3 – Narrow within domain:
  • Sub-category (sport type, entertainment branch, genre…)
  • Nationality / region
  • Era: currently active / alive?

Phase 4 – Converge to guess:
  • Increasingly specific discriminators until confident

━━━ GUESS RULES ━━━
• Guess ONE name only.
• Never repeat a rejected guess.
• Wait until you have enough evidence (respect the min threshold in game state).
• After a wrong guess, ask 2–3 tight questions before guessing again.
• ${isAr ? 'Provide the character name in Arabic script (transliterate if needed).' : 'Provide the character name in English.'}
• Confidence: 0.5 = unsure, 0.95 = very sure — be honest.

━━━ LANGUAGE ━━━
ALL output (questions and guess names) must be in ${lang} only.`;
}

// ============================
// BUILD USER MESSAGE
// ============================
function buildUserMessage(session) {
  // Conversation history
  const history = session.turns.length
    ? session.turns.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`).join('\n')
    : 'No questions yet.';

  // Key confirmed facts
  const facts = session.turns
    .filter(t => t.answer === 'yes' || t.answer === 'no')
    .map(t => `${t.answer === 'yes' ? '✓ YES' : '✗ NO'}: ${t.question}`)
    .join('\n') || 'None yet.';

  const rejected = session.rejectedGuesses.length
    ? session.rejectedGuesses.join(', ')
    : 'none';

  // Decide instruction
  let instruction;
  if (session.phaseQ >= session.maxQ) {
    instruction = '⚠ MAX QUESTIONS REACHED. You MUST output a guess now.';
  } else if (session.guessStreak > 0 && session.phaseQ < 2) {
    instruction = `Last guess was wrong. Ask ${2 - session.phaseQ} more narrowing question(s) before guessing again.`;
  } else if (session.phaseQ >= session.minQ) {
    instruction = 'You have enough evidence. Output a guess if confident, or one more targeted question.';
  } else {
    const left = session.minQ - session.phaseQ;
    instruction = `Ask ${left} more question(s) before you may guess. Stay strictly on the confirmed domain track.`;
  }

  return `━━━ GAME STATE ━━━

Conversation history:
${history}

Key confirmed facts:
${facts}

Rejected guesses: ${rejected}
Wrong guess streak: ${session.guessStreak}
Questions this phase: ${session.phaseQ} (min to guess: ${session.minQ}, max: ${session.maxQ})

━━━ YOUR TASK ━━━
${instruction}

Respond with exactly one JSON object.`;
}

// ============================
// VALIDATION HELPERS
// ============================
function safeLower(v) {
  return String(v || '').trim().toLowerCase();
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function isWeakQuestion(text) {
  const low = safeLower(text);
  return [
    'هل هو مشهور', 'هل هي مشهورة', 'هل هذه الشخصية مشهورة',
    'هل تعرفه', 'هل تعرفها', 'هل هو معروف', 'هل هي معروفة',
    'is it famous', 'is this person famous', 'is this character famous',
    'do you know', 'is it well known', 'is the person popular', 'is it popular'
  ].some(p => low.includes(p));
}

function isDoubleChoice(text) {
  const low = safeLower(text);
  return (
    low.includes(' أو ') ||
    low.includes('ذكر أو') ||
    low.includes('رجل أو') ||
    low.includes('male or female') ||
    (low.includes(' or ') && low.includes('?') && !low.startsWith('is it or'))
  );
}

function isNameQuestion(text) {
  const low = safeLower(text);
  return ['هل اسمه', 'هل اسمها', 'is his name', 'is her name', 'is it named', 'is the name']
    .some(p => low.includes(p));
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : shared / union;
}

function isDuplicate(text, session) {
  const low = safeLower(text);
  return session.turns.some(t => {
    const prev = safeLower(t.question);
    return prev === low || jaccardSimilarity(prev, low) > 0.75;
  });
}

function isRejected(name, session) {
  const low = safeLower(name);
  return session.rejectedGuesses.some(g => safeLower(g) === low);
}

function parseJSON(raw) {
  let text = String(raw || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// ============================
// CALL AI
// ============================
async function callAI(session) {
  if (!openai) throw new Error('OPENAI_API_KEY is not set.');

  const messages = [
    { role: 'system', content: makeSystemPrompt(session.language) },
    { role: 'user',   content: buildUserMessage(session) }
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 120
      });

      const raw    = res.choices?.[0]?.message?.content || '';
      const parsed = parseJSON(raw);
      if (parsed && (parsed.type === 'question' || parsed.type === 'guess')) return parsed;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return null;
}

// ============================
// GENERATE NEXT STEP
// Validates & retries until a clean question/guess is produced
// ============================
async function generateNext(session) {
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const raw = await callAI(session);
    if (!raw) continue;

    // ---- GUESS ----
    if (raw.type === 'guess') {
      const name = String(raw.name || '').trim();
      if (!name) continue;
      if (isRejected(name, session)) continue;
      return raw;
    }

    // ---- QUESTION ----
    if (raw.type === 'question') {
      const text = String(raw.text || '').trim();
      if (!text) continue;
      if (isWeakQuestion(text)) continue;
      if (isDoubleChoice(text)) continue;
      if (isNameQuestion(text)) continue;
      if (isDuplicate(text, session)) continue;
      // Allow slightly long questions on last attempt
      const maxWords = session.language === 'ar' ? 6 : 9;
      if (wordCount(text) > maxWords && attempt < MAX_ATTEMPTS - 1) continue;
      return raw;
    }
  }

  // Fallback: if we must guess, return unknown; else fail gracefully
  if (session.phaseQ >= session.maxQ) {
    return {
      type: 'guess',
      name: session.language === 'ar' ? 'شخصية غير معروفة' : 'Unknown character',
      confidence: 0.3
    };
  }

  return null;
}

// ============================
// ROUTES
// ============================

// POST /api/start  →  { sessionId }
app.post('/api/start', (req, res) => {
  const language = req.body?.language === 'en' ? 'en' : 'ar';
  const session  = createSession(language);
  sessions.set(session.id, session);
  res.json({ sessionId: session.id });
});

// POST /api/next  →  { result: { type, text? } | { type, name, confidence } }
// Call this to get the first question (no answer yet).
app.post('/api/next', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });

  session.lastActivity = Date.now();

  if (!openai) return res.status(503).json({ error: 'AI not configured. Set OPENAI_API_KEY.' });

  try {
    const result = await generateNext(session);
    if (!result) return res.status(500).json({ error: 'Could not generate a valid question. Try again.' });

    // Track question count only for questions
    if (result.type === 'question') session.phaseQ++;

    res.json({ result });
  } catch (err) {
    console.error('callAI error:', err.message);
    res.status(500).json({ error: 'AI request failed: ' + err.message });
  }
});

// POST /api/answer  →  { result: next question or guess }
// Send the player's answer to the last question, get the next step.
// Body: { sessionId, question: "text of the question asked", answer: "yes|no|maybe|dont_know" }
app.post('/api/answer', async (req, res) => {
  const { sessionId, question, answer } = req.body || {};

  if (!sessionId)  return res.status(400).json({ error: 'sessionId is required' });
  if (!question)   return res.status(400).json({ error: 'question is required' });
  if (!answer)     return res.status(400).json({ error: 'answer is required' });

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });

  session.lastActivity = Date.now();

  // Record the answer
  session.turns.push({ question: String(question), answer: normalizeAnswer(answer) });

  if (!openai) return res.status(503).json({ error: 'AI not configured. Set OPENAI_API_KEY.' });

  try {
    const result = await generateNext(session);
    if (!result) return res.status(500).json({ error: 'Could not generate next step. Try again.' });

    if (result.type === 'question') session.phaseQ++;

    res.json({ result });
  } catch (err) {
    console.error('callAI error:', err.message);
    res.status(500).json({ error: 'AI request failed: ' + err.message });
  }
});

// POST /api/guess-result  →  { ok, won, gaveUp?, message? }
// Tell the server whether the guess was correct.
// Body: { sessionId, correct: true|false, guessedName: "..." }
app.post('/api/guess-result', (req, res) => {
  const { sessionId, correct, guessedName } = req.body || {};

  if (!sessionId || correct === undefined)
    return res.status(400).json({ error: 'sessionId and correct are required' });

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });

  session.lastActivity = Date.now();

  // ---- CORRECT GUESS ----
  if (correct) {
    sessions.delete(sessionId);
    return res.json({ ok: true, won: true });
  }

  // ---- WRONG GUESS ----
  const name = String(guessedName || '').trim();
  if (name && !session.rejectedGuesses.includes(name)) session.rejectedGuesses.push(name);

  session.guessStreak++;

  if (session.guessStreak >= MAX_WRONG_GUESSES) {
    sessions.delete(sessionId);
    return res.json({
      ok: true, won: false, gaveUp: true,
      message: session.language === 'ar'
        ? 'لم أستطع معرفة الشخصية. أنت الفائز!'
        : "I couldn't figure it out. You win!"
    });
  }

  // Reset phase counters for follow-up questions
  session.minQ  = FOLLOWUP_MIN_Q;
  session.maxQ  = FOLLOWUP_MAX_Q;
  session.phaseQ = 0;

  return res.json({ ok: true, won: false, gaveUp: false });
});

// GET /api/session/:sessionId  →  session summary (for debugging)
app.get('/api/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId:      session.id,
    language:       session.language,
    turns:          session.turns.length,
    rejectedGuesses: session.rejectedGuesses,
    guessStreak:    session.guessStreak,
    phaseQ:         session.phaseQ,
    phase:          { min: session.minQ, max: session.maxQ }
  });
});

// DELETE /api/session/:sessionId  →  end session manually
app.delete('/api/session/:sessionId', (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ ok: true });
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', activeSessions: sessions.size, model });
});

// ============================
// START SERVER
// ============================
app.listen(port, () => {
  console.log(`Magic Ball server running on port ${port}`);
  console.log(`Model: ${model}`);
  if (!openai) console.warn('WARNING: OPENAI_API_KEY not set. AI features disabled.');
});
