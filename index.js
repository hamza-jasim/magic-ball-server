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

const INITIAL_MIN  = 9;
const INITIAL_MAX  = 15;
const FOLLOWUP_MIN = 5;
const FOLLOWUP_MAX = 8;
const MAX_CONSECUTIVE_GUESSES = 3;
const SESSION_TTL_MS = 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────
//  SESSION STORE
// ──────────────────────────────────────────────────────────────
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}, 5 * 60 * 1000);

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────
const normalize = (a) => {
  const m = { yes:'yes', no:'no', maybe:'maybe', dontknow:'dont_know', dont_know:'dont_know' };
  return m[String(a ?? '').trim().toLowerCase().replace(/[^a-z_]/g,'')] ?? 'dont_know';
};

// ──────────────────────────────────────────────────────────────
//  STATE INFERENCE  — reads Q&A history into a flat object
// ──────────────────────────────────────────────────────────────
function inferState(turns) {
  const S = {
    // reality
    real:null, fictional:null, animated:null,
    // gender
    male:null, female:null,
    // status
    alive:null, historical:null,
    // broad domain
    athlete:null, entertainer:null, politician:null,
    scientist:null, business:null, royalty:null, writer:null,
    // sport sub-domain (only one should be true)
    footballer:null, basketballer:null, tennis_player:null, boxer:null, swimmer:null, golfer:null,
    // entertainment sub-domain
    actor:null, singer:null, director:null, comedian:null,
    // nationality
    arab:null, saudi:null, egyptian:null, emirati:null, kuwaiti:null,
    american:null, british:null, french:null, spanish:null,
    portuguese:null, argentine:null, brazilian:null,
    german:null, italian:null, dutch:null,
    // achievements
    worldcup:null, ballon_dor:null, oscar:null, grammy:null,
    olympics:null, nobel:null, champions_league:null,
    // era
    era_now:null, era_90s:null, era_80s:null, era_2000s:null,
    // entertainment details
    action_movies:null, superhero_role:null, tv_series:null, hollywood:null,
    // sport details
    striker:null, goalkeeper:null, defender:null, midfielder:null,
    wears_10:null, national_team:null,
    club_real:null, club_barca:null, club_manutd:null, club_chelsea:null, club_liverpool:null,
    // fictional
    hero:null, villain:null, marvel:null, dc:null, disney:null, anime:null,
    can_fly:null, has_powers:null, from_movie:null, from_game:null,
  };

  for (const t of turns) {
    const q = t.question.toLowerCase();
    const y = t.answer === 'yes';
    const n = t.answer === 'no';
    if (!y && !n) continue;
    const v = y;

    const has = (...kw) => kw.some(k => q.includes(k));

    if (has('حقيقي','real person','واقعي')) S.real=v;
    if (has('خيالي','fictional','وهمي'))   S.fictional=v;
    if (has('كرتون','cartoon','رسوم','animated','أنيم','anime')) S.animated=v;

    if (has('رجل','ذكر',' male',' man','boy'))     S.male=v;
    if (has('امرأة','أنثى','female','woman','girl')) S.female=v;

    if (has(' حي ','alive','يعيش','living'))                 S.alive=v;
    if (has('متوفى','مات','توفي',' dead','deceased'))        S.alive=n;
    if (has('تاريخي','historical','قديم','ancient','قرن'))   S.historical=v;

    // broad domain
    if (has('رياضي','athlete','لاعب') && !has('كرة القدم','كرة السلة','تنس','ملاكم','سباح','جولف')) S.athlete=v;
    if (has('فنان','ممثل','مغني','مطرب','نجم','entertainer','actor','singer','artist') && !has('رياضي','athlete')) S.entertainer=v;
    if (has('سياسي','politician','رئيس دول','وزير','president'))  S.politician=v;
    if (has('عالم','scientist','مخترع','inventor','باحث'))         S.scientist=v;
    if (has('رجل أعمال','businessman','ثري','مليارد','ceo'))       S.business=v;
    if (has('ملكي','royal','ملك ','أمير','king ','queen','prince')) S.royalty=v;
    if (has('كاتب','روائي','شاعر','writer','author','poet'))       S.writer=v;

    // sport sub-domain
    if (has('كرة القدم','football','soccer','لاعب كرة قدم'))       { S.footballer=v; if(v){S.athlete=true;S.basketballer=false;S.boxer=false;S.tennis_player=false;S.swimmer=false;} }
    if (has('كرة السلة','basketball','nba'))                       { S.basketballer=v; if(v){S.athlete=true;S.footballer=false;} }
    if (has(' تنس','tennis'))                                      { S.tennis_player=v; if(v){S.athlete=true;S.footballer=false;} }
    if (has('ملاكم','boxer','boxing'))                             { S.boxer=v; if(v){S.athlete=true;S.footballer=false;} }
    if (has('سباح','swimmer','swimming'))                          { S.swimmer=v; if(v){S.athlete=true;S.footballer=false;} }
    if (has('غولف','golf'))                                        { S.golfer=v; if(v){S.athlete=true;S.footballer=false;} }

    // entertainment sub-domain
    if (has('ممثل','actor','actress','يمثل','أفلام سينما','cinema')) { S.actor=v; if(v){S.entertainer=true;} }
    if (has('مغني','مطرب','singer','موسيقار','يغني'))               { S.singer=v; if(v){S.entertainer=true;} }
    if (has('مخرج','director','إخراج'))                             { S.director=v; if(v){S.entertainer=true;} }
    if (has('كوميديان','كوميدي','comedian'))                        { S.comedian=v; if(v){S.entertainer=true;} }

    // nationality
    if (has('عربي','arab') && !has('غير','non'))     S.arab=v;
    if (has('سعودي','saudi'))      S.saudi=v;
    if (has('مصري','egyptian'))    S.egyptian=v;
    if (has('إماراتي','اماراتي','emirati')) S.emirati=v;
    if (has('كويتي','kuwaiti'))    S.kuwaiti=v;
    if (has('أمريكي','امريكي','american')) S.american=v;
    if (has('بريطاني','إنجليزي','british','english') && !has('أمريكي')) S.british=v;
    if (has('فرنسي','french'))     S.french=v;
    if (has('إسباني','اسباني','spanish')) S.spanish=v;
    if (has('برتغالي','portuguese')) S.portuguese=v;
    if (has('أرجنتيني','argentine')) S.argentine=v;
    if (has('برازيلي','brazilian')) S.brazilian=v;
    if (has('ألماني','german'))    S.german=v;
    if (has('إيطالي','italian'))   S.italian=v;

    // achievements
    if (has('كأس العالم','world cup'))     S.worldcup=v;
    if (has('بالون دور','ballon'))         S.ballon_dor=v;
    if (has('أوسكار','oscar'))             S.oscar=v;
    if (has('غرامي','grammy'))             S.grammy=v;
    if (has('أولمبي','olympic'))           S.olympics=v;
    if (has('نوبل','nobel'))               S.nobel=v;
    if (has('دوري أبطال','champions league','ucl')) S.champions_league=v;

    // era
    if (has('الآن','نشط الآن','still active','currently active','still playing','لا يزال')) S.era_now=v;
    if (has('تسعينيات','90s','nineties'))  S.era_90s=v;
    if (has('ثمانينيات','80s','eighties')) S.era_80s=v;
    if (has('ألفين','2000s'))              S.era_2000s=v;

    // entertainment details
    if (has('أكشن','action movie'))        S.action_movies=v;
    if (has('بطل خارق','superhero','خارق')) S.superhero_role=v;
    if (has('مسلسل','tv series','tv show','series')) S.tv_series=v;
    if (has('هوليود','hollywood'))         S.hollywood=v;

    // sport details
    if (has('مهاجم','striker','forward'))  S.striker=v;
    if (has('حارس','goalkeeper','keeper')) S.goalkeeper=v;
    if (has('مدافع','defender','defender')) S.defender=v;
    if (has('وسط','midfielder','midfield')) S.midfielder=v;
    if (has('رقم 10','number 10','القميص 10')) S.wears_10=v;
    if (has('منتخب','national team'))      S.national_team=v;
    if (has('ريال مدريد','real madrid'))   S.club_real=v;
    if (has('برشلونة','barcelona','barca')) S.club_barca=v;
    if (has('مانشستر يونايتد','man utd','man united')) S.club_manutd=v;
    if (has('ليفربول','liverpool'))        S.club_liverpool=v;
    if (has('تشيلسي','chelsea'))           S.club_chelsea=v;

    // fictional
    if (has('بطل خارق','superhero') && S.fictional) S.hero=v;
    if (has('شرير','villain'))       S.villain=v;
    if (has('مارفل','marvel'))       S.marvel=v;
    if (has('dc','دي سي'))           S.dc=v;
    if (has('ديزني','disney'))       S.disney=v;
    if (has('أنيمي','anime','ياباني')) S.anime=v;
    if (has('يطير','يستطيع الطير','fly','can fly')) S.can_fly=v;
    if (has('قوى خارقة','super powers','has powers')) S.has_powers=v;
    if (has('من فيلم','from a movie','movie character')) S.from_movie=v;
    if (has('لعبة','from a game','video game'))          S.from_game=v;
  }
  return S;
}

