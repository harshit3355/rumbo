// Los errores internos no salen del servidor: el panel recibe un código fijo, el detalle queda en el
// registro del servidor, y ese registro no lleva correos de personas.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_DIR, capturarConsola, entornoDePrueba, eventoDePrueba, paseDePrueba, pedido } from "./lib/entorno.mjs";

entornoDePrueba();
const { getRepo } = await import("../src/server/repo.ts");
const stellar = await import("../src/server/stellar.ts");
const { BUSY } = await import("../src/server/compartido.ts");
const { panel: textosPanel } = await import("../src/i18n/panel.ts");
const { getOrCreateOrganizerKey, refreshFromChain, refreshFromChainInTurn, CHAIN_UNAVAILABLE } = await import("../src/server/panel.ts");
const { registerForEvent } = await import("../src/server/evento/inscripcion.ts");
const { POST: contrastar } = await import("../src/app/api/admin/[slug]/cadena/route.ts");

const SECRETO = "https://rpc-interno.example/?key=llave-del-proveedor";

test("si la cadena no contesta, el resumen del panel dice que no se pudo y el detalle queda en el servidor", async () => {
  const repo = getRepo();
  const datos = await eventoDePrueba(repo);
  await paseDePrueba(repo, datos);
  const original = { info: stellar.rumboPass.info, attendees: stellar.rumboPass.attendees, status: stellar.rumboPass.status };
  stellar.rumboPass.info = async () => {
    throw new Error(`fetch failed ${SECRETO}`);
  };
  stellar.rumboPass.attendees = stellar.rumboPass.info;
  stellar.rumboPass.status = stellar.rumboPass.info;
  try {
    const { resultado: summary, lineas } = await capturarConsola(() => refreshFromChain(datos.event, repo));
    assert.equal(summary.contracts[0].error, CHAIN_UNAVAILABLE);
    assert.ok(summary.errors.length >= 2);
    assert.ok(!JSON.stringify(summary).includes("rpc-interno"), JSON.stringify(summary));
    assert.ok(lineas.some((l) => l.includes(SECRETO)), "el detalle tiene que quedar en el registro del servidor");
  } finally {
    Object.assign(stellar.rumboPass, original);
  }
});

