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

// ========================
// FINAL RULES
// ========================
const INITIAL_MIN_QUESTIONS = 8;
const INITIAL_MAX_QUESTIONS = 13;

const FOLLOWUP_MIN_QUESTIONS = 5;
const FOLLOWUP_MAX_QUESTIONS = 8;

const MAX_CONSECUTIVE_GUESSES = 3;

// ========================
// HELPERS
// ========================
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
  return `You are the final production-grade character guessing engine for a mobile app.

MISSION:
Identify the user's character through very short, high-value, contradiction-free questions.

STRICT FORMAT:
- Return STRICT JSON only.
- No markdown.
- No explanations.
- No commentary.
- No multiple options in one question.

ALLOWED ANSWERS:
yes, no, maybe, dont_know

ABSOLUTE QUESTION RULES:
- Ask only ONE question at a time.
- Arabic questions should usually be 2 to 5 words.
- English questions should usually be 2 to 7 words.
- Keep them sharp, natural, and easy.
- Never mention any person name during question mode.
- Never ask name-based questions.
- Never ask a double-choice question such as "male or female".
- Never ask generic weak questions like "Is this person famous?" unless there is absolutely no better discriminator.
- Never repeat a previous question or repeat the same meaning with different wording.
- Never contradict confirmed information.
- Never jump to an unrelated domain after a strong confirmation.
- Every question should eliminate many possibilities.

BEST QUESTION ORDER:
1. real vs fictional
2. male vs female
3. broad field
4. nationality / region
5. alive vs dead
6. narrower category
7. strong discriminator
8. move toward best guess

QUALITY EXAMPLES:
Good:
- "هل هو رجل؟"
- "هل هي خيالية؟"
- "هل هو رياضي؟"
- "هل هو عربي؟"
- "هل هو حي؟"
- "هل هو ممثل؟"

Bad:
- "هل هو ذكر أو أنثى؟"
- "هل تعرفه؟"
- "هل هذه الشخصية مشهورة؟"
- "Is it male or female?"
- "Do you know him?"
- Any question mentioning a candidate name

GUESS RULES:
- Guess only one person.
- Never repeat rejected guesses.
- Do not guess before enough evidence.
- When enough evidence exists, guess decisively.
- After multiple wrong guesses, return to tighter questions before guessing again.

LANGUAGE:
- If language is "ar", output Arabic only.
- If language is "en", output English only.

OUTPUT FORMAT:

Question:
{"type":"question","text":"..."}

Guess:
{"type":"guess","name":"...","confidence":0.82}`;
}