// ──────────────────────────────────────────────────────────────
//  DETECTED DOMAIN  — the narrowest confirmed domain
// ──────────────────────────────────────────────────────────────
function getDomain(S) {
  // Narrowest first
  if (S.footballer === true)    return 'footballer';
  if (S.basketballer === true)  return 'basketballer';
  if (S.tennis_player === true) return 'tennis';
  if (S.boxer === true)         return 'boxer';
  if (S.swimmer === true)       return 'swimmer';
  if (S.golfer === true)        return 'golfer';
  if (S.actor === true)         return 'actor';
  if (S.singer === true)        return 'singer';
  if (S.director === true)      return 'director';
  if (S.comedian === true)      return 'comedian';
  // Broad domains
  if (S.athlete === true)       return 'athlete';
  if (S.entertainer === true)   return 'entertainer';
  if (S.politician === true)    return 'politician';
  if (S.scientist === true)     return 'scientist';
  if (S.business === true)      return 'business';
  if (S.royalty === true)       return 'royalty';
  if (S.writer === true)        return 'writer';
  if (S.animated === true || S.fictional === true) return 'fictional';
  return null;
}

// ──────────────────────────────────────────────────────────────
//  STRUCTURED QUESTION TREES
//  Each entry: { key, ar, en }
//  key = unique concept — never ask two entries with same key
// ──────────────────────────────────────────────────────────────
const TREE = {

  // ── 0. Before any domain is known ──────────────────────────
  pre_domain: [
    { key:'reality',      ar:'هل هو شخص حقيقي؟',              en:'Is it a real person?' },
    { key:'gender',       ar:'هل هو رجل؟',                    en:'Is it male?' },
    { key:'athlete',      ar:'هل هو رياضي؟',                  en:'Is it an athlete?' },
    { key:'entertainer',  ar:'هل هو فنان أو نجم؟',            en:'Is it an entertainer?' },
    { key:'politician',   ar:'هل هو سياسي؟',                  en:'Is it a politician?' },
    { key:'scientist',    ar:'هل هو عالم أو مخترع؟',          en:'Is it a scientist or inventor?' },
    { key:'business',     ar:'هل هو رجل أعمال؟',              en:'Is it a businessperson?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'historical',   ar:'هل هو شخصية تاريخية؟',          en:'Is it a historical figure?' },
  ],

  // ── 1. Athlete — broad (before sport sub-type known) ──────
  athlete: [
    { key:'football',     ar:'هل يلعب كرة القدم؟',            en:'Does it play football/soccer?' },
    { key:'basketball',   ar:'هل يلعب كرة السلة؟',            en:'Does it play basketball?' },
    { key:'tennis',       ar:'هل يلعب التنس؟',                en:'Does it play tennis?' },
    { key:'boxing',       ar:'هل هو ملاكم؟',                  en:'Is it a boxer?' },
    { key:'swimming',     ar:'هل هو سباح؟',                   en:'Is it a swimmer?' },
    { key:'golf',         ar:'هل يلعب الغولف؟',               en:'Does it play golf?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
  ],

  // ── 2. Footballer ──────────────────────────────────────────
  footballer: [
    { key:'arab',           ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'south_american', ar:'هل هو من أمريكا الجنوبية؟',     en:'Is it South American?' },
    { key:'european',       ar:'هل هو أوروبي؟',                 en:'Is it European?' },
    { key:'worldcup',       ar:'هل فاز بكأس العالم؟',           en:'Did it win the World Cup?' },
    { key:'ballon_dor',     ar:'هل فاز بالبالون دور؟',          en:"Did it win the Ballon d'Or?" },
    { key:'champions_league',ar:'هل فاز بدوري أبطال أوروبا؟',  en:'Did it win the Champions League?' },
    { key:'era_now',        ar:'هل لا يزال يلعب الآن؟',         en:'Is it still playing now?' },
    { key:'portuguese',     ar:'هل هو برتغالي؟',               en:'Is it Portuguese?' },
    { key:'argentine',      ar:'هل هو أرجنتيني؟',              en:'Is it Argentine?' },
    { key:'brazilian',      ar:'هل هو برازيلي؟',               en:'Is it Brazilian?' },
    { key:'french',         ar:'هل هو فرنسي؟',                 en:'Is it French?' },
    { key:'spanish',        ar:'هل هو إسباني؟',                en:'Is it Spanish?' },
    { key:'british',        ar:'هل هو بريطاني؟',               en:'Is it British?' },
    { key:'german',         ar:'هل هو ألماني؟',                en:'Is it German?' },
    { key:'striker',        ar:'هل هو مهاجم؟',                 en:'Is it a striker?' },
    { key:'goalkeeper',     ar:'هل هو حارس مرمى؟',             en:'Is it a goalkeeper?' },
    { key:'midfielder',     ar:'هل هو لاعب وسط؟',              en:'Is it a midfielder?' },
    { key:'club_real',      ar:'هل لعب في ريال مدريد؟',         en:'Did it play for Real Madrid?' },
    { key:'club_barca',     ar:'هل لعب في برشلونة؟',           en:'Did it play for Barcelona?' },
    { key:'club_liverpool', ar:'هل لعب في ليفربول؟',           en:'Did it play for Liverpool?' },
    { key:'era_90s',        ar:'هل اشتهر في التسعينيات؟',      en:'Did it rise to fame in the 90s?' },
    { key:'saudi',          ar:'هل هو سعودي؟',                 en:'Is it Saudi?' },
    { key:'egyptian',       ar:'هل هو مصري؟',                  en:'Is it Egyptian?' },
    { key:'national_team',  ar:'هل يلعب مع منتخبه الوطني؟',    en:'Does it play for its national team?' },
    { key:'alive',          ar:'هل هو حي؟',                    en:'Is it alive?' },
  ],

  // ── 3. Basketballer ───────────────────────────────────────
  basketballer: [
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'era_now',      ar:'هل لا يزال يلعب الآن؟',          en:'Is it still playing now?' },
    { key:'era_90s',      ar:'هل اشتهر في التسعينيات؟',       en:'Did it rise to fame in the 90s?' },
    { key:'olympics',     ar:'هل فاز بميدالية أولمبية؟',       en:'Did it win an Olympic medal?' },
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
  ],

  // ── 4. Tennis ─────────────────────────────────────────────
  tennis: [
    { key:'european',     ar:'هل هو أوروبي؟',                  en:'Is it European?' },
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'spanish',      ar:'هل هو إسباني؟',                  en:'Is it Spanish?' },
    { key:'swiss',        ar:'هل هو سويسري؟',                  en:'Is it Swiss?' },
    { key:'serbian',      ar:'هل هو صربي؟',                   en:'Is it Serbian?' },
    { key:'olympics',     ar:'هل فاز بميدالية أولمبية؟',       en:'Did it win an Olympic medal?' },
    { key:'era_now',      ar:'هل لا يزال يلعب الآن؟',          en:'Is it still playing now?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
  ],

  // ── 5. Boxer ──────────────────────────────────────────────
  boxer: [
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'era_now',      ar:'هل لا يزال يلعب الآن؟',          en:'Is it still active now?' },
    { key:'era_90s',      ar:'هل اشتهر في التسعينيات؟',       en:'Did it rise to fame in the 90s?' },
    { key:'olympics',     ar:'هل فاز بميدالية أولمبية؟',       en:'Did it win an Olympic gold?' },
    { key:'heavyweight',  ar:'هل هو في وزن ثقيل؟',            en:'Is it a heavyweight?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
  ],

  // ── 6. Entertainer broad (before actor/singer known) ──────
  entertainer: [
    { key:'actor',        ar:'هل هو ممثل؟',                   en:'Is it an actor?' },
    { key:'singer',       ar:'هل هو مغني؟',                   en:'Is it a singer?' },
    { key:'director',     ar:'هل هو مخرج؟',                   en:'Is it a film director?' },
    { key:'comedian',     ar:'هل هو كوميديان؟',               en:'Is it a comedian?' },
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
    { key:'era_now',      ar:'هل لا يزال نشطاً الآن؟',        en:'Is it still active now?' },
  ],

  // ── 7. Actor ──────────────────────────────────────────────
  actor: [
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'british',      ar:'هل هو بريطاني؟',                en:'Is it British?' },
    { key:'oscar',        ar:'هل فاز بجائزة أوسكار؟',          en:'Did it win an Oscar?' },
    { key:'action_movies',ar:'هل يمثل في أفلام أكشن؟',        en:'Is it known for action movies?' },
    { key:'superhero_role',ar:'هل مثّل دور بطل خارق؟',        en:'Did it play a superhero role?' },
    { key:'tv_series',    ar:'هل اشتهر في مسلسل؟',            en:'Is it famous from a TV series?' },
    { key:'hollywood',    ar:'هل هو من هوليود؟',              en:'Is it from Hollywood?' },
    { key:'era_now',      ar:'هل لا يزال يمثل الآن؟',         en:'Is it still acting now?' },
    { key:'era_90s',      ar:'هل اشتهر في التسعينيات؟',       en:'Did it rise to fame in the 90s?' },
    { key:'era_80s',      ar:'هل اشتهر في الثمانينيات؟',      en:'Did it rise to fame in the 80s?' },
    { key:'egyptian',     ar:'هل هو مصري؟',                   en:'Is it Egyptian?' },
    { key:'french',       ar:'هل هو فرنسي؟',                  en:'Is it French?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
  ],

  // ── 8. Singer ─────────────────────────────────────────────
  singer: [
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'british',      ar:'هل هو بريطاني؟',                en:'Is it British?' },
    { key:'grammy',       ar:'هل فاز بجائزة غرامي؟',           en:'Did it win a Grammy?' },
    { key:'era_now',      ar:'هل لا يزال يغني الآن؟',          en:'Is it still singing now?' },
    { key:'era_90s',      ar:'هل اشتهر في التسعينيات؟',       en:'Did it rise to fame in the 90s?' },
    { key:'era_80s',      ar:'هل اشتهر في الثمانينيات؟',      en:'Did it rise to fame in the 80s?' },
    { key:'egyptian',     ar:'هل هو مصري؟',                   en:'Is it Egyptian?' },
    { key:'saudi',        ar:'هل هو سعودي؟',                  en:'Is it Saudi?' },
    { key:'kuwaiti',      ar:'هل هو كويتي؟',                  en:'Is it Kuwaiti?' },
    { key:'french',       ar:'هل هو فرنسي؟',                  en:'Is it French?' },
    { key:'band',         ar:'هل هو في فرقة موسيقية؟',         en:'Is it part of a band?' },
    { key:'pop',          ar:'هل يغني موسيقى بوب؟',            en:'Is it a pop singer?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
  ],

  // ── 9. Director ───────────────────────────────────────────
  director: [
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'british',      ar:'هل هو بريطاني؟',                en:'Is it British?' },
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'oscar',        ar:'هل فاز بأوسكار أفضل مخرج؟',     en:'Did it win a Best Director Oscar?' },
    { key:'action_movies',ar:'هل يخرج أفلام أكشن؟',           en:'Is it known for action films?' },
    { key:'era_now',      ar:'هل لا يزال يخرج الآن؟',          en:'Is it still directing now?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
  ],

  // ── 10. Comedian ──────────────────────────────────────────
  comedian: [
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'british',      ar:'هل هو بريطاني؟',                en:'Is it British?' },
    { key:'tv_series',    ar:'هل اشتهر في مسلسل كوميدي؟',     en:'Is it famous from a comedy show?' },
    { key:'era_now',      ar:'هل لا يزال نشطاً الآن؟',        en:'Is it still active now?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
  ],

  // ── 11. Politician ────────────────────────────────────────
  politician: [
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'british',      ar:'هل هو بريطاني؟',                en:'Is it British?' },
    { key:'french',       ar:'هل هو فرنسي؟',                  en:'Is it French?' },
    { key:'president',    ar:'هل كان رئيس دولة؟',             en:'Did it serve as head of state?' },
    { key:'king',         ar:'هل هو ملك أو أمير؟',            en:'Is it a king or prince?' },
    { key:'era_now',      ar:'هل لا يزال في منصبه؟',          en:'Is it still in office?' },
    { key:'historical',   ar:'هل هو شخصية تاريخية قديمة؟',    en:'Is it an ancient historical figure?' },
    { key:'saudi',        ar:'هل هو سعودي؟',                  en:'Is it Saudi?' },
    { key:'egyptian',     ar:'هل هو مصري؟',                   en:'Is it Egyptian?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
  ],

  // ── 12. Scientist / Inventor ──────────────────────────────
  scientist: [
    { key:'historical',   ar:'هل هو شخصية تاريخية؟',          en:'Is it a historical figure?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'british',      ar:'هل هو بريطاني؟',                en:'Is it British?' },
    { key:'german',       ar:'هل هو ألماني؟',                 en:'Is it German?' },
    { key:'nobel',        ar:'هل فاز بجائزة نوبل؟',           en:'Did it win a Nobel Prize?' },
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'physics',      ar:'هل هو في مجال الفيزياء؟',       en:'Is it known for physics?' },
    { key:'medicine',     ar:'هل هو في مجال الطب؟',           en:'Is it known for medicine?' },
    { key:'tech',         ar:'هل هو في مجال التكنولوجيا؟',    en:'Is it known for technology?' },
  ],

  // ── 13. Fictional / Animated ──────────────────────────────
  fictional: [
    { key:'superhero',    ar:'هل هو بطل خارق؟',               en:'Is it a superhero?' },
    { key:'villain',      ar:'هل هو شرير؟',                   en:'Is it a villain?' },
    { key:'marvel',       ar:'هل هو من عالم مارفل؟',           en:'Is it from Marvel?' },
    { key:'dc',           ar:'هل هو من عالم DC؟',             en:'Is it from DC?' },
    { key:'disney',       ar:'هل هو من ديزني؟',               en:'Is it from Disney?' },
    { key:'anime',        ar:'هل هو من أنيمي؟',               en:'Is it from anime?' },
    { key:'can_fly',      ar:'هل يستطيع الطيران؟',             en:'Can it fly?' },
    { key:'has_powers',   ar:'هل لديه قوى خارقة؟',            en:'Does it have superpowers?' },
    { key:'from_movie',   ar:'هل هو من فيلم سينمائي؟',        en:'Is it from a movie?' },
    { key:'from_game',    ar:'هل هو من لعبة فيديو؟',          en:'Is it from a video game?' },
    { key:'human',        ar:'هل هو بشري؟',                   en:'Is it human?' },
    { key:'gender',       ar:'هل هو ذكر؟',                    en:'Is it male?' },
  ],

  // ── 14. Business ─────────────────────────────────────────
  business: [
    { key:'american',     ar:'هل هو أمريكي؟',                  en:'Is it American?' },
    { key:'arab',         ar:'هل هو عربي؟',                   en:'Is it Arab?' },
    { key:'alive',        ar:'هل هو حي؟',                     en:'Is it alive?' },
    { key:'tech',         ar:'هل هو في مجال التكنولوجيا؟',    en:'Is it in the tech industry?' },
    { key:'era_now',      ar:'هل لا يزال نشطاً الآن؟',        en:'Is it still active now?' },
    { key:'historical',   ar:'هل هو شخصية تاريخية؟',          en:'Is it a historical figure?' },
    { key:'british',      ar:'هل هو بريطاني؟',                en:'Is it British?' },
  ],
};