test("la ruta del contraste responde un código fijo, sin el mensaje del error", async () => {
  const real = getRepo();
  const datos = await eventoDePrueba(real);
  const clave = await getOrCreateOrganizerKey(datos.event.id);
  // la base falla a mitad del contraste con un mensaje que trae una ruta del servidor
  globalThis.__rumboRepo = new Proxy(real, {
    get(target, prop) {
      if (prop === "listTicketTypes") return async () => {
        throw new Error("SQLITE_BUSY en C:\servidor\secreto\rumbo.db");
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const req = await pedido(`http://localhost/api/admin/${datos.event.slug}/cadena?k=${clave}`, { body: {} });
    const { resultado: res, lineas } = await capturarConsola(() => contrastar(req, { params: Promise.resolve({ slug: datos.event.slug }) }));
    assert.equal(res.status, 502);
    const cuerpo = await res.json();
    assert.deepEqual(cuerpo, { error: "chain" });
    assert.ok(lineas.some((l) => l.includes("secreto")), "el detalle tiene que quedar en el registro del servidor");
  } finally {
    globalThis.__rumboRepo = real;
  }
});

test("verificar el registro tiene turno: con una verificación del evento en curso, la segunda contesta 409 sin leer nada", async () => {
  const repo = getRepo();
  const datos = await eventoDePrueba(repo, { slug: `turno-${Date.now().toString(36)}` });
  const otro = await eventoDePrueba(repo, { slug: `turno-otro-${Date.now().toString(36)}` });
  await paseDePrueba(repo, datos);
  const clave = await getOrCreateOrganizerKey(datos.event.id);
  const claveOtro = await getOrCreateOrganizerKey(otro.event.id);
  const pedir = async (evento, k) => contrastar(await pedido(`http://localhost/api/admin/${evento.slug}/cadena?k=${k}`, { body: {} }), { params: Promise.resolve({ slug: evento.slug }) });

  // La cadena contesta recién cuando la prueba la suelta: la primera verificación queda corriendo.
  const original = { info: stellar.rumboPass.info, attendees: stellar.rumboPass.attendees, status: stellar.rumboPass.status };
  let soltar;
  const espera = new Promise((resolve) => (soltar = resolve));
  let lecturas = 0;
  let empezo;
  const empezada = new Promise((resolve) => (empezo = resolve));
  stellar.rumboPass.info = async () => (lecturas++, empezo(), await espera, { issued: 1, checked_in: 0 });
  stellar.rumboPass.attendees = async () => (lecturas++, await espera, []);
  stellar.rumboPass.status = async () => (lecturas++, { has_pass: true, number: 1, checked_in: false, redeemed: [] });
  try {
    const primera = pedir(datos.event, clave);
    await empezada;
    const antes = lecturas;

    const segunda = await pedir(datos.event, clave);
    assert.equal(segunda.status, 409);
    assert.deepEqual(await segunda.json(), { error: "busy" });
    assert.equal(segunda.headers.get("cache-control"), "no-store");
    assert.equal(lecturas, antes, "la segunda no le pregunta nada a la cadena");
    assert.equal(await refreshFromChainInTurn(datos.event, repo), BUSY, "tampoco por la función: el turno es del evento");

    // El turno es de cada evento: otro evento se verifica mientras tanto.
    stellar.rumboPass.info = async () => ({ issued: 0, checked_in: 0 });
    stellar.rumboPass.attendees = async () => [];
    assert.equal((await pedir(otro.event, claveOtro)).status, 200);

    soltar();
    const res = await primera;
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sync.passesChecked, 1);

    // Terminada la primera, el turno queda libre, también si la verificación falla.
    assert.equal((await pedir(datos.event, clave)).status, 200);
    stellar.rumboPass.status = async () => {
      throw new Error("la base se cayó");
    };
    globalThis.__rumboRepo = new Proxy(repo, {
      get(target, prop) {
        if (prop === "listTicketTypes") return async () => {
          throw new Error("la base se cayó");
        };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { resultado: caida } = await capturarConsola(() => pedir(datos.event, clave));
    globalThis.__rumboRepo = repo;
    assert.equal(caida.status, 502);
    stellar.rumboPass.status = async () => ({ has_pass: true, number: 1, checked_in: false, redeemed: [] });
    assert.equal((await pedir(datos.event, clave)).status, 200, "después de una que falló se puede volver a pedir");
  } finally {
    globalThis.__rumboRepo = repo;
    Object.assign(stellar.rumboPass, original);
  }
});

test("el panel dice que ya hay una verificación en curso, en los dos idiomas", () => {
  assert.match(textosPanel.es["panel.cadena.enCurso"], /^Ya hay una verificación del registro en curso/);
  assert.match(textosPanel.en["panel.cadena.enCurso"], /^A check of the event record is already running/);
  const pantalla = readFileSync(join(APP_DIR, "src", "components", "panel", "PanelCliente.tsx"), "utf8");
  assert.match(pantalla, /if \(res\.status === 409\) \{[^}]*t\("panel\.cadena\.enCurso"\)/s);
});

test("si el correo no sale, el registro del servidor lleva el id de la persona y no su correo", async () => {
  const repo = getRepo();
  const datos = await eventoDePrueba(repo);
  const { person, pass } = await paseDePrueba(repo, datos, { email: "valeria.privada@example.com" });
  const anterior = globalThis.__rumboMailer;
  globalThis.__rumboMailer = {
    kind: "dev",
    send: async (mail) => {
      throw new Error(`el proveedor rechazó a ${mail.to}`);
    },
  };
  try {
    // ya tenía su credencial: se le reenvía el enlace por correo, y el envío falla
    const { resultado, lineas } = await capturarConsola(() =>
      registerForEvent({ slug: datos.event.slug, ticketTypeId: datos.ticket.id, name: person.name, email: person.email, lang: "es" }),
    );
    assert.equal(resultado.kind, "existing");
    const aviso = lineas.find((l) => l.includes("No se pudo mandar el correo"));
    assert.ok(aviso, lineas.join("\n"));
    assert.ok(aviso.includes(person.id) && aviso.includes(pass.id), aviso);
    assert.ok(!lineas.some((l) => l.includes("valeria.privada")), lineas.join("\n"));
  } finally {
    globalThis.__rumboMailer = anterior;
  }
});
