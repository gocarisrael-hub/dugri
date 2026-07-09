// word-prompts.js — memory-joggers so contributors never face a blank box.
// Every prompt is about the celebration person; "{name}" is interpolated with
// the honoree's name (falls back to "בעל/ת השמחה", gendered). Prompts also carry
// gender-aware phrasing via a "{female|male}" alternation token, resolved by
// renderQuestion(). Pure data + helpers.

export const CATEGORIES = [
  {
    id: 'people',
    label: 'אנשים',
    emoji: '👯',
    questions: [
      'איך {name} {קוראת|קורא} לבן/בת הזוג?',
      'מי {החברה|החבר} הכי {ותיקה|ותיק} של {name}?',
      'כינוי שרק במשפחה קוראים ל{name}',
      'שם של אקס מפורסם של {name}',
      'מי תמיד מצליח/ה להרגיע את {name}?',
      'איך קוראים לאמא של {name}?',
      'איך קוראים לאבא של {name}?',
      'שם של אח או אחות של {name}',
      'מי {החברה הכי טובה|החבר הכי טוב} של {name} מהתיכון?',
      'הכינוי שהחברים נותנים ל{name}',
      'מי הבנאדם ש{name} הכי {סומכת|סומך} עליו?',
      'שם של שכן או שכנה של {name}',
    ],
  },
  {
    id: 'places',
    label: 'מקומות',
    emoji: '📍',
    questions: [
      'איפה {name} {גדלה|גדל}?',
      'לאן {name} הכי {חולמת|חולם} לטוס?',
      'המקום הקבוע של {name} לקפה',
      'איפה {name} הכי {אוהבת|אוהב} לבלות בלילה?',
      'באיזו עיר {name} {גרה|גר} עכשיו?',
      'המסעדה שבה {name} {חוגגת|חוגג} כל יום הולדת',
      'החוף ש{name} הכי {אוהבת|אוהב}',
      'המקום שבו {name} {נחה|נח} הכי טוב',
      'לאן {name} {בורחת|בורח} כשצריך אוויר?',
      'הפאב או הבר הקבוע של {name}',
    ],
  },
  {
    id: 'jokes',
    label: 'בדיחות פנימיות',
    emoji: '😂',
    questions: [
      'משפט שרק {אתן מבינות|אתם מבינים} עם {name}',
      'הסיפור הכי מביך של {name}',
      'בדיחה פנימית מטיול עם {name}',
      'הכינוי שנדבק ל{name} בטעות',
      'הסיפור ש{name} {מספרת|מספר} בכל מסיבה',
      'הכינוי המצחיק ש{name} {נתנה|נתן} למישהו',
      'משהו ש{name} {עשתה|עשה} פעם וכולם צוחקים עליו עד היום',
      'הרגע הכי מביך של {name} שתועד בתמונה',
    ],
  },
  {
    id: 'habits',
    label: 'הרגלים וטיקים',
    emoji: '🌀',
    questions: [
      'מה {name} עושה {כשהיא|כשהוא} בלחץ?',
      'ההרגל הכי מצחיק של {name}',
      'מה {name} עושה כל בוקר בלי יוצא דופן?',
      'הדבר ש{name} {שוכחת|שוכח} כל פעם מחדש',
      'מה {name} עושה ראשון {כשהיא מתעוררת|כשהוא מתעורר}?',
      'ההרגל של {name} שמשגע את כולם',
      'מה {name} תמיד {שוכחת|שוכח} בבית?',
      'הטקס הקבוע של {name} מול הטלוויזיה',
      'כמה קפה {name} שותה ביום?',
    ],
  },
  {
    id: 'food',
    label: 'אוכל',
    emoji: '🍕',
    questions: [
      'המנה ש{name} {מזמינה|מזמין} בכל מסעדה',
      'האוכל ש{name} לא {נוגעת|נוגע} בו בחיים',
      'מה {name} {מכינה|מכין} הכי טוב?',
      'הפינוק האשם של {name}',
      'הקינוח ש{name} לא {מוותרת|מוותר} עליו',
      'החטיף ש{name} תמיד {מחזיקה|מחזיק} בבית',
      'האוכל שמזכיר ל{name} את הבית של אמא',
      'המשקה שאי אפשר לדמיין את {name} בלעדיו',
      'הפיצה של {name}: איזה תוספות?',
    ],
  },
  {
    id: 'work',
    label: 'עבודה ולימודים',
    emoji: '💼',
    questions: [
      'מה {name} עושה בעבודה?',
      'מקצוע ש{name} תמיד {חלמה|חלם} עליו',
      'הסיפור מהצבא של {name}',
      'איפה {name} {שירתה|שירת} בצבא?',
      'מה {name} {למדה|למד}?',
      'העבודה הראשונה של {name}',
      'החלום המקצועי ש{name} עדיין לא {הגשימה|הגשים}',
      'הקולגה ש{name} הכי {אוהבת|אוהב} בעבודה',
    ],
  },
  {
    id: 'childhood',
    label: 'ילדות',
    emoji: '🧸',
    questions: [
      'הצעצוע האהוב של {name} בילדות',
      'מה {name} {רצתה להיות כשתהיה גדולה|רצה להיות כשיהיה גדול}?',
      'הסדרה ש{name} {גדלה|גדל} עליה',
      'הכינוי של {name} בילדות',
      'המשחק שבו {name} {שיחקה|שיחק} כל היום בילדות',
      'החטיף מהילדות ש{name} עדיין {אוהבת|אוהב}',
      'איפה {name} {בילתה|בילה} את החופש הגדול?',
      'הזיכרון הכי חזק של {name} מהגן',
    ],
  },
  {
    id: 'sayings',
    label: 'ביטויים קבועים',
    emoji: '💬',
    questions: [
      'המילה ש{name} {משתמשת|משתמש} בה יותר מדי',
      'משפט שתמיד יוצא ל{name}',
      'הקללה האהובה של {name}',
      'המשפט ש{name} {אומרת|אומר} כשמשהו מעצבן {אותה|אותו}',
      'הביטוי ש{name} {הביאה|הביא} מהבית',
      'מה {name} {אומרת|אומר} כש{name} {מתלהבת|מתלהב}?',
      'איך {name} עונה לטלפון?',
    ],
  },
  {
    id: 'culture',
    label: 'סדרות, שירים וסלבס',
    emoji: '🎬',
    questions: [
      'הסדרה ש{name} {בינג׳תה|בינג׳ה} לאחרונה',
      'השיר ש{name} {שרה|שר} בקריוקי',
      'הסלב ש{name} {מתה|מת} עליו',
      'הסדרה ש{name} {ממליצה|ממליץ} לכולם',
      'השיר שחייב להתנגן במסיבה של {name}',
      'הסרט ש{name} {יכולה|יכול} לצטט בעל פה',
      'הזמר או הלהקה ש{name} {גדלה|גדל} עליהם',
    ],
  },
  {
    id: 'vacations',
    label: 'חופשות',
    emoji: '✈️',
    questions: [
      'הטיול הכי טוב של {name}',
      'מה {name} תמיד {שוכחת|שוכח} לארוז',
      'יעד החלומות של {name}',
      'המדינה האחרונה ש{name} {טסה|טס} אליה',
      'ים או בריכה? מה {name} {מעדיפה|מעדיף}?',
      'עם מי {name} הכי {אוהבת|אוהב} לטייל?',
      'הדבר הראשון ש{name} עושה בחופשה',
    ],
  },
  {
    id: 'loves',
    label: 'אהבות וטרנדים',
    emoji: '💖',
    questions: [
      'הטרנד ש{name} {נדבקה|נדבק} אליו',
      'חיית המחמד (או החלום) של {name}',
      'התחביב החדש של {name}',
      'הדבר ש{name} {אספה|אסף} פעם',
      'מה {name} עושה כדי להירגע?',
      'הפינוק ש{name} {קונה לעצמה|קונה לעצמו}',
      'הטרנד ברשתות ש{name} {נסחפה|נסחף} אחריו',
    ],
  },
];

