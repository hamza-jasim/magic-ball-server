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
  return `You are a highly intelligent character guessing engine.

GOAL:
Identify the character in 7 to 10 questions.

STRICT RULES:
- Ask ONLY one yes/no question.
- Questions must be SHORT.
- Arabic: 3-6 words.
- English: 3-8 words.
- Do NOT explain anything.

THINKING STRATEGY:
1. Build a clear decision tree.
2. Never change direction randomly.
3. Always use previous answers.
4. Each question must eliminate many possibilities.

ORDER:
1- Real or fictional
2- Gender
3- Profession group
4- Nationality
5- Alive or dead
6- Narrow deeper
7- Move to guess

CRITICAL:
- NEVER repeat a question.
- NEVER ask the same idea again.
- NEVER contradict previous answers.
- NEVER jump to a new category randomly.

GUESSING:
- Do NOT guess before question 7.
- MUST guess between 7 and 10.
- ONLY ONE guess.

IF WRONG:
- Return to questions.
- Ask at least 2 new questions.
- Do NOT guess immediately again.

LANGUAGE:
- Arabic ONLY if ar
- English ONLY if en

OUTPUT STRICT JSON:

Question:
{"type":"question","text":"..."}

Guess:
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

function isDuplicateQuestion(newQ, session) {
  return session.turns.some(t =>
    t.question.trim() === newQ.trim()
  );
}

function getFallbackQuestion(language, step) {
  const ar = [
    'هل هذه شخصية حقيقية؟',
    'هل هو رجل؟',
    'هل هو فنان؟',
    'هل هو عربي؟',
    'هل هو حي؟'
  ];

  const en = [
    'Is this person real?',
    'Is this person male?',
    'Is this person an artist?',
    'Is this person Arab?',
    'Is this person alive?'
  ];

  const list = language === 'ar' ? ar : en;
  return list[step % list.length];
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
        content: `Language: ${session.language}

Game state:
${sessionMessages(session)}

INSTRUCTIONS:
- Follow strict logic.
- Use previous answers.
- Stay in same direction.
- Do not repeat or contradict.

Generate next step.`
      }
    ]
  });

  let raw = response.choices[0]?.message?.content || '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      type: 'question',
      text: getFallbackQuestion(session.language, session.turns.length)
    };
  }

  // منع التكرار
  if (parsed.type === 'question') {
    if (!parsed.text || parsed.text.length < 3) {
      return {
        type: 'question',
        text: getFallbackQuestion(session.language, session.turns.length)
      };
    }

    if (isDuplicateQuestion(parsed.text, session)) {
      return {
        type: 'question',
        text: getFallbackQuestion(session.language, session.turns.length)
      };
    }
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
    rejectedGuesses: []
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

  const result = await askEngine(session);

  res.json(result);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