// ──────────────────────────────────────────────────────────────
//  GET NEXT STRUCTURED QUESTION
//  Picks from the correct tree, never repeats, never contradicts
// ──────────────────────────────────────────────────────────────
function getNextStructuredQuestion(session) {
  const S     = inferState(session.turns);
  const asked = new Set(session.turns.map(t => conceptKey(t.question)));
  const lang  = session.language;
  const ar    = lang === 'ar';
  const domain= getDomain(S);

  // Determine which tree to use
  let treeKeys = [];
  if (!domain) {
    treeKeys = ['pre_domain'];
  } else {
    // Use narrowest domain tree + if broad domain still relevant, use it after
    const treeMap = {
      footballer:   ['footballer'],
      basketballer: ['basketballer'],
      tennis:       ['tennis'],
      boxer:        ['boxer'],
      swimmer:      ['swimmer'],
      golfer:       ['swimmer'],   // reuse swimmer tree
      athlete:      ['athlete'],
      actor:        ['actor'],
      singer:       ['singer'],
      director:     ['director'],
      comedian:     ['comedian'],
      entertainer:  ['entertainer'],
      politician:   ['politician'],
      scientist:    ['scientist'],
      business:     ['business'],
      fictional:    ['fictional'],
    };
    treeKeys = treeMap[domain] ?? ['pre_domain'];
  }

  for (const treeKey of treeKeys) {
    const tree = TREE[treeKey] ?? [];
    for (const entry of tree) {
      if (asked.has(entry.key)) continue;                   // already asked
      const q = ar ? entry.ar : entry.en;
      if (contradicts(q, S)) continue;                      // contradicts facts
      if (skipBasedOnDomain(entry.key, S, domain)) continue; // skip irrelevant
      return { key: entry.key, q };
    }
  }

  return null; // tree exhausted — AI takes over
}

