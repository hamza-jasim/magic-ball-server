"use strict";

const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");
const OpenAI = require("openai");

// ─── OpenAI client ───────────────────────────────────────────────────────────

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
});

// ─── Questions ───────────────────────────────────────────────────────────────

const BROAD_QUESTIONS = [
  { key: "real_person",        text: "Is it a real person?" },
  { key: "alive",              text: "Is this person still alive?" },
  { key: "male",               text: "Is it male?" },
  { key: "fictional",          text: "Is it a fictional character?" },
  { key: "athlete",            text: "Is this person an athlete?" },
  { key: "entertainer",        text: "Is this person an entertainer (actor, singer, comedian)?" },
  { key: "politician",         text: "Is this person a politician or world leader?" },
  { key: "scientist_inventor", text: "Is this person a scientist, inventor, or academic?" },
  { key: "business",           text: "Is this person known for business or entrepreneurship?" },
  { key: "historical",         text: "Did this person live before the year 2000?" },
];

const ATHLETE_QUESTIONS = [
  { key: "team_sport",         text: "Does this athlete play a team sport?" },
  { key: "american",           text: "Is this athlete American?" },
  { key: "european",           text: "Is this athlete European?" },
  { key: "soccer",             text: "Is this athlete a soccer player?" },
  { key: "basketball",         text: "Is this athlete a basketball player?" },
  { key: "tennis",             text: "Is this athlete a tennis player?" },
  { key: "american_football",  text: "Is this athlete an American football player?" },
  { key: "boxing_mma",         text: "Does this athlete compete in boxing or MMA?" },
  { key: "swimming_athletics", text: "Does this athlete compete in swimming or athletics?" },
  { key: "golf",               text: "Is this athlete a golfer?" },
  { key: "baseball",           text: "Is this athlete a baseball player?" },
  { key: "nba_player",         text: "Has this athlete played in the NBA?" },
  { key: "nfl_player",         text: "Has this athlete played in the NFL?" },
  { key: "olympic_gold",       text: "Has this athlete won an Olympic gold medal?" },
  { key: "world_champion",     text: "Has this athlete been a world champion?" },
  { key: "retired",            text: "Is this athlete retired from professional sport?" },
  { key: "active_2020s",       text: "Was this athlete active in the 2020s?" },
  { key: "active_2010s",       text: "Was this athlete primarily active in the 2010s?" },
  { key: "active_2000s",       text: "Was this athlete primarily active in the 2000s?" },
  { key: "active_1990s",       text: "Was this athlete primarily active in the 1990s?" },
  { key: "known_goat",         text: "Is this athlete considered one of the greatest of all time?" },
  { key: "multiple_titles",    text: "Has this athlete won multiple championship titles?" },
  { key: "south_american",     text: "Is this athlete from South America?" },
  { key: "african",            text: "Is this athlete from Africa?" },
  { key: "asian",              text: "Is this athlete from Asia?" },
];

const ENTERTAINER_QUESTIONS = [
  { key: "actor",                  text: "Is this person primarily an actor?" },
  { key: "singer_musician",        text: "Is this person primarily a singer or musician?" },
  { key: "comedian",               text: "Is this person primarily a comedian?" },
  { key: "american_entertainer",   text: "Is this entertainer American?" },
  { key: "british_entertainer",    text: "Is this entertainer British?" },
  { key: "hollywood",              text: "Has this person appeared in Hollywood films?" },
  { key: "oscar_winner",           text: "Has this person won an Oscar?" },
  { key: "grammy_winner",          text: "Has this person won a Grammy?" },
  { key: "male_entertainer",       text: "Is this entertainer male?" },
  { key: "active_now",             text: "Is this person currently active in entertainment?" },
  { key: "music_pop",              text: "Is this person known for pop music?" },
  { key: "music_rap_hiphop",       text: "Is this person known for rap or hip-hop?" },
  { key: "music_rock",             text: "Is this person known for rock music?" },
  { key: "music_classical",        text: "Is this person known for classical or jazz music?" },
  { key: "tv_star",                text: "Is this person primarily known for TV?" },
  { key: "director",               text: "Is this person a film director?" },
  { key: "famous_role",            text: "Is this person known for one iconic role?" },
  { key: "entertainer_1990s",      text: "Was this person most famous in the 1990s?" },
  { key: "entertainer_2000s",      text: "Was this person most famous in the 2000s?" },
  { key: "entertainer_2010s",      text: "Was this person most famous in the 2010s?" },
  { key: "entertainer_2020s",      text: "Is this person primarily famous in the 2020s?" },
  { key: "many_awards",            text: "Has this person won many major entertainment awards?" },
  { key: "global_superstar",       text: "Is this person a global superstar known worldwide?" },
  { key: "latin_entertainer",      text: "Is this person from a Latin American country?" },
];