// Flat bank of prompts derived from the categories, each with a stable id.
export const PROMPTS = CATEGORIES.flatMap((cat) =>
  cat.questions.map((text, i) => ({ id: `${cat.id}-${i}`, cat: cat.id, text }))
);

// ---------------------------------------------------------------------------
// Per-event prompt sets
// ---------------------------------------------------------------------------
// The default CATEGORIES/PROMPTS above are the adult, single-honoree set (asks
// about exes, drinking, army, nightlife…). Two events need a tailored set:
//   • KIDS (a child's birthday) — must be kid-appropriate: NO exes/drinking/etc.
//   • ANNIVERSARY (a couple) — asks about the two partners TOGETHER, so {name}
//     is the couple's combined name (e.g. "דנה ויוסי") and prompts use plural,
//     gender-neutral phrasing (no {female|male} single-gender alternations).
// categoriesForTheme()/promptsForTheme() pick the right set by generator theme.

/** Kid-appropriate categories for a child's birthday. {name} = the child. */
export const KIDS_CATEGORIES = [
  {
    id: 'friends',
    label: 'חברים',
    emoji: '🧒',
    questions: [
      'מי {החברה הכי טובה|החבר הכי טוב} של {name}?',
      'עם מי {name} הכי {אוהבת|אוהב} לשחק?',
      'שם של {חברה|חבר} מהגן או מבית הספר של {name}',
      'עם מי {name} תמיד {יושבת|יושב} בכיתה?',
    ],
  },
  {
    id: 'school',
    label: 'גן ובית ספר',
    emoji: '🎒',
    questions: [
      'איך קוראים {לגננת|לגנן} או {למורה|למורה} של {name}?',
      'השיעור או הפעילות ש{name} הכי {אוהבת|אוהב}',
      'מה {name} הכי {אוהבת|אוהב} לעשות בהפסקה?',
    ],
  },
  {
    id: 'favorites',
    label: 'הדברים האהובים',
    emoji: '⭐',
    questions: [
      'הצבע האהוב על {name}',
      'הצעצוע ש{name} לא {מוותרת|מוותר} עליו',
      'החיה האהובה על {name}',
      'הבובה או הדמות ש{name} הכי {אוהבת|אוהב}',
    ],
  },
  {
    id: 'shows',
    label: 'סדרות ומשחקים',
    emoji: '📺',
    questions: [
      'הסדרה או הסרט ש{name} {מבקשת|מבקש} לראות שוב ושוב',
      'הדמות המצוירת האהובה על {name}',
      'המשחק (במחשב או בחצר) ש{name} הכי {אוהבת|אוהב}',
    ],
  },
  {
    id: 'food',
    label: 'אוכל וממתקים',
    emoji: '🍭',
    questions: [
      'המאכל האהוב על {name}',
      'הממתק ש{name} הכי {אוהבת|אוהב}',
      'האוכל ש{name} מסרבת בכל תוקף לאכול',
      'מה {name} הכי {אוהבת|אוהב} לקבל לארוחת בוקר?',
    ],
  },
  {
    id: 'hobbies',
    label: 'תחביבים וספורט',
    emoji: '⚽',
    questions: [
      'התחביב או החוג של {name}',
      'ספורט או משחק ש{name} {אוהבת|אוהב} לשחק',
      'משהו חדש ש{name} {לומדת|לומד} עכשיו',
    ],
  },
  {
    id: 'funny',
    label: 'דברים מצחיקים',
    emoji: '😄',
    questions: [
      'משהו מצחיק ש{name} תמיד {עושה|עושה}',
      'מילה או משפט ש{name} {אומרת|אומר} כל הזמן',
      'מה {name} עושה {כשהיא שמחה|כשהוא שמח}?',
    ],
  },
  {
    id: 'family',
    label: 'משפחה',
    emoji: '👨‍👩‍👧',
    questions: [
      'שמות של האחים או האחיות של {name}',
      'הכינוי החמוד שקוראים ל{name} בבית',
      'עם מי מהמשפחה {name} הכי {אוהבת|אוהב} להיות?',
    ],
  },
  {
    id: 'party',
    label: 'יום ההולדת',
    emoji: '🎂',
    questions: [
      'איזו מתנה {name} הכי {רוצה|רוצה} ליום ההולדת?',
      'הנושא של מסיבת יום ההולדת של {name}',
      'לאן {name} {חולמת|חולם} לחגוג?',
    ],
  },
];