// Skip questions that are irrelevant given confirmed sub-domain
function skipBasedOnDomain(key, S, domain) {
  // If we know it's a footballer, skip other sport sub-domains
  if (S.footballer === true && ['basketball','tennis','boxing','swimming','golf'].includes(key)) return true;
  if (S.basketballer=== true && ['football','tennis','boxing','swimming','golf'].includes(key)) return true;
  if (S.tennis_player=== true && ['football','basketball','boxing','swimming','golf'].includes(key)) return true;
  if (S.boxer === true && ['football','basketball','tennis','swimming','golf'].includes(key)) return true;
  if (S.swimmer === true && ['football','basketball','tennis','boxing','golf'].includes(key)) return true;

  // If we know nationality, skip other nationality questions
  if (S.arab === true && ['american','british','french','spanish','portuguese','argentine','brazilian','german','italian','dutch'].includes(key)) return true;
  if (S.arab === false && ['saudi','egyptian','emirati','kuwaiti'].includes(key)) return true;
  if (S.american === true && ['british','french','spanish','portuguese','argentine','brazilian','german','italian'].includes(key)) return true;
  if (S.portuguese === true && ['argentine','brazilian','french','spanish','british','german'].includes(key)) return true;
  if (S.argentine  === true && ['portuguese','brazilian','french','spanish','british','german'].includes(key)) return true;
  if (S.egyptian   === true && ['saudi','emirati','kuwaiti'].includes(key)) return true;
  if (S.saudi      === true && ['egyptian','emirati','kuwaiti'].includes(key)) return true;

  // If alive known, skip alive
  if (S.alive !== null && key === 'alive') return true;

  // If entertainer known, skip actor/singer questions if sub-domain not confirmed yet — keep them
  // If actor confirmed, skip singer/director/comedian sub-domain questions
  if (S.actor === true && ['singer','director','comedian'].includes(key)) return true;
  if (S.singer === true && ['actor','director','comedian'].includes(key)) return true;
  if (S.director === true && ['actor','singer','comedian'].includes(key)) return true;
  if (S.comedian === true && ['actor','singer','director'].includes(key)) return true;

  // If era known
  if (S.era_90s === true && key === 'era_80s') return true;
  if (S.era_80s === true && key === 'era_90s') return true;
  if (S.era_now === true && ['era_90s','era_80s','era_2000s'].includes(key)) return true;

  // If worldcup won, skip ballon_dor separately (different questions, keep both)
  // If marvel confirmed, skip dc/disney
  if (S.marvel === true && ['dc','disney','anime'].includes(key)) return true;
  if (S.dc     === true && ['marvel','disney','anime'].includes(key)) return true;
  if (S.disney === true && ['marvel','dc','anime'].includes(key)) return true;
  if (S.anime  === true && ['marvel','dc','disney'].includes(key)) return true;

  return false;
}