function sessionTranscript(session) {
  const turns = session.turns.length
    ? session.turns
        .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`)
        .join('\n')
    : 'No questions yet.';

  const rejected = session.rejectedGuesses.length
    ? session.rejectedGuesses.join(', ')
    : 'none';

  return [
    `Turns:\n${turns}`,
    `Rejected guesses: ${rejected}`,
    `Wrong guess streak: ${session.guessStreak}`,
    `Questions in current phase: ${session.questionsSincePhaseReset}`,
    `Current phase window: ${session.minQuestionsBeforeGuess} to ${session.maxQuestionsBeforeGuess}`
  ].join('\n\n');
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
  return language === 'ar' ? count > 5 : count > 7;
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
    'is the person popular'
  ];

  return weakPatterns.some((x) => lower.includes(x));
}

function isDoubleChoiceQuestion(text = '') {
  const lower = safeLower(text);
  return (
    lower.includes(' أو ') ||
    lower.includes('or') ||
    lower.includes('male or female') ||
    lower.includes('ذكر أو أنثى')
  );
}

function looksLikeNameQuestion(text = '') {
  const lower = safeLower(text);

  if (
    lower.startsWith('is it ') ||
    lower.startsWith('is this ') ||
    lower.startsWith('could it be ') ||
    lower.startsWith('is the person ') ||
    lower.startsWith('is this person ')
  ) {
    return true;
  }

  if (lower.includes('هل هو ') || lower.includes('هل هي ')) {
    const count = wordCount(lower);
    if (count > 4) return true;
  }

  return false;
}

function questionConceptKey(text = '') {
  const lower = safeLower(text);

  // identity
  if (lower.includes('حقيقي') || lower.includes('خيالي') || lower.includes('real') || lower.includes('fiction')) {
    return 'reality';
  }

  // gender
  if (lower.includes('رجل') || lower.includes('امرأة') || lower.includes('male') || lower.includes('female')) {
    return 'gender';
  }

  // nationality / region
  if (
    lower.includes('عربي') ||
    lower.includes('أجنبي') ||
    lower.includes('arab') ||
    lower.includes('foreign') ||
    lower.includes('مصري') ||
    lower.includes('عراقي') ||
    lower.includes('american') ||
    lower.includes('british')
  ) {
    return 'region';
  }

  // alive/dead
  if (
    lower.includes('حي') ||
    lower.includes('متوفى') ||
    lower.includes('alive') ||
    lower.includes('dead') ||
    lower.includes('deceased')
  ) {
    return 'alive';
  }

  // profession broad
  if (
    lower.includes('فنان') ||
    lower.includes('artist') ||
    lower.includes('رياضي') ||
    lower.includes('athlete') ||
    lower.includes('سياسي') ||
    lower.includes('politician') ||
    lower.includes('عالم') ||
    lower.includes('scientist')
  ) {
    return 'field';
  }

  // narrow categories
  if (lower.includes('ممثل') || lower.includes('actor')) return 'actor';
  if (lower.includes('مغني') || lower.includes('singer')) return 'singer';
  if (lower.includes('كرة') || lower.includes('football')) return 'footballer';
  if (lower.includes('لاعب') && lower.includes('كرة')) return 'footballer';

  return lower.replace(/\s+/g, ' ').trim();
}

function inferState(turns) {
  const state = {
    real: null,
    fictional: null,
    male: null,
    female: null,
    arab: null,
    foreign: null,
    alive: null,
    dead: null,
    artist: null,
    athlete: null,
    politician: null,
    scientist: null,
    actor: null,
    singer: null,
    footballer: null
  };

  for (const turn of turns) {
    const q = safeLower(turn.question);
    const a = normalizeAnswer(turn.answer);

    if (a !== 'yes' && a !== 'no') continue;

    const yes = a === 'yes';

    const setState = (key) => {
      state[key] = yes;
    };

    if (q.includes('حقيقي') || q.includes('real')) setState('real');
    if (q.includes('خيالي') || q.includes('fiction')) setState('fictional');

    if (q.includes('رجل') || q.includes('male')) setState('male');
    if (q.includes('امرأة') || q.includes('female')) setState('female');

    if (q.includes('عربي') || q.includes('arab')) setState('arab');
    if (q.includes('أجنبي') || q.includes('foreign')) setState('foreign');

    if (q.includes('حي') || q.includes('alive')) setState('alive');
    if (q.includes('متوفى') || q.includes('dead') || q.includes('deceased')) setState('dead');

    if (q.includes('فنان') || q.includes('artist')) setState('artist');
    if (q.includes('رياضي') || q.includes('athlete')) setState('athlete');
    if (q.includes('سياسي') || q.includes('politician')) setState('politician');
    if (q.includes('عالم') || q.includes('scientist')) setState('scientist');

    if (q.includes('ممثل') || q.includes('actor')) setState('actor');
    if (q.includes('مغني') || q.includes('singer')) setState('singer');
    if (q.includes('كرة') || q.includes('football')) setState('footballer');
  }

  return state;
}

function contradictsState(text, session) {
  const key = questionConceptKey(text);
  const state = inferState(session.turns);

  // hard contradictions
  if (key === 'actor' && state.singer === true) return true;
  if (key === 'singer' && state.actor === true) return true;

  if (key === 'field') {
    const lower = safeLower(text);
    if (state.singer === true && lower.includes('سياسي')) return true;
    if (state.singer === true && lower.includes('politician')) return true;
    if (state.actor === true && lower.includes('رياضي')) return true;
    if (state.actor === true && lower.includes('athlete')) return true;
    if (state.athlete === true && (lower.includes('مغني') || lower.includes('singer'))) return true;
    if (state.athlete === true && (lower.includes('ممثل') || lower.includes('actor'))) return true;
  }

  if (key === 'gender') {
    const lower = safeLower(text);
    if (state.male === true && (lower.includes('امرأة') || lower.includes('female'))) return true;
    if (state.female === true && (lower.includes('رجل') || lower.includes('male'))) return true;
  }

  if (key === 'alive') {
    const lower = safeLower(text);
    if (state.alive === true && (lower.includes('متوفى') || lower.includes('dead'))) return true;
    if (state.dead === true && (lower.includes('حي') || lower.includes('alive'))) return true;
  }

  if (key === 'region') {
    const lower = safeLower(text);
    if (state.arab === true && (lower.includes('أجنبي') || lower.includes('foreign'))) return true;
    if (state.foreign === true && (lower.includes('عربي') || lower.includes('arab'))) return true;
  }

  return false;
}

function repeatedConcept(text, session) {
  const key = questionConceptKey(text);
  return session.turns.some((t) => questionConceptKey(t.question) === key);
}

function shortFallbackQuestion(language = 'ar', session = null) {
  const state = session ? inferState(session.turns) : {};

  const ar = [];
  const en = [];

  if (state.real == null && state.fictional == null) {
    ar.push('هل هي حقيقية؟');
    en.push('Is it real?');
  }

  if (state.male == null && state.female == null) {
    ar.push('هل هو رجل؟');
    en.push('Is it male?');
  }

  if (state.artist == null && state.athlete == null && state.politician == null && state.scientist == null) {
    ar.push('هل هو رياضي؟', 'هل هو فنان؟', 'هل هو سياسي؟');
    en.push('Is it an athlete?', 'Is it an artist?', 'Is it a politician?');
  }

  if (state.arab == null && state.foreign == null) {
    ar.push('هل هو عربي؟');
    en.push('Is it Arab?');
  }

  if (state.alive == null && state.dead == null) {
    ar.push('هل هو حي؟');
    en.push('Is it alive?');
  }

  if (state.athlete === true && state.footballer == null) {
    ar.push('هل هو لاعب كرة؟');
    en.push('Is it a footballer?');
  }

  if (state.artist === true && state.actor == null && state.singer == null) {
    ar.push('هل هو ممثل؟', 'هل هو مغني؟');
    en.push('Is it an actor?', 'Is it a singer?');
  }

  const defaultsAr = [
    'هل هي خيالية؟',
    'هل هو أجنبي؟',
    'هل هو ممثل؟',
    'هل هو مغني؟',
    'هل هو سياسي؟',
    'هل هو لاعب كرة؟'
  ];

  const defaultsEn = [
    'Is it fictional?',
    'Is it foreign?',
    'Is it an actor?',
    'Is it a singer?',
    'Is it a politician?',
    'Is it a footballer?'
  ];

  const list = language === 'ar' ? [...ar, ...defaultsAr] : [...en, ...defaultsEn];
  return list[0];
}

function fallbackGuess(language = 'ar') {
  return language === 'ar'
    ? { type: 'guess', name: 'شخصية مشهورة', confidence: 0.2 }
    : { type: 'guess', name: 'A famous person', confidence: 0.2 };
}

function sanitizeEngineResult(result, session) {
  if (!result || typeof result !== 'object') {
    return { type: 'question', text: shortFallbackQuestion(session.language, session) };
  }

  if (result.type === 'question') {
    const text = String(result.text || '').trim();

    if (!text) {
      return { type: 'question', text: shortFallbackQuestion(session.language, session) };
    }

    if (isQuestionTooLong(text, session.language)) {
      return { type: 'question', text: shortFallbackQuestion(session.language, session) };
    }

    if (isWeakQuestion(text)) {
      return { type: 'question', text: shortFallbackQuestion(session.language, session) };
    }

    if (isDoubleChoiceQuestion(text)) {
      return { type: 'question', text: shortFallbackQuestion(session.language, session) };
    }

    if (looksLikeNameQuestion(text)) {
      return { type: 'question', text: shortFallbackQuestion(session.language, session) };
    }

    if (repeatedConcept(text, session)) {
      return { type: 'question', text: shortFallbackQuestion(session.language, session) };
    }

    if (contradictsState(text, session)) {
      return { type: 'question', text: shortFallbackQuestion(session.language, session) };
    }

    return { type: 'question', text };
  }

  if (result.type === 'guess') {
    const name = String(result.name || '').trim();

    if (!name) {
      return fallbackGuess(session.language);
    }

    if (session.rejectedGuesses.includes(name)) {
      return { type: 'question', text: shortFallbackQuestion(session.language, session) };
    }

    return {
      type: 'guess',
      name,
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.6
    };
  }

  return { type: 'question', text: shortFallbackQuestion(session.language, session) };
}

async function forceSingleGuess(session) {
  if (!openai) {
    return fallbackGuess(session.language);
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Make your single best guess now.
Do not repeat rejected guesses.
Return STRICT JSON only.

Format:
{"type":"guess","name":"...","confidence":0.82}`
      },
      {
        role: 'user',
        content: `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionTranscript(session)}

Make exactly one best guess now.`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    const clean = sanitizeEngineResult(parsed, session);
    return clean.type === 'guess' ? clean : fallbackGuess(session.language);
  } catch {
    return fallbackGuess(session.language);
  }
}

