import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import crypto from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || 'gpt-4o';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ========================
// CONSTANTS
// ========================
const INITIAL_MIN = 9;
const INITIAL_MAX = 15;
const FOLLOWUP_MIN = 5;
const FOLLOWUP_MAX = 8;
const MAX_CONSECUTIVE_GUESSES = 3;
const SESSION_TTL_MS = 60 * 60 * 1000;

// ========================
// SESSION STORE
// ========================
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ========================
// HELPERS
// ========================
function normalizeAnswer(answer) {
  const map = {
    yes: 'yes', no: 'no', maybe: 'maybe',
    dontknow: 'dont_know', dont_know: 'dont_know',
  };
  return map[String(answer ?? '').trim().toLowerCase().replace(/[^a-z_]/g, '')] ?? 'dont_know';
}

function safeLower(v) {
  return String(v ?? '').trim().toLowerCase();
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

// ========================
// STATE INFERENCE
// Extracts all confirmed facts from answered questions
// ========================
function inferState(turns) {
  const s = {
    // Reality
    real: null, fictional: null, animated: null,
    // Gender
    male: null, female: null,
    // Region / Nationality
    arab: null, saudi: null, egyptian: null, emirati: null, kuwaiti: null,
    american: null, british: null, french: null, spanish: null, brazilian: null,
    argentine: null, portuguese: null,
    // Status
    alive: null, historical: null,
    // Domain (broad) — confirmed = true means we KNOW this domain
    athlete: null, entertainer: null, politician: null, scientist: null,
    businessPerson: null, royalty: null, writer: null, presenter: null,
    // Domain (narrow — only set after broad confirmed)
    footballer: null, basketballer: null, tennis: null, boxer: null, swimmer: null,
    actor: null, singer: null, director: null, comedian: null,
    // Achievements
    worldCup: null, oscar: null, grammy: null, nobel: null, ballon_dor: null,
    // Fictional specifics
    hero: null, villain: null, fromMarvel: null, fromDC: null, fromDisney: null,
    fromAnime: null,
    // Era
    active90s: null, active2000s: null, active2010s: null,
  };

  for (const turn of turns) {
    const q = safeLower(turn.question);
    const yes = turn.answer === 'yes';
    const no = turn.answer === 'no';
    if (!yes && !no) continue;
    const v = yes;

    // Reality
    if (q.includes('حقيقي') || q.includes('real') || q.includes('واقع')) s.real = v;
    if (q.includes('خيالي') || q.includes('fiction') || q.includes('وهمي')) s.fictional = v;
    if (q.includes('كرتون') || q.includes('cartoon') || q.includes('رسوم') || q.includes('animated') || q.includes('أنيم') || q.includes('anime')) s.animated = v;

    // Gender
    if (q.includes('رجل') || q.includes('ذكر') || q.includes('male') || q.includes(' man') || q.includes('boy')) s.male = v;
    if (q.includes('امرأة') || q.includes('أنثى') || q.includes('female') || q.includes('woman') || q.includes('girl')) s.female = v;

    // Nationality
    if ((q.includes('عربي') || q.includes('arab')) && !q.includes('غير') && !q.includes('non')) s.arab = v;
    if (q.includes('سعودي') || q.includes('saudi')) s.saudi = v;
    if (q.includes('مصري') || q.includes('egyptian')) s.egyptian = v;
    if (q.includes('إماراتي') || q.includes('اماراتي') || q.includes('emirati')) s.emirati = v;
    if (q.includes('كويتي') || q.includes('kuwaiti')) s.kuwaiti = v;
    if (q.includes('أمريكي') || q.includes('امريكي') || q.includes('american')) s.american = v;
    if (q.includes('بريطاني') || q.includes('إنجليزي') || q.includes('british') || q.includes('english')) s.british = v;
    if (q.includes('فرنسي') || q.includes('french')) s.french = v;
    if (q.includes('إسباني') || q.includes('اسباني') || q.includes('spanish')) s.spanish = v;
    if (q.includes('برازيلي') || q.includes('brazilian')) s.brazilian = v;
    if (q.includes('أرجنتيني') || q.includes('argentine')) s.argentine = v;
    if (q.includes('برتغالي') || q.includes('portuguese')) s.portuguese = v;

    // Status
    if (q.includes(' حي') || q.includes('alive') || q.includes('يعيش') || q.includes('living')) s.alive = v;
    if (q.includes('متوفى') || q.includes('مات') || q.includes('توفي') || q.includes('dead') || q.includes('deceased')) s.alive = no;
    if (q.includes('تاريخي') || q.includes('historical') || q.includes('قديم') || q.includes('ancient')) s.historical = v;

    // Domain — broad
    if (q.includes('رياضي') || q.includes('athlete') || q.includes('لاعب') || q.includes('player')) s.athlete = v;
    if (q.includes('فنان') || q.includes('نجم') || q.includes('ممثل') || q.includes('مغني') || q.includes('مطرب') ||
        q.includes('entertainer') || q.includes('actor') || q.includes('singer') || q.includes('artist')) s.entertainer = v;
    if (q.includes('سياسي') || q.includes('politician') || q.includes('رئيس دول') || q.includes('president') || q.includes('وزير')) s.politician = v;
    if (q.includes('عالم') || q.includes('scientist') || q.includes('مخترع') || q.includes('inventor') || q.includes('باحث')) s.scientist = v;
    if (q.includes('رجل أعمال') || q.includes('businessman') || q.includes('ceo') || q.includes('مليارد') || q.includes('ثري')) s.businessPerson = v;
    if (q.includes('ملكي') || q.includes('royal') || q.includes('ملك') || q.includes('أمير') || q.includes('king') || q.includes('queen') || q.includes('prince')) s.royalty = v;
    if (q.includes('كاتب') || q.includes('روائي') || q.includes('شاعر') || q.includes('writer') || q.includes('author') || q.includes('poet')) s.writer = v;
    if (q.includes('مقدم') || q.includes('مذيع') || q.includes('presenter') || q.includes('host') || q.includes('anchor')) s.presenter = v;

    // Domain — narrow (sports)
    if (q.includes('كرة القدم') || q.includes('football') || q.includes('soccer') || q.includes('لاعب كرة قدم')) s.footballer = v;
    if (q.includes('كرة السلة') || q.includes('basketball') || q.includes('nba')) s.basketballer = v;
    if (q.includes('تنس') || q.includes('tennis')) s.tennis = v;
    if (q.includes('ملاكم') || q.includes('boxing') || q.includes('boxer')) s.boxer = v;
    if (q.includes('سباح') || q.includes('swimmer') || q.includes('swimming')) s.swimmer = v;

    // Domain — narrow (entertainment)
    if (q.includes('ممثل') || q.includes('تمثيل') || q.includes('actor') || q.includes('actress') || q.includes('أفلام') || q.includes('سينما')) s.actor = v;
    if (q.includes('مغني') || q.includes('مطرب') || q.includes('singer') || q.includes('موسيقار') || q.includes('موسيق')) s.singer = v;
    if (q.includes('مخرج') || q.includes('director') || q.includes('إخراج')) s.director = v;
    if (q.includes('كوميديان') || q.includes('كوميدي') || q.includes('comedian')) s.comedian = v;

    // Achievements
    if (q.includes('كأس العالم') || q.includes('world cup')) s.worldCup = v;
    if (q.includes('أوسكار') || q.includes('oscar')) s.oscar = v;
    if (q.includes('غرامي') || q.includes('grammy')) s.grammy = v;
    if (q.includes('نوبل') || q.includes('nobel')) s.nobel = v;
    if (q.includes('بالون دور') || q.includes('ballon') || q.includes("ballon d'or")) s.ballon_dor = v;

    // Fictional
    if (q.includes('بطل خارق') || q.includes('superhero') || q.includes('خارق')) s.hero = v;
    if (q.includes('شرير') || q.includes('villain')) s.villain = v;
    if (q.includes('مارفل') || q.includes('marvel')) s.fromMarvel = v;
    if (q.includes('dc') || q.includes('دي سي')) s.fromDC = v;
    if (q.includes('ديزني') || q.includes('disney')) s.fromDisney = v;
    if (q.includes('أنيمي') || q.includes('anime') || q.includes('ياباني')) s.fromAnime = v;
  }

  return s;
}

// ========================
// DETECT CONFIRMED DOMAIN
// Returns the locked-in domain once confirmed
// ========================
function getConfirmedDomain(state) {
  if (state.athlete === true) return 'athlete';
  if (state.entertainer === true) return 'entertainer';
  if (state.politician === true) return 'politician';
  if (state.scientist === true) return 'scientist';
  if (state.businessPerson === true) return 'business';
  if (state.royalty === true) return 'royalty';
  if (state.writer === true) return 'writer';
  if (state.presenter === true) return 'presenter';
  if (state.fictional === true || state.animated === true) return 'fictional';
  return null;
}

// ========================
// CONCEPT KEY
// ========================
function conceptKey(text) {
  const q = safeLower(text);
  if (q.includes('حقيقي') || q.includes('real') || q.includes('خيالي') || q.includes('fiction')) return 'reality';
  if (q.includes('رجل') || q.includes('امرأة') || q.includes('male') || q.includes('female') || q.includes('ذكر') || q.includes('أنثى')) return 'gender';
  if ((q.includes('عربي') || q.includes('arab')) && !q.includes('غير')) return 'arab';
  if (q.includes('سعودي') || q.includes('saudi')) return 'saudi';
  if (q.includes('مصري') || q.includes('egyptian')) return 'egyptian';
  if (q.includes('أمريكي') || q.includes('american')) return 'american';
  if (q.includes('بريطاني') || q.includes('british') || q.includes('إنجليزي')) return 'british';
  if (q.includes('فرنسي') || q.includes('french')) return 'french';
  if (q.includes('إسباني') || q.includes('spanish')) return 'spanish';
  if (q.includes('برازيلي') || q.includes('brazilian')) return 'brazilian';
  if (q.includes('أرجنتيني') || q.includes('argentine')) return 'argentine';
  if (q.includes('برتغالي') || q.includes('portuguese')) return 'portuguese';
  if (q.includes(' حي') || q.includes('alive') || q.includes('متوفى') || q.includes('dead') || q.includes('يعيش')) return 'alive';
  if (q.includes('تاريخي') || q.includes('historical') || q.includes('قديم')) return 'historical';
  if (q.includes('رياضي') || q.includes('athlete') || (q.includes('لاعب') && !q.includes('كرة'))) return 'athlete_broad';
  if (q.includes('كرة القدم') || q.includes('football') || q.includes('soccer')) return 'football';
  if (q.includes('كرة السلة') || q.includes('basketball')) return 'basketball';
  if (q.includes('تنس') || q.includes('tennis')) return 'tennis';
  if (q.includes('ملاكم') || q.includes('boxing')) return 'boxing';
  if (q.includes('سباح') || q.includes('swimmer')) return 'swimming';
  if (q.includes('كأس العالم') || q.includes('world cup')) return 'worldcup';
  if (q.includes('بالون دور') || q.includes('ballon')) return 'ballon_dor';
  if (q.includes('فنان') || q.includes('نجم') || q.includes('entertainer') || q.includes('artist')) return 'entertainer_broad';
  if (q.includes('ممثل') || q.includes('actor') || q.includes('actress') || q.includes('أفلام')) return 'actor';
  if (q.includes('مغني') || q.includes('مطرب') || q.includes('singer') || q.includes('موسيق')) return 'singer';
  if (q.includes('مخرج') || q.includes('director')) return 'director';
  if (q.includes('كوميديان') || q.includes('comedian')) return 'comedian';
  if (q.includes('أوسكار') || q.includes('oscar')) return 'oscar';
  if (q.includes('غرامي') || q.includes('grammy')) return 'grammy';
  if (q.includes('سياسي') || q.includes('politician') || q.includes('رئيس') || q.includes('president')) return 'politician';
  if (q.includes('عالم') || q.includes('scientist') || q.includes('مخترع')) return 'scientist';
  if (q.includes('رجل أعمال') || q.includes('business') || q.includes('مليارد')) return 'business';
  if (q.includes('كاتب') || q.includes('writer') || q.includes('روائي') || q.includes('شاعر')) return 'writer';
  if (q.includes('ملك') || q.includes('أمير') || q.includes('royal') || q.includes('king') || q.includes('prince')) return 'royalty';
  if (q.includes('بطل خارق') || q.includes('superhero')) return 'superhero';
  if (q.includes('شرير') || q.includes('villain')) return 'villain';
  if (q.includes('مارفل') || q.includes('marvel')) return 'marvel';
  if (q.includes('ديزني') || q.includes('disney')) return 'disney';
  if (q.includes('أنيمي') || q.includes('anime')) return 'anime';
  if (q.includes('كرتون') || q.includes('cartoon') || q.includes('رسوم')) return 'cartoon';
  if (q.includes('نوبل') || q.includes('nobel')) return 'nobel';
  if (q.includes('مقدم') || q.includes('مذيع') || q.includes('presenter') || q.includes('host')) return 'presenter';
  return q.replace(/\s+/g, '_').slice(0, 50);
}

function wasAsked(key, session) {
  return session.turns.some((t) => conceptKey(t.question) === key);
}

function repeatedConcept(text, session) {
  return wasAsked(conceptKey(text), session);
}

function contradictsState(text, state) {
  const q = safeLower(text);
  if (state.male === true && (q.includes('امرأة') || q.includes('female') || q.includes('أنثى'))) return true;
  if (state.female === true && (q.includes('رجل') || q.includes('male') || q.includes('ذكر'))) return true;
  if (state.alive === true && (q.includes('متوفى') || q.includes('dead') || q.includes('مات'))) return true;
  if (state.alive === false && (q.includes(' حي') || q.includes('alive') || q.includes('يعيش'))) return true;
  if (state.real === true && (q.includes('خيالي') || q.includes('fiction') || q.includes('كرتون'))) return true;
  if (state.fictional === true && (q.includes('حقيقي') || q.includes('real') || q.includes('واقعي'))) return true;
  if (state.arab === true && (q.includes('أجنبي') || q.includes('foreign') || q.includes('غير عربي'))) return true;
  if (state.arab === false && q.includes('عربي') && !q.includes('غير')) return true;
  // Domain contradictions — if domain confirmed, block other domains
  if (state.athlete === true && (q.includes('سياسي') || q.includes('politician') || q.includes('عالم') || q.includes('scientist'))) return true;
  if (state.entertainer === true && (q.includes('رياضي') || q.includes('athlete') || q.includes('سياسي') || q.includes('politician'))) return true;
  if (state.politician === true && (q.includes('رياضي') || q.includes('athlete') || q.includes('فنان') || q.includes('مغني'))) return true;
  if (state.footballer === true && (q.includes('كرة السلة') || q.includes('basketball') || q.includes('تنس') || q.includes('tennis'))) return true;
  if (state.actor === true && (q.includes('رياضي') || q.includes('athlete') || q.includes('سياسي'))) return true;
  if (state.singer === true && (q.includes('رياضي') || q.includes('athlete') || q.includes('سياسي'))) return true;
  return false;
}

function isWeakQuestion(text) {
  const q = safeLower(text);
  const weak = ['مشهور', 'famous', 'do you know', 'تعرفه', 'popular', 'well known', 'معروف', 'هل تعرف', 'كبير'];
  return weak.some((p) => q.includes(p));
}

function isDoubleChoice(text) {
  const q = safeLower(text);
  return q.includes(' أو ') || q.includes(' or ') || q.includes('ذكر أم') || q.includes('male or female');
}

function isTooLong(text, lang) {
  return lang === 'ar' ? wordCount(text) > 7 : wordCount(text) > 10;
}

// ========================
// SMART FALLBACK QUESTIONS
// Stays within confirmed domain — never crosses domain boundaries
// ========================
function bestFallbackQuestion(lang, session) {
  const state = inferState(session.turns);
  const domain = getConfirmedDomain(state);
  const ar = lang === 'ar';

  const pick = (arQ, enQ) => ar ? arQ : enQ;
  const notAsked = (key) => !wasAsked(key, session);
  const ok = (arQ, enQ) => !contradictsState(ar ? arQ : enQ, state);

  // ── WITHIN DOMAIN: ATHLETE ──
  if (domain === 'athlete') {
    const options = [];
    if (notAsked('football') && ok('هل يلعب كرة القدم؟', 'Does it play football/soccer?'))
      options.push(pick('هل يلعب كرة القدم؟', 'Does it play football/soccer?'));
    if (notAsked('basketball') && ok('هل يلعب كرة السلة؟', 'Does it play basketball?'))
      options.push(pick('هل يلعب كرة السلة؟', 'Does it play basketball?'));
    if (notAsked('tennis') && ok('هل يلعب التنس؟', 'Does it play tennis?'))
      options.push(pick('هل يلعب التنس؟', 'Does it play tennis?'));
    if (notAsked('boxing') && ok('هل هو ملاكم؟', 'Is it a boxer?'))
      options.push(pick('هل هو ملاكم؟', 'Is it a boxer?'));
    if (notAsked('swimming') && ok('هل هو سباح؟', 'Is it a swimmer?'))
      options.push(pick('هل هو سباح؟', 'Is it a swimmer?'));
    // After sport type known
    if (state.footballer === true) {
      if (notAsked('worldcup')) options.push(pick('هل فاز بكأس العالم؟', 'Did it win the World Cup?'));
      if (notAsked('ballon_dor')) options.push(pick('هل فاز بالبالون دور؟', "Did it win the Ballon d'Or?"));
      if (notAsked('arab')) options.push(pick('هل هو عربي؟', 'Is it Arab?'));
      if (state.arab === false) {
        if (notAsked('american')) options.push(pick('هل هو أمريكي؟', 'Is it American?'));
        if (notAsked('british')) options.push(pick('هل هو بريطاني؟', 'Is it British?'));
        if (notAsked('french')) options.push(pick('هل هو فرنسي؟', 'Is it French?'));
        if (notAsked('argentine')) options.push(pick('هل هو أرجنتيني؟', 'Is it Argentine?'));
        if (notAsked('portuguese')) options.push(pick('هل هو برتغالي؟', 'Is it Portuguese?'));
        if (notAsked('brazilian')) options.push(pick('هل هو برازيلي؟', 'Is it Brazilian?'));
      }
    }
    if (state.basketballer === true) {
      if (notAsked('american')) options.push(pick('هل هو أمريكي؟', 'Is it American?'));
    }
    if (options.length) return options[0];
    return pick('هل لا يزال نشطاً؟', 'Is it still active?');
  }

  // ── WITHIN DOMAIN: ENTERTAINER ──
  if (domain === 'entertainer') {
    const options = [];
    if (notAsked('actor') && ok('هل هو ممثل؟', 'Is it an actor?'))
      options.push(pick('هل هو ممثل؟', 'Is it an actor?'));
    if (notAsked('singer') && ok('هل هو مغني؟', 'Is it a singer?'))
      options.push(pick('هل هو مغني؟', 'Is it a singer?'));
    if (notAsked('director') && ok('هل هو مخرج؟', 'Is it a director?'))
      options.push(pick('هل هو مخرج؟', 'Is it a director?'));
    if (notAsked('comedian') && ok('هل هو كوميديان؟', 'Is it a comedian?'))
      options.push(pick('هل هو كوميديان؟', 'Is it a comedian?'));
    // After sub-type known
    if (state.actor === true) {
      if (notAsked('oscar')) options.push(pick('هل فاز بجائزة أوسكار؟', 'Did it win an Oscar?'));
      if (notAsked('arab')) options.push(pick('هل هو عربي؟', 'Is it Arab?'));
      if (state.arab === false) {
        if (notAsked('american')) options.push(pick('هل هو أمريكي؟', 'Is it American?'));
        if (notAsked('british')) options.push(pick('هل هو بريطاني؟', 'Is it British?'));
      }
    }
    if (state.singer === true) {
      if (notAsked('grammy')) options.push(pick('هل فاز بجائزة غرامي؟', 'Did it win a Grammy?'));
      if (notAsked('arab')) options.push(pick('هل هو عربي؟', 'Is it Arab?'));
      if (state.arab === true) {
        if (notAsked('egyptian')) options.push(pick('هل هو مصري؟', 'Is it Egyptian?'));
        if (notAsked('saudi')) options.push(pick('هل هو سعودي؟', 'Is it Saudi?'));
        if (notAsked('kuwaiti')) options.push(pick('هل هو كويتي؟', 'Is it Kuwaiti?'));
      }
      if (state.arab === false) {
        if (notAsked('american')) options.push(pick('هل هو أمريكي؟', 'Is it American?'));
        if (notAsked('british')) options.push(pick('هل هو بريطاني؟', 'Is it British?'));
      }
    }
    if (options.length) return options[0];
    return pick('هل لا يزال نشطاً؟', 'Is it still active today?');
  }

  // ── WITHIN DOMAIN: POLITICIAN ──
  if (domain === 'politician') {
    const options = [];
    if (notAsked('arab')) options.push(pick('هل هو عربي؟', 'Is it Arab?'));
    if (state.arab === true) {
      if (notAsked('saudi')) options.push(pick('هل هو سعودي؟', 'Is it Saudi?'));
      if (notAsked('egyptian')) options.push(pick('هل هو مصري؟', 'Is it Egyptian?'));
    }
    if (state.arab === false) {
      if (notAsked('american')) options.push(pick('هل هو أمريكي؟', 'Is it American?'));
      if (notAsked('british')) options.push(pick('هل هو بريطاني؟', 'Is it British?'));
      if (notAsked('french')) options.push(pick('هل هو فرنسي؟', 'Is it French?'));
    }
    if (notAsked('alive')) options.push(pick('هل هو حي؟', 'Is it alive?'));
    if (options.length) return options[0];
    return pick('هل ترأس دولة؟', 'Did it lead a country?');
  }

  // ── WITHIN DOMAIN: FICTIONAL ──
  if (domain === 'fictional') {
    const options = [];
    if (notAsked('superhero') && ok('هل هو بطل خارق؟', 'Is it a superhero?'))
      options.push(pick('هل هو بطل خارق؟', 'Is it a superhero?'));
    if (notAsked('villain') && ok('هل هو شرير؟', 'Is it a villain?'))
      options.push(pick('هل هو شرير؟', 'Is it a villain?'));
    if (notAsked('marvel') && ok('هل هو من مارفل؟', 'Is it from Marvel?'))
      options.push(pick('هل هو من مارفل؟', 'Is it from Marvel?'));
    if (notAsked('disney') && ok('هل هو من ديزني؟', 'Is it from Disney?'))
      options.push(pick('هل هو من ديزني؟', 'Is it from Disney?'));
    if (notAsked('anime') && ok('هل هو من أنيمي؟', 'Is it from anime?'))
      options.push(pick('هل هو من أنيمي؟', 'Is it from anime?'));
    if (options.length) return options[0];
    return pick('هل يطير؟', 'Can it fly?');
  }

  // ── NO DOMAIN YET: Initial broad questions ──
  const broadAr = [
    ['reality',          'هل هو حقيقي؟'],
    ['gender',           'هل هو رجل؟'],
    ['athlete_broad',    'هل هو رياضي؟'],
    ['entertainer_broad','هل هو فنان أو ممثل؟'],
    ['politician',       'هل هو سياسي؟'],
    ['scientist',        'هل هو عالم أو مخترع؟'],
    ['business',         'هل هو رجل أعمال؟'],
    ['royalty',          'هل هو ملكي؟'],
    ['writer',           'هل هو كاتب؟'],
    ['alive',            'هل هو حي؟'],
    ['arab',             'هل هو عربي؟'],
  ];
  const broadEn = [
    ['reality',          'Is it a real person?'],
    ['gender',           'Is it male?'],
    ['athlete_broad',    'Is it an athlete?'],
    ['entertainer_broad','Is it an entertainer?'],
    ['politician',       'Is it a politician?'],
    ['scientist',        'Is it a scientist?'],
    ['business',         'Is it a businessperson?'],
    ['royalty',          'Is it royalty?'],
    ['writer',           'Is it a writer?'],
    ['alive',            'Is it alive?'],
    ['arab',             'Is it Arab?'],
  ];

  const broad = ar ? broadAr : broadEn;
  for (const [key, q] of broad) {
    if (!wasAsked(key, session) && !contradictsState(q, state)) return q;
  }

  return ar ? 'هل لا يزال نشطاً؟' : 'Is it still active?';
}

function fallbackGuess(lang) {
  return lang === 'ar'
    ? { type: 'guess', name: 'شخصية مشهورة', confidence: 0.2 }
    : { type: 'guess', name: 'A famous person', confidence: 0.2 };
}

// ========================
// SANITIZE AI RESPONSE
// ========================
function sanitize(raw, session) {
  if (!raw || typeof raw !== 'object') {
    return { type: 'question', text: bestFallbackQuestion(session.language, session) };
  }
  const state = inferState(session.turns);

  if (raw.type === 'question') {
    const text = String(raw.text ?? '').trim();
    if (!text) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (isTooLong(text, session.language)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (isWeakQuestion(text)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (isDoubleChoice(text)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (repeatedConcept(text, session)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    if (contradictsState(text, state)) return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    return { type: 'question', text };
  }

  if (raw.type === 'guess') {
    const name = String(raw.name ?? '').trim();
    if (!name) return fallbackGuess(session.language);
    if (session.rejectedGuesses.includes(name)) {
      return { type: 'question', text: bestFallbackQuestion(session.language, session) };
    }
    return {
      type: 'guess',
      name,
      confidence: typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.75,
    };
  }

  return { type: 'question', text: bestFallbackQuestion(session.language, session) };
}

// ========================
// SYSTEM PROMPT
// ========================
function makeSystemPrompt(lang, state) {
  const ar = lang === 'ar';
  const domain = getConfirmedDomain(state);

  // Build domain-lock instruction
  let domainInstruction = '';
  if (domain === 'athlete') {
    domainInstruction = ar
      ? `\nالشخصية رياضي مؤكد. يجب أن تبقى جميع الأسئلة داخل نطاق الرياضة فقط:
- نوع الرياضة (كرة قدم، سلة، تنس، ملاكمة...)
- الجنسية
- الإنجازات (كأس العالم، بالون دور...)
- النادي أو المنتخب
- الحقبة الزمنية
لا تسأل عن التمثيل أو الغناء أو السياسة أبداً.`
      : `\nDomain LOCKED: ATHLETE. ALL questions must stay within sports:
- Sport type (football, basketball, tennis, boxing...)
- Nationality
- Achievements (World Cup, Ballon d'Or, Olympics...)
- Club or national team
- Era
NEVER ask about acting, singing, or politics.`;
  } else if (domain === 'entertainer') {
    domainInstruction = ar
      ? `\nالشخصية فنان/نجم مؤكد. يجب أن تبقى جميع الأسئلة داخل نطاق الفن والترفيه فقط:
- نوع الفن (تمثيل، غناء، إخراج، كوميديا...)
- الجنسية
- الإنجازات (أوسكار، غرامي، جوائز...)
- نوع الأعمال (أفلام، مسلسلات، ألبومات...)
لا تسأل عن الرياضة أو السياسة أبداً.`
      : `\nDomain LOCKED: ENTERTAINER. ALL questions must stay within entertainment:
- Sub-type (actor, singer, director, comedian...)
- Nationality
- Achievements (Oscar, Grammy, awards...)
- Type of work (movies, TV shows, albums...)
NEVER ask about sports or politics.`;
  } else if (domain === 'politician') {
    domainInstruction = ar
      ? `\nالشخصية سياسي مؤكد. يجب أن تبقى جميع الأسئلة داخل نطاق السياسة:
- الجنسية والبلد
- المنصب (رئيس، وزير، ملك...)
- الحقبة الزمنية
لا تسأل عن الرياضة أو الفن أبداً.`
      : `\nDomain LOCKED: POLITICIAN. ALL questions must stay within politics:
- Nationality and country
- Position (president, minister, king...)
- Era
NEVER ask about sports or entertainment.`;
  } else if (domain === 'fictional') {
    domainInstruction = ar
      ? `\nالشخصية خيالية مؤكدة. يجب أن تبقى جميع الأسئلة داخل العالم الخيالي:
- مصدر الشخصية (مارفل، DC، ديزني، أنيمي، كرتون...)
- الدور (بطل، شرير، شخصية ثانوية...)
- القدرات الخاصة
- الفيلم أو المسلسل الرئيسي
لا تسأل عن شخصيات حقيقية أبداً.`
      : `\nDomain LOCKED: FICTIONAL. ALL questions must stay within the fictional world:
- Source (Marvel, DC, Disney, anime, cartoon...)
- Role (hero, villain, sidekick...)
- Special abilities
- Main movie or show
NEVER ask about real people.`;
  }

  return `You are an elite character-guessing AI for the "Magic Ball" mobile game.

━━ LANGUAGE (ABSOLUTE RULE) ━━
${ar
  ? 'Output ONLY Arabic. Every question must be 2–6 Arabic words. Names in Arabic spelling.'
  : 'Output ONLY English. Every question must be 2–8 words. Names in standard English spelling.'}

━━ JSON OUTPUT FORMAT (no markdown, no extra text) ━━
Question → {"type":"question","text":"..."}
Guess    → {"type":"guess","name":"...","confidence":0.92}

━━ GAME FLOW ━━
Phase 1: Ask 9–15 focused questions → then give best guess
Phase 2: If wrong → give up to 2 more immediate guesses (3 total)
Phase 3: After 3 wrong guesses → ask 5–8 domain-specific questions → guess again
Repeat until character is found.
${domainInstruction}

━━ QUESTION STRATEGY (when no domain confirmed yet) ━━
1. Real vs fictional
2. Male vs female
3. Athlete / Entertainer / Politician / Scientist / Business / Royalty / Writer
4. (After domain confirmed) → stay within domain, drill deeper
5. Nationality → achievements → era → final discriminators

━━ DOMAIN-DRILLING EXAMPLES ━━
If athlete confirmed:
  ${ar ? '"هل يلعب كرة القدم؟" → "هل عربي؟" → "هل فاز بكأس العالم؟" → "هل برتغالي؟" → تخمين' : '"Does it play football?" → "Is it Arab?" → "Did it win the World Cup?" → "Is it Portuguese?" → guess'}

If entertainer confirmed:
  ${ar ? '"هل هو ممثل؟" → "هل هو أمريكي؟" → "هل فاز بأوسكار؟" → "هل يمثل أفلام أكشن؟" → تخمين' : '"Is it an actor?" → "Is it American?" → "Did it win an Oscar?" → "Is it in action movies?" → guess'}

If singer confirmed (Arab):
  ${ar ? '"هل هو مصري؟" → "هل غنى في التسعينيات؟" → "هل اسمه عمرو دياب؟ لا، هل كاظم الساهر؟"' : '"Is it Egyptian?" → "Did they sing in the 90s?" → guess'}

━━ CRITICAL RULES ━━
✅ After domain confirmed: ONLY ask within that domain
✅ Each question must eliminate the most possibilities
✅ Full name as known (${ar ? 'مثل "محمد صلاح" لا "صلاح"' : 'e.g. "Lionel Messi" not "Messi"'})
✅ Confidence 0.85+ → commit and guess
✅ Never repeat a rejected guess
❌ Never ask "هل هو مشهور؟" / "Is it famous?" — everyone is
❌ Never double-choice ("ذكر أو أنثى؟")
❌ Never mention a candidate name during question mode
❌ Never cross domain boundaries after domain is confirmed`;
}

// ========================
// SESSION CONTEXT
// ========================
function sessionContext(session) {
  const turns = session.turns.length
    ? session.turns.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`).join('\n')
    : 'No questions yet.';

  const state = inferState(session.turns);
  const domain = getConfirmedDomain(state);
  const facts = Object.entries(state)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

  return [
    `── CONVERSATION ──\n${turns}`,
    `── CONFIRMED DOMAIN ──\n${domain ?? 'not determined yet'}`,
    `── CONFIRMED FACTS ──\n${facts || 'none yet'}`,
    `── REJECTED GUESSES ──\n${session.rejectedGuesses.join(', ') || 'none'}`,
    `── PHASE ──\nQuestions this phase: ${session.questionsSincePhaseReset}/${session.maxQuestionsBeforeGuess} | Guess streak: ${session.guessStreak}/${MAX_CONSECUTIVE_GUESSES}`,
  ].join('\n\n');
}

function canGuess(session) {
  return session.questionsSincePhaseReset >= session.minQuestionsBeforeGuess;
}

function mustGuess(session) {
  return session.questionsSincePhaseReset >= session.maxQuestionsBeforeGuess;
}

// ========================
// MAIN ENGINE
// ========================
async function runEngine(session) {
  if (!openai) {
    if (mustGuess(session)) return fallbackGuess(session.language);
    return { type: 'question', text: bestFallbackQuestion(session.language, session) };
  }

  const state = inferState(session.turns);

  const userContent = `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

${sessionContext(session)}

━━ YOUR DECISION ━━
canGuessNow  = ${canGuess(session)}
mustGuessNow = ${mustGuess(session)}

Rules:
• mustGuessNow=true  → ONLY output a guess now
• canGuessNow=false  → ONLY output a question
• canGuessNow=true   → guess if confidence ≥ 0.85, else one more domain-focused question
• Rejected guesses (never repeat): [${session.rejectedGuesses.join(', ') || 'none'}]
• Confirmed domain: ${getConfirmedDomain(state) ?? 'none yet'}
• STAY within confirmed domain for all questions`;

  try {
    const response = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 100,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: makeSystemPrompt(session.language, state) },
        { role: 'user', content: userContent },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    let result = sanitize(parsed, session);

    if (result.type === 'guess' && !canGuess(session)) {
      result = { type: 'question', text: bestFallbackQuestion(session.language, session) };
    }
    if (mustGuess(session) && result.type !== 'guess') {
      return await forceGuess(session);
    }

    return result;
  } catch (err) {
    console.error('runEngine error:', err?.message);
    if (mustGuess(session)) return await forceGuess(session);
    return { type: 'question', text: bestFallbackQuestion(session.language, session) };
  }
}

// ========================
// FORCE GUESS
// ========================
async function forceGuess(session) {
  if (!openai) return fallbackGuess(session.language);

  const state = inferState(session.turns);

  try {
    const response = await openai.chat.completions.create({
      model,
      temperature: 0.15,
      max_tokens: 80,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You must guess the character RIGHT NOW based on all confirmed facts.
Return STRICT JSON only: {"type":"guess","name":"...","confidence":0.85}
Language: ${session.language === 'ar' ? 'Arabic name spelling' : 'English'}
DO NOT repeat: [${session.rejectedGuesses.join(', ') || 'none'}]
Confirmed domain: ${getConfirmedDomain(state) ?? 'unknown'}
Use all facts to pick the single most likely character.`,
        },
        { role: 'user', content: sessionContext(session) + '\n\nBest guess now.' },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    const cleaned = sanitize(parsed, session);
    return cleaned.type === 'guess' ? cleaned : fallbackGuess(session.language);
  } catch (err) {
    console.error('forceGuess error:', err?.message);
    return fallbackGuess(session.language);
  }
}

// ========================
// WIKIPEDIA
// ========================
async function fetchWiki(name, lang) {
  const l = lang === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(String(name).replace(/ /g, '_'));
  try {
    const res = await fetch(
      `https://${l}.wikipedia.org/api/rest_v1/page/summary/${title}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error('not found');
    const j = await res.json();
    return {
      title: j.title ?? name,
      extract: j.extract ?? '',
      imageURL: j.thumbnail?.source ?? null,
      articleURL: j.content_urls?.desktop?.page ?? `https://${l}.wikipedia.org/wiki/${title}`,
    };
  } catch {
    return {
      title: name,
      extract: lang === 'ar' ? 'لا توجد معلومات متاحة' : 'No information available',
      imageURL: null,
      articleURL: `https://${l}.wikipedia.org/wiki/${title}`,
    };
  }
}

// ========================
// ROUTES
// ========================

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model, hasOpenAI: Boolean(openai) });
});