// ──────────────────────────────────────────────────────────────
//  CONCEPT KEY — for dedup tracking
// ──────────────────────────────────────────────────────────────
function conceptKey(text) {
  const q = text.toLowerCase();
  const has = (...kw) => kw.some(k => q.includes(k));
  if (has('حقيقي','real person','واقعي')) return 'reality';
  if (has('رجل','ذكر',' male',' man','boy')) return 'gender';
  if (has('امرأة','أنثى','female','woman','girl')) return 'gender';
  if (has('عربي','arab') && !has('غير','non')) return 'arab';
  if (has('سعودي','saudi')) return 'saudi';
  if (has('مصري','egyptian')) return 'egyptian';
  if (has('إماراتي','اماراتي','emirati')) return 'emirati';
  if (has('كويتي','kuwaiti')) return 'kuwaiti';
  if (has('أمريكي','امريكي','american')) return 'american';
  if (has('بريطاني','إنجليزي','british','english') && !has('أمريكي')) return 'british';
  if (has('فرنسي','french')) return 'french';
  if (has('إسباني','اسباني','spanish')) return 'spanish';
  if (has('برتغالي','portuguese')) return 'portuguese';
  if (has('أرجنتيني','argentine')) return 'argentine';
  if (has('برازيلي','brazilian')) return 'brazilian';
  if (has('ألماني','german')) return 'german';
  if (has('إيطالي','italian')) return 'italian';
  if (has('سويسري','swiss')) return 'swiss';
  if (has('صربي','serbian')) return 'serbian';
  if (has(' حي ','alive','يعيش','living') && !has('متوفى','dead')) return 'alive';
  if (has('متوفى','مات','توفي',' dead','deceased')) return 'alive';
  if (has('تاريخي','historical','قديم','ancient')) return 'historical';
  if (has('رياضي','athlete') && !has('كرة القدم','football','كرة السلة','basketball')) return 'athlete_broad';
  if (has('كرة القدم','football','soccer','لاعب كرة قدم')) return 'football';
  if (has('كرة السلة','basketball','nba')) return 'basketball';
  if (has(' تنس','tennis')) return 'tennis';
  if (has('ملاكم','boxer','boxing')) return 'boxing';
  if (has('سباح','swimmer','swimming')) return 'swimming';
  if (has('غولف','golf')) return 'golf';
  if (has('كأس العالم','world cup')) return 'worldcup';
  if (has('بالون دور','ballon')) return 'ballon_dor';
  if (has('دوري أبطال','champions league','ucl')) return 'champions_league';
  if (has('أوسكار','oscar')) return 'oscar';
  if (has('غرامي','grammy')) return 'grammy';
  if (has('أولمبي','olympic','ميدالية')) return 'olympics';
  if (has('نوبل','nobel')) return 'nobel';
  if (has('فنان','نجم','entertainer','artist') && !has('ممثل','actor','مغني','singer')) return 'entertainer_broad';
  if (has('ممثل','actor','actress','يمثل') && !has('رياضي','athlete')) return 'actor';
  if (has('مغني','مطرب','singer','يغني') && !has('رياضي','athlete')) return 'singer';
  if (has('مخرج','director','إخراج')) return 'director';
  if (has('كوميدي','comedian')) return 'comedian';
  if (has('سياسي','politician','رئيس دول','president') && !has('كرة')) return 'politician';
  if (has('عالم','scientist','مخترع','inventor')) return 'scientist';
  if (has('رجل أعمال','businessman','ثري','مليارد')) return 'business';
  if (has('ملكي','royal','ملك ','أمير','king ','queen','prince')) return 'royalty';
  if (has('كاتب','روائي','شاعر','writer','author','poet')) return 'writer';
  if (has('مهاجم','striker','forward')) return 'striker';
  if (has('حارس','goalkeeper','keeper')) return 'goalkeeper';
  if (has('مدافع','defender')) return 'defender';
  if (has('وسط','midfielder')) return 'midfielder';
  if (has('ريال مدريد','real madrid')) return 'club_real';
  if (has('برشلونة','barcelona','barca')) return 'club_barca';
  if (has('ليفربول','liverpool')) return 'club_liverpool';
  if (has('مانشستر','man utd','man united')) return 'club_manutd';
  if (has('تشيلسي','chelsea')) return 'club_chelsea';
  if (has('الآن','نشط الآن','still active','still playing','currently','لا يزال')) return 'era_now';
  if (has('تسعينيات','90s','nineties')) return 'era_90s';
  if (has('ثمانينيات','80s','eighties')) return 'era_80s';
  if (has('ألفين','2000s')) return 'era_2000s';
  if (has('أكشن','action movie')) return 'action_movies';
  if (has('بطل خارق','superhero') && !has('رياضي','هو')) return 'superhero_role';
  if (has('مسلسل','tv series','tv show','series')) return 'tv_series';
  if (has('هوليود','hollywood')) return 'hollywood';
  if (has('أمريكا الجنوبية','south american')) return 'south_american';
  if (has('أوروبي','european')) return 'european';
  if (has('رئيس','president','head of state')) return 'president';
  if (has('ملك ','king ','أمير','prince','queen')) return 'king';
  if (has('شرير','villain')) return 'villain';
  if (has('مارفل','marvel')) return 'marvel';
  if (has('dc','دي سي')) return 'dc';
  if (has('ديزني','disney')) return 'disney';
  if (has('أنيمي','anime')) return 'anime';
  if (has('يطير','يستطيع الطير','fly','can fly')) return 'can_fly';
  if (has('قوى خارقة','super powers','has powers')) return 'has_powers';
  if (has('من فيلم','from a movie','movie character')) return 'from_movie';
  if (has('لعبة','from a game','video game')) return 'from_game';
  if (has('خيالي','fictional','وهمي')) return 'fictional';
  if (has('كرتون','cartoon','رسوم','animated')) return 'animated';
  if (has('منفرد','solo')) return 'solo';
  if (has('فرقة','band')) return 'band';
  if (has('بوب','pop')) return 'pop';
  if (has('أفلام سينما','cinema','movies') && !has('أكشن')) return 'movies';
  if (has('فيزياء','physics')) return 'physics';
  if (has('طب','medicine')) return 'medicine';
  if (has('تكنولوجيا','technology','tech')) return 'tech';
  if (has('منتخب','national team')) return 'national_team';
  if (has('وزن ثقيل','heavyweight')) return 'heavyweight';
  if (has('غولف','golf')) return 'golf';
  return q.replace(/\s+/g,'_').slice(0,50);
}

