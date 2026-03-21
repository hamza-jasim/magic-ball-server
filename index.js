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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const sessions = new Map();

function makeSystemPrompt(language = 'ar') {
  return `You are a smart guessing engine.

GOAL:
Guess the character in 7–10 questions.

RULES:
- Ask ONE short yes/no question.
- Do NOT repeat questions.
- Do NOT contradict previous answers.
- Stay in same logical direction.

ORDER:
1. Real or fictional
2. Gender
3. Profession
4. Nationality
5. Alive or dead
6. Narrow more

GUESS:
- Only after 7 questions
- Max 3 guesses
- After 3 wrong → return to questions

LANGUAGE:
- Arabic if ar
- English if en

OUTPUT JSON:

{"type":"question","text":"..."}
or
{"type":"guess","name":"...","confidence":0.85}`;
}

function sessionMessages(session) {
  return session.turns
    .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`)
    .join('\n');
}

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

function getFallbackQuestion(language, step) {
  const ar = [
    'هل هذه شخصية حقيقية؟',
    'هل هو رجل؟',
    'هل هو فنان؟',
    'هل هو عربي؟',
    'هل هو حي؟',
    'هل هو ممثل؟',
    'هل هو مغني؟',
    'هل هو رياضي؟'
  ];

  const en = [
    'Is this person real?',
    'Is this person male?',
    'Is this person an artist?',
    'Is this person Arab?',
    'Is this person alive?',
    'Is this person an actor?',
    'Is this person a singer?',
    'Is this person an athlete?'
  ];

  const list = language === 'ar' ? ar : en;
  return list[step % list.length];
}

function isDuplicate(q, session) {
  return session.turns.some(t => t.question.trim() === q.trim());
}

async function askEngine(session) {
  const response = await openai.chat.completions.create({
    model,
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      {
        role: 'user',
        content: `Game state:\n${sessionMessages(session)}`
      }
    ]
  });

  let parsed;
  try {
    parsed = JSON.parse(response.choices[0].message.content);
  } catch {
    return {
      type: 'question',
      text: getFallbackQuestion(session.language, session.turns.length)
    };
  }

  // منع تكرار السؤال
  if (parsed.type === 'question') {
    if (!parsed.text || isDuplicate(parsed.text, session)) {
      return {
        type: 'question',
        text: getFallbackQuestion(session.language, session.turns.length)
      };
    }
  }

  // منع إعادة نفس التخمين
  if (
    parsed.type === 'guess' &&
    session.rejectedGuesses.includes(parsed.name)
  ) {
    return {
      type: 'question',
      text: getFallbackQuestion(session.language, session.turns.length)
    };
  }

  return parsed;
}

async function fetchWikipediaSummary(name, language = 'ar') {
  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.replace(/ /g, '_'));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;

  const res = await fetch(url);

  if (!res.ok) {
    return {
      title: name,
      extract: 'No info',
      imageURL: null,
      articleURL: `https://${lang}.wikipedia.org/wiki/${title}`
    };
  }

  const json = await res.json();

  return {
    title: json.title,
    extract: json.extract,
    imageURL: json.thumbnail?.source || null,
    articleURL: json.content_urls?.desktop?.page
  };
}

app.post('/api/game/start', async (req, res) => {
  const language = req.body?.language === 'en' ? 'en' : 'ar';
  const sessionId = crypto.randomUUID();

  const session = {
    id: sessionId,
    language,
    turns: [],
    rejectedGuesses: [],
    guessStreak: 0
  };

  sessions.set(sessionId, session);

  const result = await askEngine(session);

  res.json({ sessionId, ...result });
});

app.post('/api/game/answer', async (req, res) => {
  const { sessionId, question, answer } = req.body;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.turns.push({
    question,
    answer: normalizeAnswer(answer)
  });

  session.guessStreak = 0;

  const result = await askEngine(session);

  res.json(result);
});

app.post('/api/game/guess-confirm', async (req, res) => {
  const { sessionId, guessName, correct } = req.body;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (correct) {
    const wiki = await fetchWikipediaSummary(guessName, session.language);

    return res.json({
      type: 'revealed',
      guessName,
      wiki
    });
  }

  session.rejectedGuesses.push(guessName);
  session.guessStreak++;

  // يسمح فقط 3 تخمينات
  if (session.guessStreak >= 3) {
    session.guessStreak = 0;
    return res.json(await askEngine(session));
  }

  return res.json(await askEngine(session));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
