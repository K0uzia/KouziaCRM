/**
 * Textes alternatifs et légendes proposés pour les images d'une réalisation, d'après le contexte : nom et type du
 * projet, vue, rang parmi les captures de la même vue, nom lisible du média (libellé de la médiathèque, sinon nom du
 * fichier d'origine). Rien n'est envoyé à un service externe. Un texte reste « proposé » tant qu'il n'a pas été
 * retouché : seul un texte proposé est recalculé quand le contexte change.
 */

export type MediaName = { label: string | null; originalName: string | null };
/** Noms des médias de la médiathèque, par empreinte (sha12 du chemin /media/<sha12>.webp). */
export type MediaNames = Record<string, MediaName>;

type Vue = "bureau" | "mobile";
type ProjectContext = { kind: string; name: string; nature: string };
export type CaptureDraft = { image: string | null; alt: string; caption: string; vue: Vue; altAuto?: boolean | null; captionAuto?: boolean | null };
type SideDraft = { image: string | null; alt: string; altAuto?: boolean | null };
export type PairDraft = { vue: Vue; avant: SideDraft & { date: string }; apres: SideDraft };

const sha12Of = (path: string | null) => /^\/media\/([a-f0-9]{12})\.webp$/.exec(path ?? "")?.[1];
const device = (vue: Vue) => (vue === "mobile" ? "téléphone" : "ordinateur");
const subject = (f: ProjectContext) => `${f.kind === "SOFTWARE" ? "Logiciel" : "Site"} ${f.name.trim()}`;
const upperFirst = (s: string) => s.charAt(0).toLocaleUpperCase("fr") + s.slice(1);
// « Page d'accueil » devient « page d'accueil » ; un sigle (« FAQ », « PDF ») garde ses capitales.
const lowerFirst = (s: string) => (/^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLocaleLowerCase("fr") + s.slice(1) : s);

/** Noms d'appareil photo, de capture d'écran ou d'empreinte : ils ne disent rien de l'image. */
const MEANINGLESS = /^(img|dsc|dscn|pxl|mvimg|screenshot|screen shot|capture d.?[ée]cran|capture|image|photo|scr|unnamed|untitled|sans titre)(\s|\d|$)/iu;

const meaningful = (raw: string): string | null => {
  const text = raw
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // « … » : libellé d'usage posé par l'ERP à la reprise d'une image du site (« Capture 1 de la page projet « X » »).
  if (!/\p{L}{3,}/u.test(text) || MEANINGLESS.test(text) || /«.*»/.test(text)) return null;
  const compact = text.replace(/\s/g, "");
  if (/\d{6,}/.test(compact) || /[a-f0-9]{10,}/i.test(compact)) return null;
  return upperFirst(text);
};

/**
 * Nom lisible d'un média : libellé de la médiathèque, sinon nom du fichier d'origine, s'il décrit quelque chose. Le
 * libellé passe le même filtre : à l'envoi, l'ERP le tire du nom du fichier.
 */
export function readableMediaName(m: MediaName | undefined): string | null {
  return meaningful(m?.label ?? "") ?? meaningful(m?.originalName ?? "");
}

/** Largeur maximale d'une capture de téléphone (iPhone Pro Max : 1 290 px). */
export const PHONE_MAX_WIDTH = 1290;

/**
 * Vue devinée d'après le format : plus haute que large et pas plus large qu'un téléphone. Une capture d'ordinateur
 * d'une page entière est haute aussi, mais plus large.
 */
export function guessVue(width: number, height: number): Vue {
  return height > width && width <= PHONE_MAX_WIDTH ? "mobile" : "bureau";
}

/** Vue d'un fichier image d'après ses dimensions (lues dans le navigateur) ; illisible : ordinateur. */
export async function guessVueOfFile(file: Blob): Promise<Vue> {
  try {
    const bitmap = await createImageBitmap(file);
    const vue = guessVue(bitmap.width, bitmap.height);
    bitmap.close();
    return vue;
  } catch {
    return "bureau";
  }
}

