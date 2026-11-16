// Los eventos que entran solo por lista: la inscripción corre por fuera (otra plataforma, un formulario propio) y
// quien organiza importa la lista aprobada. En esos eventos la app no inscribe a nadie que lo pida por su cuenta:
// ni el formulario, ni el de equipos, ni la API. Tampoco salen en el inicio. Importar la lista y agregar en la
// puerta siguen andando, porque los pide quien organiza.
//
// Cuáles son lo dice RUMBO_LIST_ONLY_EVENTS: el final de /e/<evento> de cada uno, separados por coma (no importan
// las mayúsculas ni los espacios). Vacía o sin definir, ningún evento entra solo por lista y todo queda como
// siempre. Es una variable porque todavía no hay una columna para esto; el lugar natural es una casilla del panel.
//
// El freno no vive adentro de registerForEvent, que también usa "Agregar en la puerta": vive en las puertas
// públicas (publicRegistration y publicCompletion en inscripcion.ts, y registerTeam). Una ruta o una acción nueva
// que inscriba a pedido de la persona tiene que pasar por ahí; tests/inscripcion-por-lista.test.mjs lo comprueba.
import { getEnv } from "../env.ts";
import { findEventBySlug } from "../kit/direccion.ts";
import type { EventRecord, Repo } from "../repo.ts";

export const LIST_ONLY_ENV = "RUMBO_LIST_ONLY_EVENTS";

/** Las direcciones de la variable, limpias. Se lee en cada llamada, como el resto de las variables. */
function listOnlySlugs(): Set<string> {
  return new Set(
    getEnv(LIST_ONLY_ENV, "")
      .split(/[\s,]+/)
      .map((slug) => slug.toLowerCase())
      .filter(Boolean),
  );
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