async function askEngine(session) {
  if (!openai) {
    if (mustGuessNow(session)) {
      return fallbackGuess(session.language);
    }
    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, session)
    };
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      {
        role: 'user',
        content: `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionTranscript(session)}

SERVER RULES:
- Current phase guess window: ${session.minQuestionsBeforeGuess} to ${session.maxQuestionsBeforeGuess}
- Do not guess before ${session.minQuestionsBeforeGuess} questions in this phase
- Must guess at ${session.maxQuestionsBeforeGuess} questions in this phase
- Never repeat rejected guesses
- Never mention names in question mode
- Avoid contradictions
- Keep questions short and powerful`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    let result = sanitizeEngineResult(parsed, session);

    if (result.type === 'guess' && !canGuessNow(session)) {
      result = {
        type: 'question',
        text: shortFallbackQuestion(session.language, session)
      };
    }

    if (mustGuessNow(session) && result.type !== 'guess') {
      return await forceSingleGuess(session);
    }

    return result;
  } catch {
    if (mustGuessNow(session)) {
      return await forceSingleGuess(session);
    }

    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, session)
    };
  }
}

async function fetchWikipediaSummary(name, language = 'ar') {
  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(String(name || '').replace(/ /g, '_'));
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
    articleURL: json.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${title}`
  };
}

// ========================
// ROUTES
// ========================
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model,
    hasOpenAI: Boolean(openai)
  });
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
      minQuestionsBeforeGuess: INITIAL_MIN_QUESTIONS,
      maxQuestionsBeforeGuess: INITIAL_MAX_QUESTIONS
    };

    sessions.set(sessionId, session);

    const result = await askEngine(session);
    return res.json({ sessionId, ...result });
  } catch (error) {
    console.error('/api/game/start error:', error);
    return res.status(500).json({ error: 'Failed to start game' });
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

    session.questionsSincePhaseReset += 1;

    const result = await askEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/answer error:', error);
    return res.status(500).json({ error: 'Failed to process answer' });
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

      session.guessStreak = 0;
      session.questionsSincePhaseReset = 0;
      session.minQuestionsBeforeGuess = INITIAL_MIN_QUESTIONS;
      session.maxQuestionsBeforeGuess = INITIAL_MAX_QUESTIONS;

      return res.json({
        type: 'revealed',
        guessName,
        wiki
      });
    }

    if (guessName) {
      session.rejectedGuesses.push(String(guessName));
    }

    session.guessStreak += 1;

    // first 3 wrong guesses => allow consecutive guesses
    if (session.guessStreak < MAX_CONSECUTIVE_GUESSES) {
      const result = await forceSingleGuess(session);
      return res.json(result);
    }

    // after 3 wrong guesses => reset and ask 5 to 8 more questions
    session.guessStreak = 0;
    session.questionsSincePhaseReset = 0;
    session.minQuestionsBeforeGuess = FOLLOWUP_MIN_QUESTIONS;
    session.maxQuestionsBeforeGuess = FOLLOWUP_MAX_QUESTIONS;

    const result = await askEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/guess-confirm error:', error);
    return res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    const language = req.query.language === 'en' ? 'en' : 'ar';

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const wiki = await fetchWikipediaSummary(name, language);
    return res.json(wiki);
  } catch (error) {
    console.error('/api/wiki error:', error);
    return res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

app.listen(port, () => {
  console.log(`Magic Ball Beast server running on http://localhost:${port}`);
});