const nameOf = (names: MediaNames, image: string | null) => readableMediaName(names[sha12Of(image) ?? ""]);

/** « Site Tracebay : page d'accueil, vue ordinateur » ; sans nom lisible : « Site Tracebay, vue téléphone 2 ». */
export function proposeCaptureAlt(f: ProjectContext, captures: readonly CaptureDraft[], i: number, names: MediaNames): string {
  const c = captures[i];
  if (!c || !f.name.trim()) return "";
  const media = nameOf(names, c.image);
  if (media) return `${subject(f)} : ${lowerFirst(media)}, vue ${device(c.vue)}`;
  const sameVue = captures.filter((x) => x.vue === c.vue).length;
  const rank = captures.slice(0, i + 1).filter((x) => x.vue === c.vue).length;
  return `${subject(f)}, vue ${device(c.vue)}${sameVue > 1 ? ` ${rank}` : ""}`;
}

/** Légende : le nom lisible du média, ou rien (une légende générique n'apprend rien au visiteur). */
export function proposeCaptionText(c: CaptureDraft, names: MediaNames): string {
  return nameOf(names, c.image) ?? "";
}

const monthYear = (date: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(date);
  return m ? new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(new Date(Number(m[1]), Number(m[2]) - 1, 1)) : "";
};

/** « Site Tracebay avant la refonte, vue ordinateur, mars 2023 » / « Site Tracebay après la refonte, vue ordinateur ». */
export function proposePairAlt(f: ProjectContext, pair: PairDraft, side: "avant" | "apres"): string {
  if (!f.name.trim()) return "";
  const refonte = f.nature === "refonte";
  const when = side === "avant" ? (refonte ? "avant la refonte" : "avant") : refonte ? "après la refonte" : "après";
  const date = side === "avant" ? monthYear(pair.avant.date) : "";
  return `${subject(f)} ${when}, vue ${device(pair.vue)}${date ? `, ${date}` : ""}`;
}

/**
 * Applique les propositions : un texte vide, ou égal à la proposition au premier passage, devient « proposé » ; un
 * texte proposé suit le contexte. Renvoie le même objet si rien ne change (pas de rendu en boucle).
 */
export function applyProposals<F extends ProjectContext & { captures: CaptureDraft[]; avantApres: PairDraft[] }>(f: F, names: MediaNames): F {
  let changed = false;
  const captures = f.captures.map((c, i) => {
    const alt = proposeCaptureAlt(f, f.captures, i, names);
    const caption = proposeCaptionText(c, names);
    const altAuto = c.altAuto ?? (c.alt.trim() === "" || c.alt === alt);
    const captionAuto = c.captionAuto ?? (c.caption.trim() === "" || c.caption === caption);
    const next = { ...c, altAuto, captionAuto, alt: altAuto ? alt : c.alt, caption: captionAuto ? caption : c.caption };
    if (next.alt === c.alt && next.caption === c.caption && next.altAuto === c.altAuto && next.captionAuto === c.captionAuto) return c;
    changed = true;
    return next;
  });
  const side = <S extends SideDraft>(s: S, proposal: string): S => {
    const altAuto = s.altAuto ?? (s.alt.trim() === "" || s.alt === proposal);
    const alt = altAuto ? proposal : s.alt;
    if (alt === s.alt && altAuto === s.altAuto) return s;
    changed = true;
    return { ...s, alt, altAuto };
  };
  const avantApres = f.avantApres.map((x) => {
    const avant = side(x.avant, proposePairAlt(f, x, "avant"));
    const apres = side(x.apres, proposePairAlt(f, x, "apres"));
    return avant === x.avant && apres === x.apres ? x : { ...x, avant, apres };
  });
  return changed ? { ...f, captures, avantApres } : f;
}