/** Couple/anniversary categories. {name} = both partners (e.g. "דנה ויוסי"). */
export const COUPLE_CATEGORIES = [
  {
    id: 'begin',
    label: 'איך הכל התחיל',
    emoji: '💞',
    questions: [
      'איפה {name} נפגשו בפעם הראשונה?',
      'לאן {name} יצאו בדייט הראשון?',
      'מי מביניהם התאהב ראשון?',
      'מי הכיר ביניהם?',
    ],
  },
  {
    id: 'together',
    label: 'ביחד',
    emoji: '✈️',
    questions: [
      'הטיול הכי טוב ש{name} עשו יחד',
      'הסדרה ש{name} צופים בה ביחד',
      'השיר של {name}',
      'הפעילות ש{name} הכי אוהבים לעשות בסופ״ש',
    ],
  },
  {
    id: 'home',
    label: 'הבית המשותף',
    emoji: '🏠',
    questions: [
      'מי מבשל בבית של {name}?',
      'ההרגל של אחד שמשגע את השני',
      'חיית המחמד (או החלום) של {name}',
      'הדבר שתמיד גורם ל{name} להתווכח בכיף',
    ],
  },
  {
    id: 'family',
    label: 'משפחה',
    emoji: '👨‍👩‍👧',
    questions: [
      'שמות הילדים של {name}',
      'הכינוי ש{name} נותנים אחד לשני',
      'מי מהמשפחה תמיד מגיע לביקור אצל {name}?',
    ],
  },
  {
    id: 'jokes',
    label: 'בדיחות פנימיות',
    emoji: '😂',
    questions: [
      'בדיחה פנימית שרק {name} מבינים',
      'הסיפור הכי מביך שקרה ל{name} יחד',
      'משהו ש{name} עדיין צוחקים עליו מהחתונה',
    ],
  },
  {
    id: 'food',
    label: 'אוכל',
    emoji: '🍝',
    questions: [
      'המנה ש{name} תמיד מזמינים',
      'המסעדה הקבועה של {name}',
      'המאכל שאחד אוהב והשני שונא',
    ],
  },
  {
    id: 'traditions',
    label: 'מסורות',
    emoji: '🥂',
    questions: [
      'המסורת של {name} לכל יום נישואין',
      'המקום המיוחד של {name}',
      'משפט שאחד תמיד אומר לשני',
    ],
  },
];

