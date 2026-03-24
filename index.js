import express from "express";
import { createServer } from "http";
import OpenAI from "openai";

const app = express();
const httpServer = createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ============================================================
// OpenAI Setup
// ضع مفتاحك في متغير البيئة OPENAI_API_KEY
// ============================================================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "your-openai-api-key-here",
});

// ============================================================
// System Prompts
// ============================================================
const SYSTEM_PROMPT_AR = `أنت "الكرة السحرية" - ذكاء اصطناعي متخصص في تخمين الشخصيات مثل لعبة أكيناتور.

مهمتك الوحيدة: اسأل سؤالاً واحداً بالعربية يمكن الإجابة عليه بـ نعم أو لا.

القواعد الصارمة:
- يجب أن يكون ردك دائماً سؤالاً واحداً فقط، لا أكثر
- السؤال يجب أن ينتهي بعلامة استفهام (؟)
- لا تكتب مقدمات أو تعليقات إضافية
- بعد 7-15 سؤال إذا أصبحت واثقاً جداً، اكتب: تخميني: [اسم الشخصية كاملاً]
- اسأل عن: هل هو/هي حقيقي؟ ذكر؟ رياضي؟ فنان؟ عالم؟ سياسي؟ من الوطن العربي؟ لا يزال حياً؟ مشهور عالمياً؟

ابدأ الآن بسؤالك:`;

const SYSTEM_PROMPT_EN = `You are "The Magic Ball" — an AI specialized in guessing famous people, like the Akinator game.

Your only task: ask ONE yes/no question in English that can be answered with Yes or No.

Strict rules:
- Your response must always be exactly one question, nothing more
- The question must end with a question mark (?)
- Do not write introductions or additional comments
- After 7-15 questions, if you are very confident, write: My guess: [Full name of the person]
- Ask about: Is the person real? Male? An athlete? An artist? A scientist? A politician? Still alive? etc.

Start now with your first question:`;

const FALLBACK_QUESTIONS_AR = [
  "هل الشخصية التي تفكر بها حقيقية وليست خيالية؟",
  "هل هذه الشخصية ذكر؟",
  "هل هذه الشخصية رياضي؟",
  "هل هذه الشخصية مشهورة على المستوى العالمي؟",
  "هل هذه الشخصية لا تزال حية؟",
  "هل هذه الشخصية من الوطن العربي؟",
  "هل هذه الشخصية فنان أو ممثل؟",
  "هل هذه الشخصية عالم أو مخترع؟",
];

const FALLBACK_QUESTIONS_EN = [
  "Is the person you're thinking of a real person, not fictional?",
  "Is this person male?",
  "Is this person an athlete?",
  "Is this person internationally famous?",
  "Is this person still alive?",
  "Is this person from the USA or Europe?",
  "Is this person an actor or entertainer?",
  "Is this person a scientist or inventor?",
];

// ============================================================
// AI Logic
// ============================================================
async function getAIResponse(messages, lang, attempt = 0) {
  const systemPrompt = lang === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_AR;
  const fallbacks = lang === "en" ? FALLBACK_QUESTIONS_EN : FALLBACK_QUESTIONS_AR;

  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: chatMessages,
      max_completion_tokens: 200,
      temperature: 0.8,
    });

    const content = response.choices[0]?.message?.content?.trim() || "";

    if (!content && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500));
      return getAIResponse(messages, lang, attempt + 1);
    }

    if (!content) {
      return fallbacks[Math.floor(messages.length / 2) % fallbacks.length];
    }

    return content;
  } catch (error) {
    console.error("OpenAI API error:", error);
    return fallbacks[Math.floor(messages.length / 2) % fallbacks.length];
  }
}

function parseGuess(content, lang) {
  const marker = lang === "en" ? "My guess:" : "تخميني:";
  const isGuess = content.includes(marker);
  if (!isGuess) return { isGuess: false, guessName: null };

  const afterColon = content.split(marker)[1]?.trim() || "";
  const guessName = afterColon.split("\n")[0].trim().replace(/[،,\.!؟?\[\]]/g, "").trim();
  return { isGuess: true, guessName: guessName || null };
}

// ============================================================
// Wikipedia Fetch
// ============================================================
const WIKI_HEADERS = {
  "User-Agent": "MagicBallApp/1.0 (educational project)",
  "Accept": "application/json",
};

async function fetchWikipediaInfo(name, lang) {
  let imageUrl = null;
  let enBio = null;
  let enTitle = null;
  let arBio = null;

  try {
    // English Wikipedia
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&srlimit=3&format=json`;
    const searchRes = await fetch(searchUrl, { headers: WIKI_HEADERS });
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const results = searchData?.query?.search;
      if (results && results.length > 0) {
        enTitle = results[0].title;
        const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(enTitle)}`;
        const summaryRes = await fetch(summaryUrl, { headers: WIKI_HEADERS });
        if (summaryRes.ok) {
          const summary = await summaryRes.json();
          imageUrl = summary.thumbnail?.source || summary.originalimage?.source || null;
          const extract = summary.extract || null;
          enBio = extract ? extract.split(/\.\s+/).slice(0, 2).join(". ").trim() + "." : null;
        }
      }
    }

    // Arabic Wikipedia
    const arSearchUrl = `https://ar.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&srlimit=3&format=json`;
    const arSearchRes = await fetch(arSearchUrl, { headers: WIKI_HEADERS });
    if (arSearchRes.ok) {
      const arData = await arSearchRes.json();
      const arResults = arData?.query?.search;
      if (arResults && arResults.length > 0) {
        const arTitle = arResults[0].title;
        const arSummaryUrl = `https://ar.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(arTitle)}`;
        const arSummaryRes = await fetch(arSummaryUrl, { headers: WIKI_HEADERS });
        if (arSummaryRes.ok) {
          const arSummary = await arSummaryRes.json();
          if (!imageUrl) imageUrl = arSummary.thumbnail?.source || null;
          const arExtract = arSummary.extract || null;
          arBio = arExtract ? arExtract.split(/\.\s+/).slice(0, 2).join(". ").trim() + "." : null;
        }
      }
    }
  } catch (error) {
    console.error("Wikipedia fetch error:", error);
  }

  const finalBio = lang === "en" ? (enBio || arBio) : (arBio || enBio);
  return { imageUrl, bio: finalBio, enTitle };
}

// ============================================================
// API Routes
// ============================================================

// POST /api/magic-ball/question
// Body: { messages: [{role, content}], lang: "ar" | "en" }
// Response: { content, isGuess, guessName }
app.post("/api/magic-ball/question", async (req, res) => {
  try {
    const { messages = [], lang = "ar" } = req.body;
    const content = await getAIResponse(messages, lang);
    const { isGuess, guessName } = parseGuess(content, lang);
    console.log(`AI: "${content}"`);
    res.json({ content, isGuess, guessName });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Failed to get response from AI" });
  }
});

// GET /api/person-info?name=...&lang=ar
// Response: { imageUrl, bio, enTitle }
app.get("/api/person-info", async (req, res) => {
  try {
    const { name, lang = "ar" } = req.query;
    if (!name) return res.status(400).json({ message: "Name is required" });
    const info = await fetchWikipediaInfo(name, lang);
    res.json(info);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Failed to fetch person info" });
  }
});

// ============================================================
// Start Server
// ============================================================
const PORT = parseInt(process.env.PORT || "3000", 10);
httpServer.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log(`✅ Magic Ball API running on port ${PORT}`);
  console.log(`📡 POST /api/magic-ball/question`);
  console.log(`📡 GET  /api/person-info?name=اسم&lang=ar`);
});