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

const INITIAL_MIN_QUESTIONS = 8;
const INITIAL_MAX_QUESTIONS = 13;
const FOLLOWUP_MIN_QUESTIONS = 5;
const FOLLOWUP_MAX_QUESTIONS = 8;
const MAX_CONSECUTIVE_GUESSES = 3;

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

GOOD EXAMPLES:
- "هل هو رجل؟"
- "هل هي خيالية؟"
- "هل هو رياضي؟"
- "هل هو عربي؟"
- "هل هو حي؟"
- "هل هو ممثل؟"

BAD EXAMPLES:
- "هل هو ذكر أو أنثى؟"
- "هل تعرفه؟"
- "هل هذه الشخصية مشهورة؟"
- "Is it male or female?"
- "Do you know him?"

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
    ? session.turns.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`).join('\n')
    : 'No questions yet.';

  const rejected = session.rejectedGuesses.length
    ? session.rejectedGuesses.join(', ')
    : 'none';

  return [
    `Turns:\n${turns}`,
    `Rejected guesses: ${rejected}`,
    `Wrong guess streak: ${session.guessStreak}`,
    `Questions in current phase: ${session.questionsSincePhaseReset}`,
    `Current phase window: ${session.minQuestionsBeforeGuess} to ${session.maxQuestionsBeforeGuess}`,
    `Follow-up mode: ${session.followupMode ? 'true' : 'false'}`
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

  if (lower.includes('حقيقي') || lower.includes('خيالي') || lower.includes('real') || lower.includes('fiction')) {
    return 'reality';
  }

  if (lower.includes('رجل') || lower.includes('امرأة') || lower.includes('male') || lower.includes('female')) {
    return 'gender';
  }

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

  if (
    lower.includes('حي') ||
    lower.includes('متوفى') ||
    lower.includes('alive') ||
    lower.includes('dead') ||
    lower.includes('deceased')
  ) {
    return 'alive';
  }

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
  const currentTurns = session.turns || [];
  return currentTurns.some((t) => questionConceptKey(t.question) === key);
}

function nextFollowupQuestion(session) {
  const language = session.language;
  const state = inferState(session.turns);

  const pool = language === 'ar'
    ? [
        { text: 'هل هو عربي؟', when: state.arab == null && state.foreign == null },
        { text: 'هل هو أجنبي؟', when: state.arab == null && state.foreign == null },

        { text: 'هل هو حي؟', when: state.alive == null && state.dead == null },
        { text: 'هل هو متوفى؟', when: state.alive == null && state.dead == null },

        { text: 'هل هو رياضي؟', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'هل هو فنان؟', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'هل هو سياسي؟', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'هل هو عالم؟', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },

        { text: 'هل هو ممثل؟', when: state.artist === true && state.actor == null && state.singer == null },
        { text: 'هل هو مغني؟', when: state.artist === true && state.actor == null && state.singer == null },

        { text: 'هل هو لاعب كرة؟', when: state.athlete === true && state.footballer == null },

        { text: 'هل هو حي؟', when: true }
      ]
    : [
        { text: 'Is it Arab?', when: state.arab == null && state.foreign == null },
        { text: 'Is it foreign?', when: state.arab == null && state.foreign == null },

        { text: 'Is it alive?', when: state.alive == null && state.dead == null },
        { text: 'Is it dead?', when: state.alive == null && state.dead == null },

        { text: 'Is it an athlete?', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'Is it an artist?', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'Is it a politician?', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'Is it a scientist?', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },

        { text: 'Is it an actor?', when: state.artist === true && state.actor == null && state.singer == null },
        { text: 'Is it a singer?', when: state.artist === true && state.actor == null && state.singer == null },

        { text: 'Is it a footballer?', when: state.athlete === true && state.footballer == null },

        { text: 'Is it alive?', when: true }
      ];

  for (const item of pool) {
    if (!item.when) continue;
    if (repeatedConcept(item.text, session)) continue;
    if (contradictsState(item.text, session)) continue;
    return item.text;
  }

  return language === 'ar' ? 'هل هو حي؟' : 'Is it alive?';
}

function shortFallbackQuestion(language = 'ar', session = null) {
  if (session?.followupMode) {
    return nextFollowupQuestion(session);
  }

  const state = session ? inferState(session.turns) : {};

  const pool = language === 'ar'
    ? [
        { text: 'هل هي حقيقية؟', when: state.real == null && state.fictional == null },
        { text: 'هل هي خيالية؟', when: state.real == null && state.fictional == null },

        { text: 'هل هو رجل؟', when: state.male == null && state.female == null },
        { text: 'هل هي امرأة؟', when: state.male == null && state.female == null },

        { text: 'هل هو رياضي؟', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'هل هو فنان؟', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'هل هو سياسي؟', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },

        { text: 'هل هو عربي؟', when: state.arab == null && state.foreign == null },
        { text: 'هل هو أجنبي؟', when: state.arab == null && state.foreign == null },

        { text: 'هل هو حي؟', when: state.alive == null && state.dead == null },
        { text: 'هل هو متوفى؟', when: state.alive == null && state.dead == null },

        { text: 'هل هو ممثل؟', when: state.artist === true && state.actor == null && state.singer == null },
        { text: 'هل هو مغني؟', when: state.artist === true && state.actor == null && state.singer == null },

        { text: 'هل هو لاعب كرة؟', when: state.athlete === true && state.footballer == null },

        { text: 'هل هو عالم؟', when: true }
      ]
    : [
        { text: 'Is it real?', when: state.real == null && state.fictional == null },
        { text: 'Is it fictional?', when: state.real == null && state.fictional == null },

        { text: 'Is it male?', when: state.male == null && state.female == null },
        { text: 'Is it female?', when: state.male == null && state.female == null },

        { text: 'Is it an athlete?', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'Is it an artist?', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },
        { text: 'Is it a politician?', when: state.artist == null && state.athlete == null && state.politician == null && state.scientist == null },

        { text: 'Is it Arab?', when: state.arab == null && state.foreign == null },
        { text: 'Is it foreign?', when: state.arab == null && state.foreign == null },

        { text: 'Is it alive?', when: state.alive == null && state.dead == null },
        { text: 'Is it dead?', when: state.alive == null && state.dead == null },

        { text: 'Is it an actor?', when: state.artist === true && state.actor == null && state.singer == null },
        { text: 'Is it a singer?', when: state.artist === true && state.actor == null && state.singer == null },

        { text: 'Is it a footballer?', when: state.athlete === true && state.footballer == null },

        { text: 'Is it a scientist?', when: true }
      ];

  for (const item of pool) {
    if (!item.when) continue;
    if (session && repeatedConcept(item.text, session)) continue;
    if (session && contradictsState(item.text, session)) continue;
    return item.text;
  }

  return language === 'ar' ? 'هل هو حي؟' : 'Is it alive?';
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

    if (repeatedConcept(text, session)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, session)
      };
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
- Keep questions short and powerful
- If followupMode is true, ask NEW follow-up questions only. Do not reuse earlier concepts.`
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
      maxQuestionsBeforeGuess: INITIAL_MAX_QUESTIONS,
      followupMode: false
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

    const cleanQuestion = String(question || '').trim().replace(/\s+/g, ' ');

    session.turns.push({
      question: cleanQuestion,
      answer: normalizeAnswer(answer)
    });

    if (session.turns.length >= 2) {
      const last = session.turns[session.turns.length - 1].question;
      const prev = session.turns[session.turns.length - 2].question;

      if (last === prev) {
        session.turns.pop();
      }
    }

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
      session.followupMode = false;

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

    if (session.guessStreak < MAX_CONSECUTIVE_GUESSES) {
      const result = await forceSingleGuess(session);
      return res.json(result);
    }

    session.guessStreak = 0;
    session.questionsSincePhaseReset = 0;
    session.minQuestionsBeforeGuess = FOLLOWUP_MIN_QUESTIONS;
    session.maxQuestionsBeforeGuess = FOLLOWUP_MAX_QUESTIONS;
    session.followupMode = true;

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