// ──────────────────────────────────────────────────────────────
//  CONTRADICTION CHECK
// ──────────────────────────────────────────────────────────────
function contradicts(q, S) {
  const t = q.toLowerCase();
  const has = (...kw) => kw.some(k => t.includes(k));
  if (S.male   === true  && has('امرأة','أنثى','female','woman','girl'))         return true;
  if (S.female === true  && has('رجل','ذكر',' male',' man','boy'))              return true;
  if (S.alive  === true  && has('متوفى','مات','توفي',' dead','deceased'))       return true;
  if (S.alive  === false && has(' حي ','alive','يعيش','لا يزال','still'))       return true;
  if (S.real   === true  && has('خيالي','fiction','كرتون','وهمي','animated'))   return true;
  if (S.fictional=== true&& has('حقيقي','real person','واقعي'))                 return true;
  if (S.arab   === true  && has('أجنبي','غير عربي','non-arab'))                 return true;
  if (S.arab   === false && has('عربي','arab') && !has('غير','non'))            return true;
  if (S.footballer=== true && has('كرة السلة','basketball','تنس','tennis','ملاكم','boxer','سباح','swimmer','غولف','golf')) return true;
  if (S.basketballer===true&& has('كرة القدم','football','تنس','tennis','ملاكم','boxer')) return true;
  if (S.boxer  === true  && has('كرة القدم','football','كرة السلة','basketball','تنس','tennis')) return true;
  if (S.actor  === true  && has('رياضي','athlete','سياسي','politician'))        return true;
  if (S.singer === true  && has('رياضي','athlete','سياسي','politician'))        return true;
  if (S.politician===true&& has('رياضي','athlete','فنان','ممثل','مغني'))       return true;
  return false;
}

