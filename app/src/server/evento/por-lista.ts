// Los eventos que entran solo por lista: la inscripción corre por fuera (otra plataforma, un formulario propio) y
// quien organiza importa la lista aprobada. En esos eventos la app no inscribe a nadie que lo pida por su cuenta:
// ni el formulario, ni el de equipos, ni la API. Tampoco salen en el inicio. Importar la lista y agregar en la
// puerta siguen andando, porque los pide quien organiza.
//
// Cuáles son lo dice RUMBO_LIST_ONLY_EVENTS: el final de /e/<evento> de cada uno, separados por coma (no importan
// las mayúsculas ni los espacios). Vacía o sin definir, ningún evento entra solo por lista y todo queda como
// siempre. Es una variable porque todavía no hay una columna para esto; el lugar natural es una casilla del panel.
//
// Una dirección mal escrita en la variable no cierra nada: el evento queda en el inicio y con la inscripción
// abierta. Por eso se lee con tolerancia (comillas pegadas, punto y coma, la ruta /e/<evento> o el enlace entero,
// caracteres invisibles de copiar y pegar) y lo que igual no sirve se avisa en el registro del servidor, una vez por
// proceso: lo que no tiene forma de dirección, y lo que no es la dirección de ningún evento. El panel de un evento
// que entra solo por lista lo dice arriba: es la comprobación de quien organiza.
//
// El freno no vive adentro de registerForEvent, que también usa "Agregar en la puerta": vive en las puertas
// públicas (publicRegistration y publicCompletion en inscripcion.ts, y registerTeam). Una ruta o una acción nueva
// que inscriba a pedido de la persona tiene que pasar por ahí; tests/inscripcion-por-lista.test.mjs lo comprueba.
import { getEnv } from "../env.ts";
import { SLUG_RE, findEventBySlug } from "../kit/direccion.ts";
import type { EventRecord, Repo } from "../repo.ts";

export const LIST_ONLY_ENV = "RUMBO_LIST_ONLY_EVENTS";

/** Lo que ya se avisó en este proceso: cada problema de la variable sale una sola vez en el registro. */
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[por-lista] ${message}`);
}
const shown = (text: string): string => JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);

/**
 * Una entrada de la variable como la pegaría alguien, llevada a la dirección del evento: sin comillas ni caracteres
 * invisibles, en minúsculas y, si vino una ruta o un enlace (/e/<evento>, /admin/<evento>, https://.../e/<evento>),
 * el tramo que nombra al evento.
 */
function entryToSlug(raw: string): string {
  const entry = raw
    .replace(/\p{Cf}/gu, "")
    .replace(/["'`\u2018\u2019\u201c\u201d\u00ab\u00bb]/g, "")
    .trim()
    .toLowerCase();
  if (!entry.includes("/")) return entry;
  const parts = entry.replace(/[?#].*$/, "").split("/").filter(Boolean);
  // Ningún evento se llama "e" ni "admin" (son palabras reservadas): lo que sigue a ese tramo es la dirección.
  const at = parts.findIndex((part, i) => (part === "e" || part === "admin") && i < parts.length - 1);
  return (at >= 0 ? parts[at + 1] : parts[parts.length - 1]) ?? "";
}

let parsed: { raw: string; slugs: Set<string> } | null = null;

/** Las direcciones de la variable, limpias. Se lee en cada llamada, como el resto de las variables. */
function listOnlySlugs(): Set<string> {
  const raw = getEnv(LIST_ONLY_ENV, "");
  if (parsed?.raw === raw) return parsed.slugs;
  const slugs = new Set<string>();
  for (const piece of raw.split(/[\s,;]+/)) {
    const slug = entryToSlug(piece);
    if (!slug) continue;
    if (SLUG_RE.test(slug)) slugs.add(slug);
    else warnOnce(`formato:${slug}`, `${LIST_ONLY_ENV} trae ${shown(piece)}, que no tiene forma de dirección de evento (minúsculas, números y guiones): no cierra ningún evento.`);
  }
  parsed = { raw, slugs };
  return slugs;
}

/** Si este evento entra solo por lista. Se compara su dirección de ahora, nunca la que vino en el pedido. */
export function isListOnly(event: Pick<EventRecord, "slug">): boolean {
  const slugs = listOnlySlugs();
  return slugs.size > 0 && slugs.has(event.slug.trim().toLowerCase());
}

/**
 * El evento publicado que atiende esa dirección, la de ahora o una que tuvo antes, si entra solo por lista; si no,
 * null. Lo usan las puertas públicas antes de inscribir: primero se resuelve el evento y recién después se mira la
 * lista. Un borrador no cuenta: todavía no recibe inscripciones, y se contesta lo de siempre.
 */
export async function listOnlyEventAt(repo: Repo, slug: string): Promise<EventRecord | null> {
  // Con la variable vacía no se consulta nada: ni una lectura de más.
  if (listOnlySlugs().size === 0) return null;
  const found = await findEventBySlug(repo, slug);
  return found && found.event.published && isListOnly(found.event) ? found.event : null;
}

/**
 * Los eventos que salen en el inicio: los publicados que no entran solo por lista. De paso mira la variable contra
 * los eventos que hay (con los borradores): una dirección que no es de ninguno se avisa en el registro, porque lo
 * más probable es que el evento que se quería cerrar tenga otra y esté saliendo acá, con su inscripción abierta.
 */
export function listedEvents<T extends Pick<EventRecord, "slug" | "published">>(events: readonly T[]): T[] {
  const slugs = listOnlySlugs();
  if (slugs.size > 0) {
    const existing = new Set(events.map((event) => event.slug.trim().toLowerCase()));
    for (const slug of slugs) {
      if (!existing.has(slug)) warnOnce(`sin-evento:${slug}`, `${LIST_ONLY_ENV} nombra ${shown(slug)}, que no es la dirección de ningún evento: si el evento tiene otra, sigue con la inscripción abierta.`);
    }
  }
  return events.filter((event) => event.published && !isListOnly(event));
}