const POLITICIAN_QUESTIONS = [
  { key: "head_of_state",          text: "Has this person been a head of state or government?" },
  { key: "us_politician",          text: "Is this person an American politician?" },
  { key: "european_politician",    text: "Is this person a European politician?" },
  { key: "us_president",           text: "Has this person served as US President?" },
  { key: "current_leader",         text: "Is this person currently in political power?" },
  { key: "democratic_leader",      text: "Is this person associated with liberal or democratic politics?" },
  { key: "conservative_leader",    text: "Is this person associated with conservative politics?" },
  { key: "war_time_leader",        text: "Was this person a leader during a major war?" },
  { key: "politician_21st_century",text: "Is this person primarily known in the 21st century?" },
  { key: "politician_20th_century",text: "Was this person primarily active in the 20th century?" },
  { key: "former_leader",          text: "Is this person a former leader no longer in office?" },
  { key: "activist_leader",        text: "Is this person also known as a social activist?" },
];

const SCIENTIST_QUESTIONS = [
  { key: "physicist",         text: "Is this person a physicist?" },
  { key: "biologist",         text: "Is this person a biologist or medical scientist?" },
  { key: "mathematician",     text: "Is this person a mathematician?" },
  { key: "chemist",           text: "Is this person a chemist?" },
  { key: "tech_inventor",     text: "Is this person known for a major technological invention?" },
  { key: "nobel_prize",       text: "Has this person won a Nobel Prize?" },
  { key: "modern_scientist",  text: "Did this person live in the 20th or 21st century?" },
  { key: "historical_scientist", text: "Did this person live before 1900?" },
  { key: "astronaut_explorer",text: "Is this person an astronaut or explorer?" },
];

const BUSINESS_QUESTIONS = [
  { key: "tech_ceo",          text: "Is this person known for a major tech company?" },
  { key: "billionaire",       text: "Is this person a billionaire?" },
  { key: "founder",           text: "Did this person found their own company?" },
  { key: "american_business", text: "Is this person an American business figure?" },
  { key: "finance",           text: "Is this person known for finance or investing?" },
  { key: "modern_business",   text: "Is this person primarily known in the 21st century?" },
];

const FICTIONAL_QUESTIONS = [
  { key: "fiction_male",           text: "Is this character male?" },
  { key: "fiction_human",          text: "Is this character human?" },
  { key: "fiction_superhero",      text: "Is this character a superhero or has superpowers?" },
  { key: "fiction_movie",          text: "Is this character from a movie?" },
  { key: "fiction_tv",             text: "Is this character from a TV show?" },
  { key: "fiction_book",           text: "Is this character from a book or novel?" },
  { key: "fiction_videogame",      text: "Is this character from a video game?" },
  { key: "fiction_animated",       text: "Is this character animated or from a cartoon?" },
  { key: "fiction_villain",        text: "Is this character a villain?" },
  { key: "fiction_hero",           text: "Is this character the main hero of their story?" },
  { key: "fiction_marvel_dc",      text: "Is this character from Marvel or DC?" },
  { key: "fiction_disney",         text: "Is this character from Disney or Pixar?" },
  { key: "fiction_anime",          text: "Is this character from anime or manga?" },
  { key: "fiction_fantasy",        text: "Does this character exist in a fantasy world?" },
  { key: "fiction_scifi",          text: "Does this character exist in a sci-fi setting?" },
  { key: "fiction_famous_franchise",text: "Is this character part of a globally famous franchise?" },
  { key: "fiction_modern",         text: "Was this character created after the year 2000?" },
  { key: "fiction_classic",        text: "Was this character created before 1990?" },
  { key: "fiction_animal",         text: "Is this character an animal or non-human creature?" },
  { key: "fiction_robot_ai",       text: "Is this character a robot or artificial intelligence?" },
];

