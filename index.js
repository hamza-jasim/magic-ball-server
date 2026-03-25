"use strict";

const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");
const OpenAI = require("openai");

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI
// ─────────────────────────────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey:
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "",
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 60 * 60 * 1000;
const INITIAL_MIN_QUESTIONS = 8;
const INITIAL_MAX_QUESTIONS = 13;
const FOLLOWUP_MIN_QUESTIONS = 5;
const FOLLOWUP_MAX_QUESTIONS = 8;
const MAX_CONSECUTIVE_GUESSES = 3;

const VALID_ANSWERS = new Set(["yes", "no", "maybe", "dont_know"]);

const WIKI_HEADERS = {
  "User-Agent": "MagicBallApp/1.0 (educational project)",
  Accept: "application/json",
};

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────
const sessions = new Map();

function createSession(language = "ar") {
  const id = randomUUID();
  const session = {
    id,
    language: language === "en" ? "en" : "ar",
    messages: [],
    questionCount: 0,
    minQuestionsBeforeGuess: INITIAL_MIN_QUESTIONS,
    maxQuestionsBeforeGuess: INITIAL_MAX_QUESTIONS,
    guessStreak: 0,
    rejectedGuesses: [],
    lastGuessName: "",
    lastQuestion: "",
    lastDomainHint: "",
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(String(id || ""));
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(String(id));
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function deleteSession(id) {
  sessions.delete(String(id || ""));
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now > session.expiresAt) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT_AR = `أنت "الكرة السحرية" — ذكاء اصطناعي متخصص في تخمين الشخصيات مثل لعبة أكيناتور.

مهمتك:
- اسأل سؤالاً واحداً فقط في كل مرة.
- السؤال يجب أن يكون قصيراً وواضحاً ويمكن الإجابة عليه بـ:
نعم / لا / ربما / لا أعرف

قواعد صارمة:
- ردك يجب أن يكون إما:
1) سؤال واحد فقط
أو
2) تخمين واحد فقط بهذا الشكل:
تخميني: [اسم الشخصية كاملاً]

- لا تكتب أي شرح إضافي.
- لا تكتب أكثر من سؤال.
- لا تكتب مقدمات أو تعليقات.
- لا تكرر نفس السؤال.
- لا تعيد نفس الفكرة بصياغة مختلفة.
- لا تسأل سؤالين في نفس السطر.
- لا تذكر اسم أي شخصية أثناء مرحلة الأسئلة.
- لا تسأل أسئلة غبية أو عامة جداً.
- إذا تأكدت من المجال، ابقَ على نفس المسار ولا تغيّر المجال.
- إذا عرفت أن الشخصية رياضي، واصل فقط في الرياضة.
- إذا عرفت أن الشخصية فنان، واصل فقط في الفن.
- إذا عرفت أن الشخصية سياسي، واصل فقط في السياسة.
- إذا عرفت أن الشخصية خيالية، واصل فقط في الشخصيات الخيالية.

أسلوب الأسئلة:
- ابدأ واسعاً ثم ضيّق:
حقيقي؟ ذكر؟ رياضي؟ فنان؟ سياسي؟ من دولة معيّنة؟ حي؟ حصل على جائزة؟ معروف في مجال محدد؟
- بعد 8 إلى 13 سؤال، إذا أصبحت واثقاً، اخمن.
- إذا طُلب منك المتابعة بعد تخمين خاطئ، لا تبدأ من الصفر. أكمل من نفس المسار واطرح أسئلة أضيق.

مهم جداً:
- يجب أن يكون كل الرد بالعربية فقط.
- إذا خمنت، اكتب فقط:
تخميني: [الاسم]
بدون أي شيء آخر.`;

const SYSTEM_PROMPT_EN = `You are "The Magic Ball" — an AI specialized in guessing characters like Akinator.

Your task:
- Ask exactly ONE question at a time.
- The question must be short, clear, and answerable with:
yes / no / maybe / dont_know

Strict rules:
- Your response must be either:
1) exactly one question
or
2) exactly one guess in this format:
My guess: [full name]

- Do not write explanations.
- Do not write introductions.
- Do not write extra comments.
- Do not ask more than one question.
- Do not repeat questions.
- Do not repeat the same concept in different wording.
- Do not mention any character name during question mode.
- Do not ask weak or random questions.
- Once a domain is identified, stay on ONE logical path.
- If the character is an athlete, keep asking sports-related questions only.
- If the character is an entertainer, stay in entertainment only.
- If the character is a politician, stay in politics only.
- If the character is fictional, stay in fictional-character logic only.

Question strategy:
- Start broad, then narrow:
real? male? athlete? entertainer? politician? alive? country? awards? role? era?
- After around 8 to 13 questions, if you are confident, guess.
- If asked to continue after a wrong guess, do not restart from zero. Continue on the same path and ask narrower follow-up questions.

Very important:
- If you guess, write only:
My guess: [name]
with nothing else.`;

const FALLBACK_QUESTIONS_AR = [
  "هل الشخصية التي تفكر بها حقيقية؟",
  "هل هذه الشخصية ذكر؟",
  "هل هذه الشخصية رياضي؟",
  "هل هذه الشخصية فنان؟",
  "هل هذه الشخصية سياسية؟",
  "هل هذه الشخصية لا تزال حية؟",
  "هل هذه الشخصية من الوطن العربي؟",
  "هل هذه الشخصية مشهورة عالمياً؟",
];

const FALLBACK_QUESTIONS_EN = [
  "Is the person you're thinking of real?",
  "Is this person male?",
  "Is this person an athlete?",
  "Is this person an entertainer?",
  "Is this person a politician?",
  "Is this person still alive?",
  "Is this person from the Arab world?",
  "Is this person internationally famous?",
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizeAnswer(answer) {
  const value = String(answer || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (value === "yes") return "yes";
  if (value === "no") return "no";
  if (value === "maybe") return "maybe";
  if (value === "dont_know" || value === "dontknow") return "dont_know";
  return "dont_know";
}

function getSystemPrompt(lang) {
  return lang === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_AR;
}

function getFallbackQuestion(questionCount, lang) {
  const list = lang === "en" ? FALLBACK_QUESTIONS_EN : FALLBACK_QUESTIONS_AR;
  return list[questionCount % list.length];
}

function parseGuess(content, lang) {
  const marker = lang === "en" ? "My guess:" : "تخميني:";
  const idx = String(content || "").indexOf(marker);
  if (idx === -1) return { isGuess: false, guessName: null };

  const raw = String(content || "")
    .slice(idx + marker.length)
    .split("\n")[0]
    .replace(/[،,.!؟?\[\]]/g, "")
    .trim();

  return {
    isGuess: Boolean(raw),
    guessName: raw || null,
  };
}

function buildForceGuessPrompt(lang) {
  return lang === "en"
    ? "Now make your best final guess. Write exactly: My guess: [full name]"
    : "الآن قدّم أفضل تخمين نهائي لديك. اكتب بالضبط: تخميني: [اسم الشخصية كاملاً]";
}

function buildFollowupPrompt(session) {
  if (session.language === "en") {
    return [
      "Previous guess was wrong.",
      `Rejected guesses: ${session.rejectedGuesses.join(", ") || "none"}.`,
      "Continue from the same logical path.",
      "Do not restart from zero.",
      "Ask a new, narrower follow-up question.",
      "Do not repeat earlier questions.",
      session.lastDomainHint ? `Stay in this domain: ${session.lastDomainHint}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    "التخمين السابق كان خاطئاً.",
    `التخمينات المرفوضة: ${session.rejectedGuesses.join("، ") || "لا يوجد"}.`,
    "أكمل من نفس المسار المنطقي.",
    "لا تبدأ من الصفر.",
    "اسأل سؤال متابعة جديداً وأضيق.",
    "لا تكرر الأسئلة السابقة.",
    session.lastDomainHint ? `ابقَ في هذا المجال: ${session.lastDomainHint}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function inferDomainHintFromMessages(messages, lang) {
  const joined = messages.map((m) => m.content).join(" ").toLowerCase();

  const domains =
    lang === "en"
      ? [
          ["athlete", ["athlete", "football", "soccer", "basketball", "tennis", "boxing", "swimmer"]],
          ["entertainer", ["actor", "singer", "director", "comedian", "movie", "music"]],
          ["politician", ["politician", "president", "king", "prime minister"]],
          ["scientist", ["scientist", "inventor", "physics", "medicine"]],
          ["fictional", ["fictional", "cartoon", "anime", "superhero", "villain"]],
        ]
      : [
          ["رياضي", ["رياضي", "كرة", "قدم", "سلة", "تنس", "ملاكم", "سباح"]],
          ["فنان", ["ممثل", "مغني", "مخرج", "كوميدي", "فنان", "مسلسل", "فيلم"]],
          ["سياسي", ["سياسي", "رئيس", "ملك", "وزير"]],
          ["عالم", ["عالم", "مخترع", "فيزياء", "طب"]],
          ["خيالي", ["خيالية", "كرتونية", "أنمي", "بطل خارق", "شرير"]],
        ];

  for (const [label, words] of domains) {
    if (words.some((w) => joined.includes(w))) {
      return label;
    }
  }

  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Question / Guess
// ─────────────────────────────────────────────────────────────────────────────
async function getAIResponse(messages, lang, attempt = 0) {
  const systemPrompt = getSystemPrompt(lang);
  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: chatMessages,
      max_completion_tokens: 200,
      temperature: 0.7,
    });

    const content = response.choices?.[0]?.message?.content?.trim() || "";

    if (!content && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400));
      return getAIResponse(messages, lang, attempt + 1);
    }

    if (!content) {
      return getFallbackQuestion(messages.length, lang);
    }

    return content;
  } catch (error) {
    console.error("OpenAI API error:", error?.message || error);
    return getFallbackQuestion(messages.length, lang);
  }
}

async function getQuestionOrGuess(session) {
  const content = await getAIResponse(session.messages, session.language);
  let { isGuess, guessName } = parseGuess(content, session.language);

  // إجبار التخمين إذا طال
  if (!isGuess && session.questionCount >= session.maxQuestionsBeforeGuess) {
    const forced = await getAIResponse(
      [...session.messages, { role: "user", content: buildForceGuessPrompt(session.language) }],
      session.language
    );

    const forcedParsed = parseGuess(forced, session.language);
    if (forcedParsed.isGuess) {
      isGuess = true;
      guessName = forcedParsed.guessName;
      return {
        type: "guess",
        content: forced,
        guessName,
      };
    }
  }

  if (isGuess && guessName) {
    return {
      type: "guess",
      content,
      guessName,
    };
  }

  return {
    type: "question",
    content,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wikipedia
// ─────────────────────────────────────────────────────────────────────────────
const EMPTY_WIKI = {
  title: "",
  extract: "",
  imageURL: "",
  articleURL: "",
};

async function fetchWikiSummaryByTitle(title, lang = "en") {
  try {
    const encoded = encodeURIComponent(String(title || "").replace(/ /g, "_"));
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encoded}`;

    const resp = await fetch(url, {
      headers: WIKI_HEADERS,
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return null;

    const data = await resp.json();

    if (data.type === "disambiguation") return null;
    if (!data.extract && !data.thumbnail?.source && !data.originalimage?.source) return null;

    return {
      title: data.title || title,
      extract: data.extract || "",
      imageURL: data.thumbnail?.source || data.originalimage?.source || "",
      articleURL: data.content_urls?.desktop?.page || "",
    };
  } catch {
    return null;
  }
}

async function searchWikiTitle(query, lang = "en") {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query
    )}&srlimit=1&format=json&origin=*`;

    const resp = await fetch(url, {
      headers: WIKI_HEADERS,
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    return data?.query?.search?.[0]?.title || null;
  } catch {
    return null;
  }
}

async function fetchWikipediaData(name, lang = "ar") {
  const preferredLang = lang === "en" ? "en" : "ar";
  const langs = preferredLang === "ar" ? ["ar", "en"] : ["en", "ar"];

  for (const l of langs) {
    let summary = await fetchWikiSummaryByTitle(name, l);
    if (summary) return summary;

    const foundTitle = await searchWikiTitle(name, l);
    if (foundTitle) {
      summary = await fetchWikiSummaryByTitle(foundTitle, l);
      if (summary) return summary;
    }
  }

  return {
    ...EMPTY_WIKI,
    title: name,
    extract: preferredLang === "ar" ? "لا توجد معلومات متاحة" : "No information available",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Response builders
// ─────────────────────────────────────────────────────────────────────────────
async function buildGuessResponse(session, guessName, confidence = 0.8) {
  const wiki = await fetchWikipediaData(guessName, session.language);
  const finalName = wiki.title || guessName;

  session.lastGuessName = finalName;

  const text =
    session.language === "en"
      ? `Is the character you're thinking of ${finalName}?`
      : `هل الشخصية التي تفكر بها هي ${finalName}؟`;

  return {
    type: "guess",
    name: finalName,
    guessName: finalName,
    text,
    confidence,
    wiki,
  };
}

function buildQuestionResponse(session, content) {
  session.lastQuestion = content;
  return {
    type: "question",
    text: content,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    hasOpenAI: Boolean(
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY
    ),
  });
});

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Start game
app.post("/api/game/start", async (req, res) => {
  try {
    const language = req.body?.language === "en" ? "en" : "ar";
    const session = createSession(language);

    const result = await getQuestionOrGuess(session);

    if (result.type === "guess" && result.guessName) {
      const payload = await buildGuessResponse(session, result.guessName, 0.8);
      return res.json({ sessionId: session.id, ...payload });
    }

    session.messages.push({ role: "assistant", content: result.content });
    return res.json({
      sessionId: session.id,
      ...buildQuestionResponse(session, result.content),
    });
  } catch (error) {
    console.error("start error:", error);
    return res.status(500).json({ error: "Failed to start game" });
  }
});

// Answer question
app.post("/api/game/answer", async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body || {};

    if (!sessionId || !answer) {
      return res.status(400).json({ error: "sessionId and answer are required" });
    }

    const normalizedAnswer = normalizeAnswer(answer);
    if (!VALID_ANSWERS.has(normalizedAnswer)) {
      return res.status(400).json({ error: "Invalid answer" });
    }

    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const safeQuestion = String(question || session.lastQuestion || "").trim();
    if (safeQuestion) {
      session.messages.push({ role: "assistant", content: safeQuestion });
    }

    const userAnswerText =
      session.language === "en"
        ? `Answer: ${normalizedAnswer}`
        : `الإجابة: ${normalizedAnswer === "yes"
            ? "نعم"
            : normalizedAnswer === "no"
            ? "لا"
            : normalizedAnswer === "maybe"
            ? "ربما"
            : "لا أعرف"}`;

    session.messages.push({ role: "user", content: userAnswerText });
    session.questionCount += 1;
    session.lastDomainHint =
      session.lastDomainHint || inferDomainHintFromMessages(session.messages, session.language);

    const result = await getQuestionOrGuess(session);

    if (result.type === "guess" && result.guessName) {
      const payload = await buildGuessResponse(
        session,
        result.guessName,
        session.questionCount >= session.maxQuestionsBeforeGuess ? 0.9 : 0.8
      );
      return res.json(payload);
    }

    session.messages.push({ role: "assistant", content: result.content });
    return res.json(buildQuestionResponse(session, result.content));
  } catch (error) {
    console.error("answer error:", error);
    return res.status(500).json({ error: "Failed to process answer" });
  }
});

// Confirm guess (iOS path)
app.post("/api/game/guess-confirm", async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body || {};

    if (!sessionId || typeof correct !== "boolean") {
      return res.status(400).json({ error: "sessionId and correct are required" });
    }

    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const currentGuessName = String(guessName || session.lastGuessName || "").trim();

    if (correct) {
      const wiki = currentGuessName
        ? await fetchWikipediaData(currentGuessName, session.language)
        : { ...EMPTY_WIKI };

      const finalName = wiki.title || currentGuessName;
      deleteSession(sessionId);

      return res.json({
        type: "revealed",
        name: finalName,
        guessName: finalName,
        wiki,
      });
    }

    if (currentGuessName) {
      session.rejectedGuesses.push(currentGuessName);
    }

    session.guessStreak += 1;

    // أول 3 تخمينات خاطئة: تخمين آخر مباشرة
    if (session.guessStreak < MAX_CONSECUTIVE_GUESSES) {
      const guessPrompt =
        session.language === "en"
          ? `The previous guess "${currentGuessName}" was wrong. Give another better guess. Write exactly: My guess: [full name]`
          : `التخمين السابق "${currentGuessName}" كان خاطئاً. قدّم تخميناً أفضل. اكتب بالضبط: تخميني: [اسم الشخصية كاملاً]`;

      const content = await getAIResponse(
        [...session.messages, { role: "user", content: guessPrompt }],
        session.language
      );

      const parsed = parseGuess(content, session.language);
      if (parsed.isGuess && parsed.guessName && !session.rejectedGuesses.includes(parsed.guessName)) {
        const payload = await buildGuessResponse(session, parsed.guessName, 0.75);
        return res.json(payload);
      }
    }

    // بعد 3 تخمينات خاطئة: رجوع للأسئلة
    session.guessStreak = 0;
    session.questionCount = 0;
    session.minQuestionsBeforeGuess = FOLLOWUP_MIN_QUESTIONS;
    session.maxQuestionsBeforeGuess = FOLLOWUP_MAX_QUESTIONS;

    const followup = buildFollowupPrompt(session);
    const content = await getAIResponse(
      [...session.messages, { role: "user", content: followup }],
      session.language
    );

    const parsed = parseGuess(content, session.language);
    if (parsed.isGuess && parsed.guessName) {
      const payload = await buildGuessResponse(session, parsed.guessName, 0.7);
      return res.json(payload);
    }

    session.messages.push({ role: "assistant", content });
    return res.json(buildQuestionResponse(session, content));
  } catch (error) {
    console.error("guess-confirm error:", error);
    return res.status(500).json({ error: "Failed to confirm guess" });
  }
});

// Compatibility path for older server
app.post("/api/game/guess-result", async (req, res) => {
  try {
    const { sessionId, name, correct } = req.body || {};
    req.body = {
      sessionId,
      guessName: name,
      correct: Boolean(correct),
    };
    return app._router.handle(req, res, () => {});
  } catch (error) {
    console.error("guess-result error:", error);
    return res.status(500).json({ error: "Failed to process guess result" });
  }
});

// Wiki endpoint
app.get("/api/wiki", async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    const lang = req.query.language === "en" || req.query.lang === "en" ? "en" : "ar";

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const wiki = await fetchWikipediaData(name, lang);
    return res.json(wiki);
  } catch (error) {
    console.error("wiki error:", error);
    return res.status(500).json({ error: "Failed to fetch wiki" });
  }
});

// Manual reveal compatibility
app.post("/api/game/reveal", async (req, res) => {
  try {
    const { sessionId, name } = req.body || {};
    if (!sessionId || !name) {
      return res.status(400).json({ error: "sessionId and name are required" });
    }

    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const wiki = await fetchWikipediaData(String(name), session.language);
    const finalName = wiki.title || String(name);
    deleteSession(sessionId);

    return res.json({
      type: "revealed",
      name: finalName,
      guessName: finalName,
      wiki,
    });
  } catch (error) {
    console.error("reveal error:", error);
    return res.status(500).json({ error: "Failed to reveal character" });
  }
});

// Delete session
app.delete("/api/game/session/:sessionId", (req, res) => {
  deleteSession(req.params.sessionId);
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
const port = Number(process.env.PORT || 3000);

app.listen(port, "0.0.0.0", () => {
  console.log(`Magic Ball server listening on port ${port}`);
  console.log(`Model: ${MODEL}`);
});