// ──────────────────────────────────────────────────────────────
//  AI — ONLY FOR GUESSING
// ──────────────────────────────────────────────────────────────
function buildFactsSummary(S, lang) {
  const ar = lang === 'ar';
  const parts = [];
  const domain = getDomain(S);
  if (domain) parts.push(ar ? `المجال: ${domain}` : `Domain: ${domain}`);
  if (S.male  === true)  parts.push(ar ? 'ذكر'       : 'male');
  if (S.female=== true)  parts.push(ar ? 'أنثى'      : 'female');
  if (S.arab  === true)  parts.push(ar ? 'عربي'      : 'Arab');
  if (S.american===true) parts.push(ar ? 'أمريكي'    : 'American');
  if (S.british===true)  parts.push(ar ? 'بريطاني'   : 'British');
  if (S.french===true)   parts.push(ar ? 'فرنسي'     : 'French');
  if (S.portuguese===true) parts.push(ar ? 'برتغالي' : 'Portuguese');
  if (S.argentine===true)  parts.push(ar ? 'أرجنتيني': 'Argentine');
  if (S.brazilian===true)  parts.push(ar ? 'برازيلي' : 'Brazilian');
  if (S.spanish===true)    parts.push(ar ? 'إسباني'  : 'Spanish');
  if (S.egyptian===true)   parts.push(ar ? 'مصري'    : 'Egyptian');
  if (S.saudi===true)      parts.push(ar ? 'سعودي'   : 'Saudi');
  if (S.alive ===true)   parts.push(ar ? 'حي'        : 'alive');
  if (S.alive ===false)  parts.push(ar ? 'متوفى'     : 'deceased');
  if (S.worldcup===true) parts.push(ar ? 'فاز بكأس العالم' : 'won World Cup');
  if (S.ballon_dor===true) parts.push(ar ? 'فاز بالبالون دور' : "won Ballon d'Or");
  if (S.oscar===true)    parts.push(ar ? 'فاز بأوسكار'  : 'won Oscar');
  if (S.grammy===true)   parts.push(ar ? 'فاز بغرامي'   : 'won Grammy');
  if (S.champions_league===true) parts.push(ar ? 'فاز بدوري أبطال أوروبا' : 'won Champions League');
  if (S.era_now===true)  parts.push(ar ? 'لا يزال نشطاً' : 'still active');
  if (S.era_90s===true)  parts.push(ar ? 'اشتهر في التسعينيات' : 'famous in 90s');
  if (S.era_80s===true)  parts.push(ar ? 'اشتهر في الثمانينيات': 'famous in 80s');
  if (S.historical===true) parts.push(ar ? 'تاريخي قديم' : 'historical');
  if (S.action_movies===true) parts.push(ar ? 'أفلام أكشن' : 'action movies');
  if (S.superhero_role===true) parts.push(ar ? 'لعب دور بطل خارق' : 'played superhero');
  if (S.striker===true)  parts.push(ar ? 'مهاجم'     : 'striker');
  if (S.goalkeeper===true) parts.push(ar ? 'حارس مرمى' : 'goalkeeper');
  if (S.club_real===true) parts.push(ar ? 'لعب في ريال مدريد' : 'played for Real Madrid');
  if (S.club_barca===true) parts.push(ar ? 'لعب في برشلونة' : 'played for Barcelona');
  if (S.club_liverpool===true) parts.push(ar ? 'لعب في ليفربول' : 'played for Liverpool');
  if (S.marvel===true) parts.push(ar ? 'من مارفل' : 'from Marvel');
  if (S.dc===true)     parts.push(ar ? 'من DC'     : 'from DC');
  if (S.disney===true) parts.push(ar ? 'من ديزني'  : 'from Disney');
  if (S.anime===true)  parts.push(ar ? 'من أنيمي'  : 'from anime');
  if (S.villain===true) parts.push(ar ? 'شرير'      : 'villain');
  if (S.hero===true)    parts.push(ar ? 'بطل خارق'  : 'superhero');
  return parts.join(' | ');
}

async function makeGuess(session) {
  if (!openai) return { type:'guess', name: session.language==='ar'?'شخصية مشهورة':'Famous person', confidence:0.2 };

  const S = inferState(session.turns);
  const facts = buildFactsSummary(S, session.language);
  const rejected = session.rejectedGuesses;
  const ar = session.language === 'ar';

  const sysPrompt = ar
    ? `أنت محلل بيانات متخصص في تحديد الشخصيات. بناءً على الحقائق المؤكدة فقط، اختر الشخصية الأكثر احتمالاً.
قواعد صارمة:
- أعطِ اسماً واحداً فقط
- الاسم بالعربية كما هو معروف (مثل "محمد صلاح" لا "صلاح")
- لا تكرر: [${rejected.join(', ')||'لا شيء'}]
- استجابة JSON فقط: {"type":"guess","name":"...","confidence":0.88}`
    : `You are a character identification expert. Based ONLY on confirmed facts, pick the single most likely character.
Rules:
- One name only, spelled as commonly known
- NEVER repeat: [${rejected.join(', ')||'none'}]
- JSON only: {"type":"guess","name":"...","confidence":0.88}`;

  const userMsg = `Confirmed facts: ${facts || 'none yet'}
Q&A history:
${session.turns.map((t,i)=>`Q${i+1}: ${t.question} → ${t.answer}`).join('\n')}
Rejected: ${rejected.join(', ')||'none'}
Best single guess now.`;

  try {
    const resp = await openai.chat.completions.create({
      model, temperature:0.15, max_tokens:80,
      response_format: { type:'json_object' },
      messages: [
        { role:'system', content:sysPrompt },
        { role:'user',   content:userMsg  },
      ],
    });
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '{}');
    const name = String(parsed.name ?? '').trim();
    if (!name || rejected.includes(name)) throw new Error('bad guess');
    return {
      type:'guess', name,
      confidence: typeof parsed.confidence==='number' ? Math.min(1,Math.max(0,parsed.confidence)) : 0.75,
    };
  } catch {
    return { type:'guess', name:ar?'شخصية مشهورة':'Famous person', confidence:0.2 };
  }
}