// POST /api/game/start
// Body: { language: "ar" | "en" }
app.post('/api/game/start', async (req, res) => {
  try {
    const language = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId, language,
      turns: [], rejectedGuesses: [],
      guessStreak: 0, questionsSincePhaseReset: 0,
      minQuestionsBeforeGuess: INITIAL_MIN,
      maxQuestionsBeforeGuess: INITIAL_MAX,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(sessionId, session);
    const result = await runEngine(session);
    return res.json({ sessionId, ...result });
  } catch (err) {
    console.error('start error:', err);
    return res.status(500).json({ error: 'Failed to start game' });
  }
});

// POST /api/game/answer
// Body: { sessionId, question, answer: "yes"|"no"|"maybe"|"dont_know" }
app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL_MS;
    session.turns.push({ question: String(question ?? ''), answer: normalizeAnswer(answer) });
    session.questionsSincePhaseReset += 1;

    const result = await runEngine(session);
    return res.json(result);
  } catch (err) {
    console.error('answer error:', err);
    return res.status(500).json({ error: 'Failed to process answer' });
  }
});

// POST /api/game/guess-confirm
// Body: { sessionId, guessName, correct: true|false }
// Flow:
//   correct=true            → { type:"revealed", guessName, wiki:{...} }
//   wrong + streak < 3      → immediate next guess (guess 2 or 3)
//   wrong + streak >= 3     → reset, ask 5-8 domain-focused questions
app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL_MS;

    if (correct) {
      const wiki = await fetchWiki(String(guessName ?? ''), session.language);
      session.guessStreak = 0;
      session.questionsSincePhaseReset = 0;
      session.minQuestionsBeforeGuess = INITIAL_MIN;
      session.maxQuestionsBeforeGuess = INITIAL_MAX;
      session.rejectedGuesses = [];
      return res.json({ type: 'revealed', guessName, wiki });
    }

    if (guessName) session.rejectedGuesses.push(String(guessName));
    session.guessStreak += 1;

    // Guesses 2 & 3: try again immediately without questions
    if (session.guessStreak < MAX_CONSECUTIVE_GUESSES) {
      const result = await forceGuess(session);
      return res.json(result);
    }

    // After 3 wrong: go back to domain-focused questions (5-8)
    session.guessStreak = 0;
    session.questionsSincePhaseReset = 0;
    session.minQuestionsBeforeGuess = FOLLOWUP_MIN;
    session.maxQuestionsBeforeGuess = FOLLOWUP_MAX;

    const result = await runEngine(session);
    return res.json(result);
  } catch (err) {
    console.error('guess-confirm error:', err);
    return res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

// GET /api/wiki?name=...&language=ar
app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name ?? '');
    const lang = req.query.language === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ error: 'name is required' });
    return res.json(await fetchWiki(name, lang));
  } catch (err) {
    console.error('wiki error:', err);
    return res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

// ========================
// START
// ========================
app.listen(port, () => {
  console.log(`✅ Magic Ball  →  http://localhost:${port}`);
  console.log(`🤖 Model: ${model} | OpenAI: ${Boolean(openai)}`);
  console.log(`🎯 Phase 1: ${INITIAL_MIN}–${INITIAL_MAX} questions → 3 guesses`);
  console.log(`🔁 Phase 2: ${FOLLOWUP_MIN}–${FOLLOWUP_MAX} domain-focused questions → guess again`);
});