/** Flat bank (PROMPTS-shape: {id, cat, text}) derived from a categories array. */
function flatten(categories) {
  return categories.flatMap((cat) =>
    cat.questions.map((text, i) => ({ id: `${cat.id}-${i}`, cat: cat.id, text }))
  );
}

export const KIDS_PROMPTS = flatten(KIDS_CATEGORIES);
export const COUPLE_PROMPTS = flatten(COUPLE_CATEGORIES);

// Generator themes that use the kid-appropriate set (from designs.js THEME_BY_DESIGN).
const KIDS_THEMES = new Set(['birthday-boys-basketball']);

/** True for a generator theme whose event is a child's birthday. */
export function isKidsTheme(theme) {
  return KIDS_THEMES.has(theme) || /kids/.test(String(theme || ''));
}
/** True for the couple/anniversary generator theme. */
export function isCoupleTheme(theme) {
  return theme === 'anniversary';
}

/** The category set for a generator theme: kids / couple / default. */
export function categoriesForTheme(theme) {
  if (isKidsTheme(theme)) return KIDS_CATEGORIES;
  if (isCoupleTheme(theme)) return COUPLE_CATEGORIES;
  return CATEGORIES;
}
/** The flat idea-prompt bank for a generator theme. */
export function promptsForTheme(theme) {
  if (isKidsTheme(theme)) return KIDS_PROMPTS;
  if (isCoupleTheme(theme)) return COUPLE_PROMPTS;
  return PROMPTS;
}

const FALLBACK_NAME = 'בעלת השמחה';
const FALLBACK_NAME_MALE = 'בעל השמחה';

/** Replace {name} in a prompt with the honoree name (or a gentle fallback). */
export function fillName(text, name) {
  const n = (name == null ? '' : String(name)).trim() || FALLBACK_NAME;
  // Function replacement so the name is inserted LITERALLY — a name containing
  // $&, $`, $', or $$ must not be treated as a special replacement pattern.
  return String(text == null ? '' : text).replace(/\{name\}/g, () => n);
}

/**
 * Render a question with gender-aware phrasing.
 * - `{name}` → the honoree name, or a gendered fallback
 *   ('בעלת השמחה' for female / 'בעל השמחה' for male).
 * - `{female|male}` → the first form when gender is 'female' (the DEFAULT when
 *   gender is null/undefined/anything-not-'male'), the second when 'male'.
 * @param {string} text
 * @param {string} [name]
 * @param {('female'|'male'|null)} [gender] defaults to feminine phrasing
 * @returns {string}
 */
export function renderQuestion(text, name, gender) {
  const male = gender === 'male';
  const fallback = male ? FALLBACK_NAME_MALE : FALLBACK_NAME;
  const n = (name == null ? '' : String(name)).trim() || fallback;
  return (
    String(text == null ? '' : text)
      .replace(/\{([^{}|]*)\|([^{}]*)\}/g, (_, f, m) => (male ? m : f))
      // Function replacement so the name is inserted LITERALLY — a name containing
      // $&, $`, $', or $$ must not be treated as a special replacement pattern.
      .replace(/\{name\}/g, () => n)
  );
}

/**
 * Pick the next prompt, avoiding ids in `seenIds` (recent prompts) so it doesn't
 * immediately repeat. When all prompts have been seen, it resets and picks any.
 * @param {string[]} seenIds
 * @param {() => number} [rng] injectable for tests; defaults to Math.random
 * @returns {{id:string, cat:string, text:string}}
 */
export function nextPrompt(seenIds = [], rng = Math.random) {
  const seen = new Set(seenIds);
  let pool = PROMPTS.filter((p) => !seen.has(p.id));
  if (pool.length === 0) pool = PROMPTS;
  return pool[Math.floor(rng() * pool.length)];
}