// ──────────────────────────────────────────────────────────────
//  MAIN ENGINE  — structured questions + AI guessing
// ──────────────────────────────────────────────────────────────
async function runEngine(session) {
  const S = inferState(session.turns);

  // Must guess?
  if (session.questionsSincePhaseReset >= session.maxQuestionsBeforeGuess) {
    return await makeGuess(session);
  }

  // Can't guess yet — get next structured question
  if (session.questionsSincePhaseReset < session.minQuestionsBeforeGuess) {
    const next = getNextStructuredQuestion(session);
    if (next) return { type:'question', text: next.q };
    // Structured tree exhausted early — use AI guess if we've asked enough, else fallback
    if (session.questionsSincePhaseReset >= 5) return await makeGuess(session);
    return { type:'question', text: session.language==='ar' ? 'هل هو حي؟' : 'Is it still alive?' };
  }

  // In the window (canGuess): get next structured question
  const next = getNextStructuredQuestion(session);
  if (!next) {
    // Tree exhausted — guess now
    return await makeGuess(session);
  }

  // We have more structured questions — but should we guess?
  // Let AI decide via confidence, but only if we have strong facts
  const facts = buildFactsSummary(S, session.language);
  const hasEnoughFacts = session.turns.filter(t=>t.answer==='yes').length >= 5;
  if (hasEnoughFacts && openai) {
    // Quick confidence check
    const check = await openai.chat.completions.create({
      model, temperature:0.1, max_tokens:60,
      response_format:{ type:'json_object' },
      messages:[
        { role:'system', content:'Given confirmed facts, are you confident enough (≥0.88) to guess the exact character? Return {"confident":true/false}' },
        { role:'user',   content:`Facts: ${facts}\nRejected: ${session.rejectedGuesses.join(',')||'none'}` },
      ],
    }).catch(() => null);
    if (check) {
      try {
        const r = JSON.parse(check.choices[0]?.message?.content??'{}');
        if (r.confident === true) return await makeGuess(session);
      } catch { /* ignore */ }
    }
  }

  return { type:'question', text: next.q };
}

// ──────────────────────────────────────────────────────────────
//  WIKIPEDIA
// ──────────────────────────────────────────────────────────────
async function fetchWiki(name, lang) {
  const l = lang==='ar' ? 'ar' : 'en';
  const title = encodeURIComponent(String(name).replace(/ /g,'_'));
  try {
    const res = await fetch(
      `https://${l}.wikipedia.org/api/rest_v1/page/summary/${title}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error('not found');
    const j = await res.json();
    return {
      title:      j.title ?? name,
      extract:    j.extract ?? '',
      imageURL:   j.thumbnail?.source ?? null,
      articleURL: j.content_urls?.desktop?.page ?? `https://${l}.wikipedia.org/wiki/${title}`,
    };
  } catch {
    return {
      title: name,
      extract: lang==='ar' ? 'لا توجد معلومات متاحة' : 'No information available',
      imageURL: null,
      articleURL: `https://${l}.wikipedia.org/wiki/${title}`,
    };
  }
}

// ──────────────────────────────────────────────────────────────
//  ROUTES
// ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok:true, model, hasOpenAI:Boolean(openai) });
});

// POST /api/game/start  — { language:"ar"|"en" }
// Returns: { sessionId, type:"question", text:"..." }
app.post('/api/game/start', async (req, res) => {
  try {
    const language = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();
    const session = {
      id:sessionId, language,
      turns:[], rejectedGuesses:[],
      guessStreak:0, questionsSincePhaseReset:0,
      minQuestionsBeforeGuess: INITIAL_MIN,
      maxQuestionsBeforeGuess: INITIAL_MAX,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(sessionId, session);
    const result = await runEngine(session);
    return res.json({ sessionId, ...result });
  } catch(e) {
    console.error('start:', e);
    return res.status(500).json({ error:'Failed to start game' });
  }
});

// POST /api/game/answer  — { sessionId, question, answer:"yes"|"no"|"maybe"|"dont_know" }
// Returns: { type:"question", text } OR { type:"guess", name, confidence }
app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body ?? {};
    const session = sessions.get(String(sessionId??''));
    if (!session) return res.status(404).json({ error:'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL_MS;
    session.turns.push({ question:String(question??''), answer:normalize(answer) });
    session.questionsSincePhaseReset += 1;

    return res.json(await runEngine(session));
  } catch(e) {
    console.error('answer:', e);
    return res.status(500).json({ error:'Failed to process answer' });
  }
});

// POST /api/game/guess-confirm  — { sessionId, guessName, correct:true|false }
// Flow:
//   correct=true       → { type:"revealed", guessName, wiki:{...} }
//   wrong, streak<3    → immediate next guess  { type:"guess", name, confidence }
//   wrong, streak>=3   → reset phase, back to domain-focused questions
app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body ?? {};
    const session = sessions.get(String(sessionId??''));
    if (!session) return res.status(404).json({ error:'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL_MS;

    if (correct) {
      const wiki = await fetchWiki(String(guessName??''), session.language);
      session.guessStreak = 0;
      session.questionsSincePhaseReset = 0;
      session.minQuestionsBeforeGuess = INITIAL_MIN;
      session.maxQuestionsBeforeGuess = INITIAL_MAX;
      return res.json({ type:'revealed', guessName, wiki });
    }

    if (guessName) session.rejectedGuesses.push(String(guessName));
    session.guessStreak += 1;

    // Guesses 2 & 3: try again immediately (no questions between)
    if (session.guessStreak < MAX_CONSECUTIVE_GUESSES) {
      return res.json(await makeGuess(session));
    }

    // 3 wrong guesses → back to domain-focused questions (5–8)
    // IMPORTANT: we do NOT reset turns — domain context is preserved
    session.guessStreak = 0;
    session.questionsSincePhaseReset = 0;
    session.minQuestionsBeforeGuess = FOLLOWUP_MIN;
    session.maxQuestionsBeforeGuess = FOLLOWUP_MAX;

    return res.json(await runEngine(session));
  } catch(e) {
    console.error('guess-confirm:', e);
    return res.status(500).json({ error:'Failed to confirm guess' });
  }
});

// GET /api/wiki?name=...&language=ar
app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name ?? '');
    const lang = req.query.language === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ error:'name is required' });
    return res.json(await fetchWiki(name, lang));
  } catch(e) {
    console.error('wiki:', e);
    return res.status(500).json({ error:'Failed to fetch wiki' });
  }
});

// ──────────────────────────────────────────────────────────────
//  START
// ──────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`✅ Magic Ball  →  http://localhost:${port}`);
  console.log(`🤖 Model: ${model} | OpenAI: ${Boolean(openai)}`);
  console.log(`Phase 1: ${INITIAL_MIN}–${INITIAL_MAX} q's → up to ${MAX_CONSECUTIVE_GUESSES} guesses`);
  console.log(`Phase 2: ${FOLLOWUP_MIN}–${FOLLOWUP_MAX} q's (same domain) → guess again`);
});