function getDomainQuestions(domain) {
  switch (domain) {
    case "athlete":     return ATHLETE_QUESTIONS;
    case "entertainer": return ENTERTAINER_QUESTIONS;
    case "politician":  return POLITICIAN_QUESTIONS;
    case "scientist":   return SCIENTIST_QUESTIONS;
    case "business":    return BUSINESS_QUESTIONS;
    case "fictional":   return FICTIONAL_QUESTIONS;
    default:            return [];
  }
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function createSession(id, language = "en") {
  const session = {
    id,
    language,
    turns: 0,
    askedKeys: new Set(),
    pendingKey: null,
    domain: "unknown",
    facts: {},
    rejectedGuesses: [],
    guessStreak: 0,
    questionsThisPhase: 0,
    minQ: 9,
    maxQ: 15,
    phase: "questions",
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) return undefined;
  if (Date.now() > session.expiresAt) {
    sessions.delete(id);
    return undefined;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function deleteSession(id) {
  sessions.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ─── Engine ───────────────────────────────────────────────────────────────────

function inferDomain(session) {
  const f = session.facts;
  if (f["fictional"]          === "yes") return "fictional";
  if (f["athlete"]            === "yes") return "athlete";
  if (f["entertainer"]        === "yes") return "entertainer";
  if (f["politician"]         === "yes") return "politician";
  if (f["scientist_inventor"] === "yes") return "scientist";
  if (f["business"]           === "yes") return "business";
  if (f["real_person"]        === "yes") return "historical_real";
  return "unknown";
}

function domainLocked(session) {
  const f = session.facts;
  return (
    f["fictional"]          === "yes" ||
    f["athlete"]            === "yes" ||
    f["entertainer"]        === "yes" ||
    f["politician"]         === "yes" ||
    f["scientist_inventor"] === "yes" ||
    f["business"]           === "yes"
  );
}

function isContradicted(key, session) {
  const f = session.facts;
  if (key === "soccer"         && f["basketball"] === "yes") return true;
  if (key === "basketball"     && f["soccer"]     === "yes") return true;
  if (key === "actor"          && f["singer_musician"] === "yes") return true;
  if (key === "singer_musician"&& f["actor"]      === "yes") return true;
  if (key === "american"       && f["european"]   === "yes") return true;
  if (key === "european"       && f["american"]   === "yes") return true;
  return false;
}

function getNextBroadQuestion(session) {
  for (const q of BROAD_QUESTIONS) {
    if (!session.askedKeys.has(q.key)) return q;
  }
  return null;
}

function getNextDomainQuestion(session, domain) {
  for (const q of getDomainQuestions(domain)) {
    if (!session.askedKeys.has(q.key) && !isContradicted(q.key, session)) {
      return q;
    }
  }
  return null;
}

function pickNextQuestion(session) {
  if (session.domain !== "unknown" && domainLocked(session)) {
    const dq = getNextDomainQuestion(session, session.domain);
    if (dq) return dq;
  }
  if (session.domain === "unknown") {
    const bq = getNextBroadQuestion(session);
    if (bq) return bq;
  }
  if (session.domain !== "unknown") {
    const dq = getNextDomainQuestion(session, session.domain);
    if (dq) return dq;
  }
  return getNextBroadQuestion(session);
}

function applyAnswer(session, key, answer) {
  session.facts[key] = answer;
  session.askedKeys.add(key);
  session.pendingKey = null;
  session.turns++;
  session.questionsThisPhase++;
  if (session.domain === "unknown" && domainLocked(session)) {
    session.domain = inferDomain(session);
  }
}

function shouldGuessNow(session) {
  if (session.phase !== "questions") return false;
  if (session.questionsThisPhase < session.minQ) return false;
  if (session.questionsThisPhase >= session.maxQ) return true;
  const knownYes = Object.values(session.facts).filter(v => v === "yes").length;
  const knownNo  = Object.values(session.facts).filter(v => v === "no").length;
  const confidence = knownYes + knownNo * 0.5;
  return confidence >= 8 && session.domain !== "unknown";
}

function handleWrongGuess(session, guessName) {
  session.rejectedGuesses.push(guessName);
  session.guessStreak++;
  if (session.guessStreak >= 3) {
    session.phase = "questions";
    session.guessStreak = 0;
    session.questionsThisPhase = 0;
    session.minQ = 5;
    session.maxQ = 8;
  } else {
    session.phase = "guessing";
  }
}

// ─── Wikipedia ────────────────────────────────────────────────────────────────

const EMPTY_WIKI = { title: "", extract: "", imageURL: "", articleURL: "" };

async function fetchWikiSummary(title, lang = "en") {
  try {
    const encoded = encodeURIComponent(title.replace(/ /g, "_"));
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "MagicBallGame/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.type === "disambiguation") return null;
    const extract = data.extract ?? "";
    if (!extract) return null;
    return {
      title:      data.title ?? title,
      extract,
      imageURL:   data.thumbnail?.source ?? "",
      articleURL: data.content_urls?.desktop?.page ?? "",
    };
  } catch {
    return null;
  }
}

async function searchWikiTitle(query, lang = "en") {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&srlimit=1&format=json&origin=*`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "MagicBallGame/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.query?.search?.[0]?.title ?? null;
  } catch {
    return null;
  }
}

async function fetchWikipediaData(name, lang = "en") {
  const langs = lang !== "en" ? [lang, "en"] : ["en"];
  for (const l of langs) {
    let result = await fetchWikiSummary(name, l);
    if (result) return result;
    const found = await searchWikiTitle(name, l);
    if (found && found.toLowerCase() !== name.toLowerCase()) {
      result = await fetchWikiSummary(found, l);
      if (result) return result;
    }
  }
  return { ...EMPTY_WIKI, title: name };
}

// ─── Guesser ─────────────────────────────────────────────────────────────────

function buildFactSummary(facts) {
  return Object.entries(facts)
    .filter(([, v]) => v === "yes" || v === "no" || v === "maybe")
    .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`)
    .join("\n");
}

async function guessCharacter(session) {
  const rejectedList = session.rejectedGuesses.length > 0
    ? `\nThese guesses were already wrong: ${session.rejectedGuesses.join(", ")}`
    : "";

  const prompt =
    `You are playing a character guessing game. Based on the following facts, guess who the character is.\n` +
    `Return ONLY the character's full name. No explanation. No punctuation. Just the name.\n\n` +
    `Domain: ${session.domain}\n` +
    `Known facts:\n${buildFactSummary(session.facts)}${rejectedList}\n\nWho is it?`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 50,
      messages: [{ role: "user", content: prompt }],
    });
    return resp.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.error("OpenAI guess failed:", err.message);
    return "";
  }
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VALID_ANSWERS = new Set(["yes", "no", "maybe", "dont_know"]);

// Health check
app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// POST /api/game/start
app.post("/api/game/start", (_req, res) => {
  const id = randomUUID();
  const session = createSession(id);
  const question = pickNextQuestion(session);
  if (!question) {
    res.status(500).json({ error: "Could not generate a question" });
    return;
  }
  session.pendingKey = question.key;
  res.json({ sessionId: id, type: "question", text: question.text });
});

// POST /api/game/answer
app.post("/api/game/answer", async (req, res) => {
  const { sessionId, answer } = req.body;

  if (!sessionId || !answer) {
    res.status(400).json({ error: "sessionId and answer are required" });
    return;
  }
  if (!VALID_ANSWERS.has(answer)) {
    res.status(400).json({ error: "answer must be one of: yes, no, maybe, dont_know" });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  if (!session.pendingKey) {
    res.status(400).json({ error: "No pending question to answer" });
    return;
  }

  applyAnswer(session, session.pendingKey, answer);

  // Helper to send a guess response
  async function sendGuess(confidence) {
    session.phase = "guessing";
    const name = await guessCharacter(session);
    if (!name) {
      // Fall through to next question
      const q = pickNextQuestion(session);
      if (q) {
        session.pendingKey = q.key;
        session.phase = "questions";
        return res.json({ type: "question", text: q.text });
      }
      return res.status(500).json({ error: "Could not generate a guess" });
    }
    const wiki = await fetchWikipediaData(name, session.language);
    return res.json({ type: "guess", name, guessName: name, text: `Is it ${name}?`, confidence, wiki });
  }

  if (shouldGuessNow(session)) {
    return sendGuess(0.85);
  }

  if (session.phase === "guessing") {
    return sendGuess(0.80);
  }

  const nextQ = pickNextQuestion(session);
  if (!nextQ) {
    return sendGuess(0.75);
  }

  session.pendingKey = nextQ.key;
  res.json({ type: "question", text: nextQ.text });
});

// POST /api/game/guess-result
app.post("/api/game/guess-result", async (req, res) => {
  const { sessionId, correct, name } = req.body;

  if (!sessionId || correct === undefined) {
    res.status(400).json({ error: "sessionId and correct are required" });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  if (correct) {
    const charName = name || session.rejectedGuesses.at(-1) || "";
    const wiki = charName
      ? await fetchWikipediaData(charName, session.language)
      : EMPTY_WIKI;
    deleteSession(sessionId);
    return res.json({ type: "revealed", name: charName, guessName: charName, wiki });
  }

  if (name) handleWrongGuess(session, name);

  if (session.phase === "questions") {
    const nextQ = pickNextQuestion(session);
    if (!nextQ) {
      return res.json({ type: "give_up", message: "I give up! What was your character?" });
    }
    session.pendingKey = nextQ.key;
    return res.json({ type: "question", text: nextQ.text });
  }

  const nextName = await guessCharacter(session);
  if (!nextName) {
    return res.json({ type: "give_up", message: "I give up! What was your character?" });
  }
  const wiki = await fetchWikipediaData(nextName, session.language);
  res.json({ type: "guess", name: nextName, guessName: nextName, text: `Is it ${nextName}?`, confidence: 0.70, wiki });
});

// POST /api/game/reveal
app.post("/api/game/reveal", async (req, res) => {
  const { sessionId, name } = req.body;
  if (!sessionId || !name) {
    res.status(400).json({ error: "sessionId and name are required" });
    return;
  }
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  const wiki = await fetchWikipediaData(name, session.language);
  deleteSession(sessionId);
  res.json({ type: "revealed", name, guessName: name, wiki });
});

// DELETE /api/game/session/:sessionId
app.delete("/api/game/session/:sessionId", (req, res) => {
  deleteSession(req.params.sessionId);
  res.json({ success: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
