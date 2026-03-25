/**
 * Magic Ball — "20 Questions" AI character guessing game
 * Architecture:
 *   • Questions come from STATIC ordered lists per domain (zero repetition, zero drift)
 *   • GPT-4o is used ONLY for making the final guess
 *   • Domain is locked the moment a broad category is confirmed
 *   • Sub-domain narrows the list further (footballer ≠ boxer ≠ swimmer)
 *   • State is stored explicitly in the session — no re-parsing of question text
 */

import express from 'express';
import cors    from 'cors';
import OpenAI  from 'openai';
import crypto  from 'node:crypto';

const app  = express();
app.use(cors());
app.use(express.json());

const PORT  = Number(process.env.PORT  || 3001);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const INITIAL_MIN  = 9;
const INITIAL_MAX  = 15;
const FOLLOWUP_MIN = 5;
const FOLLOWUP_MAX = 8;
const MAX_GUESSES  = 3;          // wrong guesses before going back to questions
const SESSION_TTL  = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
//  QUESTION BANK
//  Format per entry: { key, ar, en }
//  • key  = unique concept id — used to prevent repeats and drive state updates
//  • ar   = Arabic question text
//  • en   = English question text
//  Questions are tried in order; already-asked keys and contradictions are skipped.
// ─────────────────────────────────────────────────────────────────────────────
const Q = {

  // ── STEP 1: Broad category (asked before domain is known) ─────────────────
  broad: [
    { key:'real',        ar:'هل هو شخص حقيقي؟',              en:'Is it a real person?' },
    { key:'male',        ar:'هل هو رجل؟',                    en:'Is it male?' },
    { key:'athlete',     ar:'هل هو رياضي؟',                  en:'Is it an athlete?' },
    { key:'entertainer', ar:'هل هو فنان أو نجم؟',            en:'Is it an entertainer?' },
    { key:'politician',  ar:'هل هو سياسي؟',                  en:'Is it a politician?' },
    { key:'scientist',   ar:'هل هو عالم أو مخترع؟',          en:'Is it a scientist or inventor?' },
    { key:'business',    ar:'هل هو رجل أعمال مشهور؟',        en:'Is it a famous businessperson?' },
    { key:'royalty',     ar:'هل هو ملكي (ملك أو أمير)؟',     en:'Is it royalty (king/queen/prince)?' },
    { key:'writer',      ar:'هل هو كاتب أو شاعر؟',           en:'Is it a writer or poet?' },
    { key:'alive',       ar:'هل هو حي؟',                     en:'Is it alive?' },
    { key:'historical',  ar:'هل هو شخصية تاريخية قديمة؟',    en:'Is it an ancient historical figure?' },
    { key:'fictional',   ar:'هل هو شخصية خيالية أو كرتونية؟',en:'Is it a fictional or animated character?' },
  ],

  // ── STEP 2a: Athlete — find the sport ─────────────────────────────────────
  athlete_sport: [
    { key:'sport_football',   ar:'هل يلعب كرة القدم؟',       en:'Does it play football/soccer?' },
    { key:'sport_basketball', ar:'هل يلعب كرة السلة؟',       en:'Does it play basketball?' },
    { key:'sport_tennis',     ar:'هل يلعب التنس؟',           en:'Does it play tennis?' },
    { key:'sport_boxing',     ar:'هل هو ملاكم؟',             en:'Is it a boxer?' },
    { key:'sport_swimming',   ar:'هل هو سباح؟',              en:'Is it a swimmer?' },
    { key:'sport_golf',       ar:'هل يلعب الغولف؟',          en:'Does it play golf?' },
    { key:'sport_other',      ar:'هل هو رياضي أولمبي؟',      en:'Is it an Olympic athlete?' },
  ],

  // ── STEP 2b: Entertainer — find the sub-type ──────────────────────────────
  entertainer_type: [
    { key:'ent_actor',    ar:'هل هو ممثل؟',                  en:'Is it an actor or actress?' },
    { key:'ent_singer',   ar:'هل هو مغني؟',                  en:'Is it a singer?' },
    { key:'ent_director', ar:'هل هو مخرج أفلام؟',           en:'Is it a film director?' },
    { key:'ent_comedian', ar:'هل هو كوميديان؟',              en:'Is it a comedian?' },
    { key:'ent_presenter',ar:'هل هو مقدم أو مذيع؟',         en:'Is it a TV presenter or host?' },
  ],

  // ── STEP 3: Footballer ────────────────────────────────────────────────────
  footballer: [
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'nat_s_american',ar:'هل هو من أمريكا الجنوبية؟',   en:'Is it South American?' },
    { key:'nat_european',  ar:'هل هو أوروبي؟',               en:'Is it European?' },
    { key:'ach_worldcup',  ar:'هل فاز بكأس العالم؟',         en:'Did it win the World Cup?' },
    { key:'ach_ballondor', ar:'هل فاز بجائزة البالون دور؟',  en:"Did it win the Ballon d'Or?" },
    { key:'ach_ucl',       ar:'هل فاز بدوري أبطال أوروبا؟', en:'Did it win the Champions League?' },
    { key:'era_active',    ar:'هل لا يزال يلعب الآن؟',       en:'Is it still playing now?' },
    { key:'nat_portuguese',ar:'هل هو برتغالي؟',              en:'Is it Portuguese?' },
    { key:'nat_argentine', ar:'هل هو أرجنتيني؟',             en:'Is it Argentine?' },
    { key:'nat_brazilian', ar:'هل هو برازيلي؟',              en:'Is it Brazilian?' },
    { key:'nat_french',    ar:'هل هو فرنسي؟',                en:'Is it French?' },
    { key:'nat_spanish',   ar:'هل هو إسباني؟',               en:'Is it Spanish?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'nat_german',    ar:'هل هو ألماني؟',               en:'Is it German?' },
    { key:'nat_egyptian',  ar:'هل هو مصري؟',                 en:'Is it Egyptian?' },
    { key:'nat_saudi',     ar:'هل هو سعودي؟',                en:'Is it Saudi?' },
    { key:'pos_striker',   ar:'هل هو مهاجم؟',                en:'Is it a striker/forward?' },
    { key:'pos_goalkeeper',ar:'هل هو حارس مرمى؟',            en:'Is it a goalkeeper?' },
    { key:'pos_midfielder',ar:'هل هو لاعب وسط؟',             en:'Is it a midfielder?' },
    { key:'pos_defender',  ar:'هل هو مدافع؟',                en:'Is it a defender?' },
    { key:'club_real',     ar:'هل لعب في ريال مدريد؟',       en:'Did it play for Real Madrid?' },
    { key:'club_barca',    ar:'هل لعب في برشلونة؟',          en:'Did it play for Barcelona?' },
    { key:'club_manu',     ar:'هل لعب في مانشستر يونايتد؟',  en:'Did it play for Man United?' },
    { key:'club_liver',    ar:'هل لعب في ليفربول؟',          en:'Did it play for Liverpool?' },
    { key:'era_90s',       ar:'هل اشتهر في التسعينيات؟',     en:'Did it rise to fame in the 90s?' },
    { key:'nat_italian',   ar:'هل هو إيطالي؟',               en:'Is it Italian?' },
    { key:'nat_dutch',     ar:'هل هو هولندي؟',               en:'Is it Dutch?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Basketballer ─────────────────────────────────────────────────
  basketballer: [
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'era_active',    ar:'هل لا يزال يلعب الآن؟',       en:'Is it still playing now?' },
    { key:'era_90s',       ar:'هل اشتهر في التسعينيات؟',     en:'Did it rise to fame in the 90s?' },
    { key:'ach_olympics',  ar:'هل فاز بميدالية أولمبية؟',    en:'Did it win an Olympic medal?' },
    { key:'nat_european',  ar:'هل هو أوروبي؟',               en:'Is it European?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Tennis player ────────────────────────────────────────────────
  tennis: [
    { key:'nat_european',  ar:'هل هو أوروبي؟',               en:'Is it European?' },
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_spanish',   ar:'هل هو إسباني؟',               en:'Is it Spanish?' },
    { key:'nat_swiss',     ar:'هل هو سويسري؟',               en:'Is it Swiss?' },
    { key:'nat_serbian',   ar:'هل هو صربي؟',                 en:'Is it Serbian?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'era_active',    ar:'هل لا يزال يلعب الآن؟',       en:'Is it still playing now?' },
    { key:'ach_grandslam', ar:'هل فاز ببطولة غراند سلام؟',   en:'Did it win a Grand Slam?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Boxer ────────────────────────────────────────────────────────
  boxer: [
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'era_active',    ar:'هل لا يزال يتنافس الآن؟',     en:'Is it still competing now?' },
    { key:'era_90s',       ar:'هل اشتهر في التسعينيات؟',     en:'Did it rise to fame in the 90s?' },
    { key:'ach_olympics',  ar:'هل فاز بميدالية أولمبية؟',    en:'Did it win an Olympic gold?' },
    { key:'weight_heavy',  ar:'هل هو في وزن ثقيل؟',         en:'Is it a heavyweight?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Swimmer ──────────────────────────────────────────────────────
  swimmer: [
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_european',  ar:'هل هو أوروبي؟',               en:'Is it European?' },
    { key:'ach_olympics',  ar:'هل فاز بميدالية أولمبية ذهبية؟',en:'Did it win Olympic gold?' },
    { key:'era_active',    ar:'هل لا يزال يسبح الآن؟',       en:'Is it still competing now?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Actor ────────────────────────────────────────────────────────
  actor: [
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'nat_french',    ar:'هل هو فرنسي؟',                en:'Is it French?' },
    { key:'ach_oscar',     ar:'هل فاز بجائزة أوسكار؟',       en:'Did it win an Oscar?' },
    { key:'work_action',   ar:'هل يمثل في أفلام أكشن؟',      en:'Is it known for action movies?' },
    { key:'work_superhero',ar:'هل مثّل دور بطل خارق؟',       en:'Did it play a superhero?' },
    { key:'work_tv',       ar:'هل اشتهر في مسلسل تلفزيوني؟',en:'Is it famous from a TV series?' },
    { key:'era_active',    ar:'هل لا يزال يمثل الآن؟',       en:'Is it still acting now?' },
    { key:'era_90s',       ar:'هل اشتهر في التسعينيات؟',     en:'Did it rise to fame in the 90s?' },
    { key:'era_80s',       ar:'هل اشتهر في الثمانينيات؟',    en:'Did it rise to fame in the 80s?' },
    { key:'nat_australian',ar:'هل هو أسترالي؟',              en:'Is it Australian?' },
    { key:'nat_italian',   ar:'هل هو إيطالي؟',               en:'Is it Italian?' },
    { key:'nat_egyptian',  ar:'هل هو مصري؟',                 en:'Is it Egyptian?' },
    { key:'nat_saudi',     ar:'هل هو سعودي؟',                en:'Is it Saudi?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
    { key:'work_comedy',   ar:'هل يمثل في أفلام كوميدية؟',   en:'Is it known for comedy films?' },
    { key:'work_drama',    ar:'هل يمثل في أفلام دراما؟',     en:'Is it known for drama films?' },
  ],

  // ── STEP 3: Singer ───────────────────────────────────────────────────────
  singer: [
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'nat_egyptian',  ar:'هل هو مصري؟',                 en:'Is it Egyptian?' },
    { key:'nat_saudi',     ar:'هل هو سعودي؟',                en:'Is it Saudi?' },
    { key:'nat_kuwaiti',   ar:'هل هو كويتي؟',                en:'Is it Kuwaiti?' },
    { key:'nat_emirati',   ar:'هل هو إماراتي؟',              en:'Is it Emirati?' },
    { key:'nat_french',    ar:'هل هو فرنسي؟',                en:'Is it French?' },
    { key:'nat_latin',     ar:'هل هو من أمريكا اللاتينية؟',  en:'Is it Latin American?' },
    { key:'ach_grammy',    ar:'هل فاز بجائزة غرامي؟',        en:'Did it win a Grammy?' },
    { key:'era_active',    ar:'هل لا يزال يغني الآن؟',       en:'Is it still singing now?' },
    { key:'era_90s',       ar:'هل اشتهر في التسعينيات؟',     en:'Did it rise to fame in the 90s?' },
    { key:'era_80s',       ar:'هل اشتهر في الثمانينيات؟',    en:'Did it rise to fame in the 80s?' },
    { key:'style_pop',     ar:'هل يغني موسيقى بوب؟',         en:'Is it a pop singer?' },
    { key:'style_band',    ar:'هل هو في فرقة موسيقية؟',      en:'Is it part of a band?' },
    { key:'style_rap',     ar:'هل يغني راب أو هيب هوب؟',     en:'Is it a rapper or hip-hop artist?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Director ─────────────────────────────────────────────────────
  director: [
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'ach_oscar',     ar:'هل فاز بأوسكار أفضل مخرج؟',  en:'Did it win Best Director Oscar?' },
    { key:'work_action',   ar:'هل يخرج أفلام أكشن وإثارة؟',  en:'Is it known for action/thriller films?' },
    { key:'work_scifi',    ar:'هل يخرج أفلام خيال علمي؟',    en:'Is it known for sci-fi films?' },
    { key:'era_active',    ar:'هل لا يزال يخرج الآن؟',       en:'Is it still directing now?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Comedian ─────────────────────────────────────────────────────
  comedian: [
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'work_tv',       ar:'هل اشتهر في برنامج تلفزيوني؟',en:'Is it famous from a TV show?' },
    { key:'work_standup',  ar:'هل هو ستاند-أب كوميدي؟',      en:'Is it a stand-up comedian?' },
    { key:'era_active',    ar:'هل لا يزال نشطاً الآن؟',      en:'Is it still active now?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Politician ───────────────────────────────────────────────────
  politician: [
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'nat_french',    ar:'هل هو فرنسي؟',                en:'Is it French?' },
    { key:'nat_russian',   ar:'هل هو روسي؟',                 en:'Is it Russian?' },
    { key:'nat_saudi',     ar:'هل هو سعودي؟',                en:'Is it Saudi?' },
    { key:'nat_egyptian',  ar:'هل هو مصري؟',                 en:'Is it Egyptian?' },
    { key:'role_president',ar:'هل كان رئيساً لدولة؟',        en:'Did it serve as a country president?' },
    { key:'role_king',     ar:'هل هو ملك أو أمير؟',          en:'Is it a king, queen, or prince?' },
    { key:'role_minister', ar:'هل كان وزيراً أو رئيس وزراء؟',en:'Was it a prime minister or minister?' },
    { key:'era_active',    ar:'هل لا يزال في منصبه الآن؟',   en:'Is it still in office now?' },
    { key:'historical',    ar:'هل هو شخصية تاريخية قديمة؟',  en:'Is it an ancient historical figure?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Scientist ────────────────────────────────────────────────────
  scientist: [
    { key:'historical',    ar:'هل هو شخصية تاريخية؟',        en:'Is it a historical figure?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'nat_german',    ar:'هل هو ألماني؟',               en:'Is it German?' },
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'ach_nobel',     ar:'هل فاز بجائزة نوبل؟',         en:'Did it win a Nobel Prize?' },
    { key:'field_physics', ar:'هل هو في مجال الفيزياء؟',     en:'Is it known for physics?' },
    { key:'field_medicine',ar:'هل هو في مجال الطب؟',         en:'Is it known for medicine?' },
    { key:'field_tech',    ar:'هل هو في مجال التكنولوجيا؟',  en:'Is it known for technology?' },
    { key:'field_math',    ar:'هل هو في مجال الرياضيات؟',    en:'Is it known for mathematics?' },
  ],

  // ── STEP 3: Business ─────────────────────────────────────────────────────
  business: [
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'field_tech',    ar:'هل هو في مجال التكنولوجيا؟',  en:'Is it in the tech industry?' },
    { key:'era_active',    ar:'هل لا يزال نشطاً الآن؟',      en:'Is it still active now?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
    { key:'historical',    ar:'هل هو شخصية تاريخية؟',        en:'Is it a historical figure?' },
  ],

  // ── STEP 3: Royalty ──────────────────────────────────────────────────────
  royalty: [
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'nat_european',  ar:'هل هو أوروبي؟',               en:'Is it European?' },
    { key:'nat_saudi',     ar:'هل هو سعودي؟',                en:'Is it Saudi?' },
    { key:'era_active',    ar:'هل لا يزال في منصبه؟',        en:'Is it still in power?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Writer ───────────────────────────────────────────────────────
  writer: [
    { key:'nat_arab',      ar:'هل هو عربي؟',                 en:'Is it Arab?' },
    { key:'nat_british',   ar:'هل هو بريطاني؟',              en:'Is it British?' },
    { key:'nat_american',  ar:'هل هو أمريكي؟',               en:'Is it American?' },
    { key:'nat_french',    ar:'هل هو فرنسي؟',                en:'Is it French?' },
    { key:'type_novelist', ar:'هل هو روائي (كاتب روايات)؟',  en:'Is it a novelist?' },
    { key:'type_poet',     ar:'هل هو شاعر؟',                 en:'Is it a poet?' },
    { key:'ach_nobel',     ar:'هل فاز بجائزة نوبل للأدب؟',   en:'Did it win the Nobel Prize in Literature?' },
    { key:'historical',    ar:'هل هو شخصية تاريخية؟',        en:'Is it a historical figure?' },
    { key:'alive',         ar:'هل هو حي؟',                   en:'Is it alive?' },
  ],

  // ── STEP 3: Fictional / Animated character ───────────────────────────────
  fictional: [
    { key:'fic_superhero', ar:'هل هو بطل خارق؟',             en:'Is it a superhero?' },
    { key:'fic_villain',   ar:'هل هو شرير رئيسي؟',           en:'Is it a main villain?' },
    { key:'fic_marvel',    ar:'هل هو من عالم مارفل؟',         en:'Is it from Marvel?' },
    { key:'fic_dc',        ar:'هل هو من عالم DC؟',           en:'Is it from DC Comics?' },
    { key:'fic_disney',    ar:'هل هو من ديزني؟',             en:'Is it from Disney?' },
    { key:'fic_anime',     ar:'هل هو من أنيمي ياباني؟',      en:'Is it from a Japanese anime?' },
    { key:'fic_movie',     ar:'هل هو من فيلم سينمائي؟',      en:'Is it from a movie?' },
    { key:'fic_game',      ar:'هل هو من لعبة فيديو؟',        en:'Is it from a video game?' },
    { key:'fic_fly',       ar:'هل يستطيع الطيران؟',           en:'Can it fly?' },
    { key:'fic_powers',    ar:'هل لديه قوى خارقة؟',          en:'Does it have superpowers?' },
    { key:'fic_human',     ar:'هل هو بشري؟',                 en:'Is it human?' },
    { key:'male',          ar:'هل هو ذكر؟',                  en:'Is it male?' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
//  DOMAIN → QUESTION LIST MAPPING
//  Once domain is locked, ONLY these lists are consulted (in order)
// ─────────────────────────────────────────────────────────────────────────────
const DOMAIN_LISTS = {
  footballer:   ['footballer'],
  basketballer: ['basketballer'],
  tennis:       ['tennis'],
  boxer:        ['boxer'],
  swimmer:      ['swimmer'],
  athlete:      ['athlete_sport'],           // broad athlete before sport known
  actor:        ['actor'],
  singer:       ['singer'],
  director:     ['director'],
  comedian:     ['comedian'],
  entertainer:  ['entertainer_type'],        // broad entertainer before type known
  politician:   ['politician'],
  scientist:    ['scientist'],
  business:     ['business'],
  royalty:      ['royalty'],
  writer:       ['writer'],
  fictional:    ['fictional'],
};

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION STORE
// ─────────────────────────────────────────────────────────────────────────────
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}, 5 * 60 * 1000);

function newSession(language) {
  return {
    language,
    turns: [],                // { key, question, answer }
    askedKeys: new Set(),     // fast O(1) dedup — keys of all questions ever asked
    pendingKey: null,         // key of the question that was just sent, waiting for answer
    // Confirmed domain info (updated as answers come in)
    domain: null,             // broad: 'athlete' | 'entertainer' | 'politician' | ...
    subDomain: null,          // narrow: 'footballer' | 'actor' | 'singer' | ...
    // Confirmed facts (updated as answers come in)
    facts: {},                // key → true/false
    rejectedGuesses: [],
    guessStreak: 0,
    questionsThisPhase: 0,
    minQ: INITIAL_MIN,
    maxQ: INITIAL_MAX,
    expiresAt: Date.now() + SESSION_TTL,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATE UPDATE
//  Called after each answer to lock domain/subDomain and store facts
// ─────────────────────────────────────────────────────────────────────────────
function applyAnswer(session, key, answer) {
  const yes = answer === 'yes';
  const no  = answer === 'no';

  if (yes) session.facts[key] = true;
  if (no)  session.facts[key] = false;

  // Broad domain locking (only set if not already set)
  if (!session.domain) {
    if (key === 'athlete'     && yes) session.domain = 'athlete';
    if (key === 'entertainer' && yes) session.domain = 'entertainer';
    if (key === 'politician'  && yes) session.domain = 'politician';
    if (key === 'scientist'   && yes) session.domain = 'scientist';
    if (key === 'business'    && yes) session.domain = 'business';
    if (key === 'royalty'     && yes) session.domain = 'royalty';
    if (key === 'writer'      && yes) session.domain = 'writer';
    if (key === 'fictional'   && yes) session.domain = 'fictional';
    // If answer is 'no' for multiple domains, it stays null until a yes
  }

  // Sub-domain locking (sport)
  if (!session.subDomain) {
    if (key === 'sport_football'   && yes) { session.subDomain = 'footballer';   session.domain = 'athlete'; }
    if (key === 'sport_basketball' && yes) { session.subDomain = 'basketballer'; session.domain = 'athlete'; }
    if (key === 'sport_tennis'     && yes) { session.subDomain = 'tennis';       session.domain = 'athlete'; }
    if (key === 'sport_boxing'     && yes) { session.subDomain = 'boxer';        session.domain = 'athlete'; }
    if (key === 'sport_swimming'   && yes) { session.subDomain = 'swimmer';      session.domain = 'athlete'; }
    if (key === 'sport_golf'       && yes) { session.subDomain = 'golfer';       session.domain = 'athlete'; }
    // Sub-domain locking (entertainer)
    if (key === 'ent_actor'    && yes) { session.subDomain = 'actor';     session.domain = 'entertainer'; }
    if (key === 'ent_singer'   && yes) { session.subDomain = 'singer';    session.domain = 'entertainer'; }
    if (key === 'ent_director' && yes) { session.subDomain = 'director';  session.domain = 'entertainer'; }
    if (key === 'ent_comedian' && yes) { session.subDomain = 'comedian';  session.domain = 'entertainer'; }
    if (key === 'ent_presenter'&& yes) { session.subDomain = 'comedian';  session.domain = 'entertainer'; } // reuse comedian list
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEXT QUESTION SELECTOR
//  Returns the next unasked question from the correct list, or null if exhausted
// ─────────────────────────────────────────────────────────────────────────────
function nextQuestion(session) {
  const { domain, subDomain, askedKeys, facts, language: lang } = session;
  const ar = lang === 'ar';

  // Decide which lists to search (in order)
  let listNames;
  if (subDomain && DOMAIN_LISTS[subDomain]) {
    listNames = DOMAIN_LISTS[subDomain];
  } else if (domain && DOMAIN_LISTS[domain]) {
    listNames = DOMAIN_LISTS[domain];
  } else {
    listNames = ['broad'];
  }

  for (const listName of listNames) {
    const list = Q[listName] ?? [];
    for (const entry of list) {
      if (askedKeys.has(entry.key)) continue;              // already asked
      if (!shouldAsk(entry.key, session))  continue;       // contradicted by facts
      return { key: entry.key, text: ar ? entry.ar : entry.en };
    }
  }

  return null; // all lists exhausted
}

// Returns false if this question is pointless given what we know
function shouldAsk(key, session) {
  const f = session.facts;

  // Nationality contradictions
  const nationKeys = ['nat_arab','nat_american','nat_british','nat_french','nat_spanish',
    'nat_portuguese','nat_argentine','nat_brazilian','nat_german','nat_italian','nat_dutch',
    'nat_russian','nat_australian','nat_swiss','nat_serbian','nat_latin','nat_egyptian',
    'nat_saudi','nat_kuwaiti','nat_emirati'];
  const knownNat = nationKeys.find(k => f[k] === true);
  if (knownNat && nationKeys.includes(key) && key !== knownNat) return false;

  // Arab = true → skip non-Arab nationalities
  if (f['nat_arab'] === true && ['nat_american','nat_british','nat_french','nat_spanish',
    'nat_portuguese','nat_argentine','nat_brazilian','nat_german','nat_italian',
    'nat_dutch','nat_russian','nat_australian','nat_swiss','nat_serbian','nat_latin'].includes(key)) return false;

  // Arab = false → skip Arab sub-nationalities
  if (f['nat_arab'] === false && ['nat_egyptian','nat_saudi','nat_kuwaiti','nat_emirati'].includes(key)) return false;

  // S.American = true → skip European nationals
  if (f['nat_s_american'] === true && ['nat_french','nat_spanish','nat_british','nat_german',
    'nat_italian','nat_dutch','nat_russian'].includes(key)) return false;

  // European = true → skip American/Arab/Latin
  if (f['nat_european'] === true && ['nat_american','nat_arab','nat_latin'].includes(key)) return false;

  // Sub-domain: if footballer, skip other sport questions
  const sportKeys = ['sport_football','sport_basketball','sport_tennis','sport_boxing','sport_swimming','sport_golf','sport_other'];
  const knownSport = sportKeys.find(k => f[k] === true);
  if (knownSport && sportKeys.includes(key) && key !== knownSport) return false;

  // Sub-domain: if actor, skip other entertainer types
  const entKeys = ['ent_actor','ent_singer','ent_director','ent_comedian','ent_presenter'];
  const knownEnt = entKeys.find(k => f[k] === true);
  if (knownEnt && entKeys.includes(key) && key !== knownEnt) return false;

  // Alive/dead contradictions
  if (f['alive'] === true  && key === 'historical') return false;
  if (f['alive'] === false && key === 'era_active')  return false;
  if (f['historical'] === true && key === 'era_active') return false;

  // Era contradictions
  if (f['era_active'] === true && ['era_90s','era_80s'].includes(key)) return false;
  if (f['era_90s']    === true && key === 'era_80s') return false;
  if (f['era_80s']    === true && key === 'era_90s') return false;

  // Fictional contradictions
  if (f['real'] === true  && ['fictional','fic_marvel','fic_dc','fic_disney','fic_anime','fic_superhero','fic_villain','fic_fly','fic_powers','fic_game','fic_movie','fic_human'].includes(key)) return false;
  if (f['fictional'] === true && ['real','athlete','entertainer','politician','scientist','business','royalty','writer'].includes(key)) return false;

  // Fictional sub-type contradictions
  if (f['fic_marvel'] === true  && ['fic_dc','fic_disney','fic_anime'].includes(key)) return false;
  if (f['fic_dc']     === true  && ['fic_marvel','fic_disney','fic_anime'].includes(key)) return false;
  if (f['fic_disney'] === true  && ['fic_marvel','fic_dc','fic_anime'].includes(key)) return false;
  if (f['fic_anime']  === true  && ['fic_marvel','fic_dc','fic_disney'].includes(key)) return false;

  // Domain contradictions — if one broad domain confirmed, skip others
  const domainKeys = ['athlete','entertainer','politician','scientist','business','royalty','writer','fictional'];
  const knownDomain = domainKeys.find(k => f[k] === true);
  if (knownDomain && domainKeys.includes(key) && key !== knownDomain) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  FACTS SUMMARY for GPT-4o guess prompt
// ─────────────────────────────────────────────────────────────────────────────
function factsSummary(session) {
  const f = session.facts;
  const parts = [];
  const add = (cond, label) => { if (cond) parts.push(label); };

  add(session.subDomain, `sub-domain: ${session.subDomain}`);
  add(session.domain && !session.subDomain, `domain: ${session.domain}`);
  add(f.male    === true,  'male');
  add(f.male    === false, 'female');
  add(f.alive   === true,  'alive');
  add(f.alive   === false, 'deceased');
  add(f.historical=== true,'historical figure');
  add(f.nat_arab=== true,  'Arab');
  add(f.nat_american===true,'American');
  add(f.nat_british===true,'British');
  add(f.nat_french===true, 'French');
  add(f.nat_spanish===true,'Spanish');
  add(f.nat_portuguese===true,'Portuguese');
  add(f.nat_argentine===true,'Argentine');
  add(f.nat_brazilian===true,'Brazilian');
  add(f.nat_german===true, 'German');
  add(f.nat_italian===true,'Italian');
  add(f.nat_russian===true,'Russian');
  add(f.nat_australian===true,'Australian');
  add(f.nat_swiss===true,  'Swiss');
  add(f.nat_serbian===true,'Serbian');
  add(f.nat_latin===true,  'Latin American');
  add(f.nat_egyptian===true,'Egyptian');
  add(f.nat_saudi===true,  'Saudi');
  add(f.nat_kuwaiti===true,'Kuwaiti');
  add(f.nat_emirati===true,'Emirati');
  add(f.ach_worldcup===true,'won World Cup');
  add(f.ach_ballondor===true,"won Ballon d'Or");
  add(f.ach_ucl===true,'won Champions League');
  add(f.ach_oscar===true,'won Oscar');
  add(f.ach_grammy===true,'won Grammy');
  add(f.ach_nobel===true,'won Nobel Prize');
  add(f.ach_olympics===true,'won Olympic medal');
  add(f.ach_grandslam===true,'won Grand Slam');
  add(f.era_active===true,'still active now');
  add(f.era_90s===true,'rose to fame in 90s');
  add(f.era_80s===true,'rose to fame in 80s');
  add(f.nat_s_american===true,'South American');
  add(f.nat_european===true,'European');
  add(f.pos_striker===true,'striker/forward');
  add(f.pos_goalkeeper===true,'goalkeeper');
  add(f.pos_midfielder===true,'midfielder');
  add(f.pos_defender===true,'defender');
  add(f.club_real===true,'played for Real Madrid');
  add(f.club_barca===true,'played for Barcelona');
  add(f.club_manu===true,'played for Man United');
  add(f.club_liver===true,'played for Liverpool');
  add(f.work_action===true,'known for action movies/films');
  add(f.work_superhero===true,'played superhero role');
  add(f.work_tv===true,'famous from TV show/series');
  add(f.work_comedy===true,'known for comedy');
  add(f.work_standup===true,'stand-up comedian');
  add(f.style_pop===true,'pop singer');
  add(f.style_band===true,'part of a band');
  add(f.style_rap===true,'rapper');
  add(f.fic_marvel===true,'from Marvel');
  add(f.fic_dc===true,'from DC');
  add(f.fic_disney===true,'from Disney');
  add(f.fic_anime===true,'from anime');
  add(f.fic_superhero===true,'superhero');
  add(f.fic_villain===true,'villain');
  add(f.fic_fly===true,'can fly');
  add(f.fic_powers===true,'has superpowers');
  add(f.fic_game===true,'from a video game');
  add(f.field_physics===true,'physics');
  add(f.field_medicine===true,'medicine');
  add(f.field_tech===true,'technology');
  add(f.weight_heavy===true,'heavyweight');
  add(f.role_president===true,'served as president/head of state');
  add(f.role_king===true,'king/queen/prince');
  add(f.type_novelist===true,'novelist');
  add(f.type_poet===true,'poet');

  // Negative facts that help narrow down
  const trueNat = ['nat_arab','nat_american','nat_british','nat_french','nat_spanish',
    'nat_portuguese','nat_argentine','nat_brazilian','nat_german','nat_italian',
    'nat_dutch','nat_russian','nat_australian','nat_swiss','nat_serbian','nat_latin',
    'nat_egyptian','nat_saudi','nat_kuwaiti','nat_emirati'];
  const noNats = trueNat.filter(k => f[k] === false).map(k => k.replace('nat_',''));
  if (noNats.length) parts.push(`NOT: ${noNats.join(', ')}`);

  return parts.join(' | ') || 'no confirmed facts yet';
}

// ─────────────────────────────────────────────────────────────────────────────
//  GPT-4o GUESS
// ─────────────────────────────────────────────────────────────────────────────
async function makeGuess(session) {
  const ar = session.language === 'ar';
  const fallback = { type:'guess', name: ar ? 'شخصية مشهورة' : 'A famous person', confidence:0.2 };

  if (!openai) return fallback;

  const summary = factsSummary(session);
  const rejected = session.rejectedGuesses;
  const qa = session.turns.map((t,i) => `Q${i+1}: ${t.question} → ${t.answer}`).join('\n');

  const system = ar
    ? `أنت متخصص في تحديد الشخصيات. بناءً على الحقائق المؤكدة، خمّن الشخصية الأكثر احتمالاً.
قواعد:
- اسم واحد فقط بالعربية كما هو معروف (مثال: "محمد صلاح"، "فيروز"، "رونالدو")
- لا تكرر: [${rejected.join(', ')||'لا شيء'}]
- JSON فقط بدون أي نص آخر: {"type":"guess","name":"...","confidence":0.9}`
    : `You are a character identification expert. Based ONLY on confirmed facts, name the single most likely character.
Rules:
- Full name as commonly known (e.g. "Lionel Messi", "Tom Hanks", "Iron Man")
- NEVER repeat: [${rejected.join(', ')||'none'}]
- JSON only, no extra text: {"type":"guess","name":"...","confidence":0.9}`;

  const user = `Confirmed facts: ${summary}
Full Q&A:
${qa || 'none yet'}
Rejected guesses: ${rejected.join(', ')||'none'}
Make your single best guess now.`;

  try {
    const resp = await openai.chat.completions.create({
      model, temperature:0.1, max_tokens:80,
      response_format: { type:'json_object' },
      messages: [{ role:'system', content:system }, { role:'user', content:user }],
    });
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '{}');
    const name = String(parsed.name ?? '').trim();
    if (!name || rejected.includes(name)) return fallback;

    // Fetch Wikipedia photo + bio alongside the guess
    const wiki = await fetchWiki(name, session.language);

    const text = ar
      ? `هل الشخصية التي تفكر بها هي ${name}؟`
      : `Is the character you're thinking of ${name}?`;

    return {
      type: 'guess',
      name,
      guessName: name,
      text,
      confidence: typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence)) : 0.75,
      wiki,
    };
  } catch (e) {
    console.error('makeGuess:', e?.message);
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────
async function runEngine(session) {
  const { questionsThisPhase: qCount, minQ, maxQ } = session;

  // Must guess now (hit ceiling)
  if (qCount >= maxQ) {
    return makeGuess(session);
  }

  // Still in question phase — get next structured question
  if (qCount < minQ) {
    const q = nextQuestion(session);
    if (q) {
      session.pendingKey = q.key;
      return { type:'question', text: q.text };
    }
    // Exhausted all questions before minQ — guess anyway
    return makeGuess(session);
  }

  // In the window [minQ, maxQ) — pick question or guess
  const q = nextQuestion(session);
  if (!q) {
    // No more questions to ask — guess
    return makeGuess(session);
  }

  // We have more questions, but maybe we're confident enough to guess?
  // Simple heuristic: if we know domain + sub-domain + nationality + 1 achievement → guess
  const f = session.facts;
  const readyToGuess = session.subDomain
    && (f.nat_arab===true || f.nat_american===true || f.nat_british===true ||
        f.nat_french===true || f.nat_portuguese===true || f.nat_argentine===true ||
        f.nat_brazilian===true || f.nat_spanish===true || f.nat_german===true ||
        f.nat_egyptian===true || f.nat_saudi===true || f.nat_kuwaiti===true ||
        f.nat_emirati===true || f.nat_australian===true || f.nat_russian===true)
    && (f.ach_worldcup===true || f.ach_ballondor===true || f.ach_ucl===true ||
        f.ach_oscar===true || f.ach_grammy===true || f.ach_nobel===true ||
        f.ach_olympics===true || f.ach_grandslam===true ||
        f.era_active!==null || f.era_90s!==null || f.era_80s!==null);

  if (readyToGuess && qCount >= minQ) {
    return makeGuess(session);
  }

  session.pendingKey = q.key;
  return { type:'question', text: q.text };
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIKIPEDIA
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWiki(name, lang) {
  const l = lang === 'ar' ? 'ar' : 'en';
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

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok:true, model, hasOpenAI:Boolean(openai) });
});

// POST /api/game/start
// Body: { language: "ar" | "en" }
// Returns: { sessionId, type:"question", text:"..." }
app.post('/api/game/start', async (req, res) => {
  try {
    const language = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();
    const session = newSession(language);
    sessions.set(sessionId, session);
    const result = await runEngine(session);
    return res.json({ sessionId, ...result });
  } catch(e) {
    console.error('start:', e);
    return res.status(500).json({ error:'Failed to start game' });
  }
});

// POST /api/game/answer
// Body: { sessionId, question, answer:"yes"|"no"|"maybe"|"dont_know" }
// Returns: { type:"question", text } OR { type:"guess", name, confidence }
app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error:'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    const normAnswer = (() => {
      const m = { yes:'yes', no:'no', maybe:'maybe', dontknow:'dont_know', dont_know:'dont_know' };
      return m[String(answer ?? '').trim().toLowerCase().replace(/[^a-z_]/g,'')] ?? 'dont_know';
    })();

    // Use the key we stored when sending the question
    const key = session.pendingKey ?? 'unknown';
    session.askedKeys.add(key);
    session.pendingKey = null;
    session.turns.push({ key, question: String(question ?? ''), answer: normAnswer });
    session.questionsThisPhase += 1;

    // Update domain/facts
    applyAnswer(session, key, normAnswer);

    return res.json(await runEngine(session));
  } catch(e) {
    console.error('answer:', e);
    return res.status(500).json({ error:'Failed to process answer' });
  }
});

// POST /api/game/guess-confirm
// Body: { sessionId, guessName, correct:true|false }
// Returns:
//   correct=true  → { type:"revealed", guessName, wiki:{title,extract,imageURL,articleURL} }
//   wrong < 3     → { type:"guess", name, confidence }  (immediate next guess)
//   wrong = 3     → { type:"question", text }            (back to questions, same domain)
app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error:'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    if (correct) {
      const wiki = await fetchWiki(String(guessName ?? ''), session.language);
      return res.json({ type:'revealed', guessName, wiki });
    }

    // Wrong guess
    if (guessName) session.rejectedGuesses.push(String(guessName));
    session.guessStreak += 1;

    // Guess 2 or 3: try another guess immediately (no questions between)
    if (session.guessStreak < MAX_GUESSES) {
      return res.json(await makeGuess(session));
    }

    // After 3 wrong guesses → back to questions
    // Domain context is PRESERVED — we continue with the same domain lists
    // Only reset the question counter for the new phase
    session.guessStreak = 0;
    session.questionsThisPhase = 0;
    session.minQ = FOLLOWUP_MIN;
    session.maxQ = FOLLOWUP_MAX;

    return res.json(await runEngine(session));
  } catch(e) {
    console.error('guess-confirm:', e);
    return res.status(500).json({ error:'Failed to confirm guess' });
  }
});

// GET /api/wiki?name=...&language=ar|en
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

// ─────────────────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Magic Ball  →  http://localhost:${PORT}`);
  console.log(`🤖 Model: ${MODEL} | OpenAI: ${Boolean(openai)}`);
  console.log(`📋 Phase 1: ${INITIAL_MIN}–${INITIAL_MAX} questions → up to ${MAX_GUESSES} guesses`);
  console.log(`🔁 Phase 2: ${FOLLOWUP_MIN}–${FOLLOWUP_MAX} domain-specific questions → guess again`);
});
=
