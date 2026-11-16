// Qué despliegue arma pnpm setup:dev según las llaves de la máquina (scripts/lib/despliegue.mjs). Sin red y sin
// archivos: las claves públicas son de mentira. De esta decisión depende que la máquina que tiene las llaves del
// despliegue de muestra no arme nunca un despliegue propio, y que nadie arme uno pagando con una cuenta de muestra.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_DIR } from "./lib/entorno.mjs";

const { KEY_NAMES, deployMode } = await import("../scripts/lib/despliegue.mjs");

const MUESTRA = {
  asset: { code: "USDC", issuer: "G-MUESTRA-EMISOR" },
  accounts: { organizer: "G-MUESTRA-ORGANIZA", treasury: "G-MUESTRA-RUMBO", gate: "G-MUESTRA-PUERTA", sponsor: "G-MUESTRA-PAGA" },
};
const DE_MUESTRA = { sponsor: "G-MUESTRA-PAGA", gate: "G-MUESTRA-PUERTA", issuer: "G-MUESTRA-EMISOR", organizer: "G-MUESTRA-ORGANIZA", treasury: "G-MUESTRA-RUMBO" };
const PROPIAS = { sponsor: "G-MIA-PAGA", gate: "G-MIA-PUERTA", issuer: "G-MIA-EMISOR", organizer: "G-MIA-ORGANIZA", treasury: "G-MIA-RUMBO" };
const NINGUNA = { sponsor: null, gate: null, issuer: null, organizer: null, treasury: null };
const LOCAL = "/repo/app/data/despliegue-local.json";

const modo = (extra) => deployMode({ sample: MUESTRA, keys: PROPIAS, configured: null, localPath: LOCAL, platform: "linux", ...extra });

test("las cinco llaves tienen su nombre en .env.local", () => {
  assert.deepEqual(KEY_NAMES, {
    sponsor: "STELLAR_SPONSOR_SECRET",
    gate: "STELLAR_GATE_SECRET",
    issuer: "STELLAR_ISSUER_SECRET",
    organizer: "STELLAR_ORGANIZER_SECRET",
    treasury: "STELLAR_TREASURY_SECRET",
  });
});

test("un clon nuevo, sin llaves o con las cinco propias, arma su despliegue propio", () => {
  assert.deepEqual(modo({ keys: NINGUNA }), { own: true, sampleServes: false, problem: null });
  assert.deepEqual(modo({ keys: PROPIAS }), { own: true, sampleServes: false, problem: null });
  // Y la segunda corrida, con RUMBO_DEPLOY_JSON ya apuntando a data/, lo revisa.
  assert.deepEqual(modo({ keys: PROPIAS, configured: LOCAL }), { own: true, sampleServes: false, problem: null });
});

test("con las llaves del despliegue de muestra se usa el de muestra, y nunca se arma uno propio", () => {
  assert.deepEqual(modo({ keys: DE_MUESTRA }), { own: false, sampleServes: true, problem: null });
  // Alcanza con la puerta y el emisor: son lo que el despliegue de muestra le exige a quien lo usa.
  assert.deepEqual(modo({ keys: { ...PROPIAS, gate: DE_MUESTRA.gate, issuer: DE_MUESTRA.issuer } }), { own: false, sampleServes: true, problem: null });
  assert.deepEqual(modo({ keys: { ...NINGUNA, gate: DE_MUESTRA.gate, issuer: DE_MUESTRA.issuer } }), { own: false, sampleServes: true, problem: null });
});

test("con RUMBO_DEPLOY_JSON puesto a mano en otro archivo no se arma nada propio, tenga las llaves que tenga", () => {
  for (const keys of [PROPIAS, DE_MUESTRA, NINGUNA]) {
    assert.deepEqual(modo({ keys, configured: "/repo/app/otro/despliegue.json" }), { own: false, sampleServes: keys === DE_MUESTRA, problem: null });
  }
});

test("las llaves de muestra con RUMBO_DEPLOY_JSON apuntando a data/ no despliegan: el guion corta y dice qué sacar", () => {
  const r = modo({ keys: DE_MUESTRA, configured: LOCAL });
  assert.deepEqual([r.own, r.sampleServes], [true, true]);
  assert.match(r.problem, /son las del despliegue de muestra/);
  assert.match(r.problem, /sacá la línea RUMBO_DEPLOY_JSON de \.env\.local/);
});

test("un .env.local que mezcla llaves de muestra con propias o con huecos no arma un despliegue propio", () => {
  // La cuenta que paga de muestra, y el resto por generar: lo que queda de copiar un .env.local a medias.
  const soloLaQuePaga = modo({ keys: { ...NINGUNA, sponsor: DE_MUESTRA.sponsor } });
  assert.equal(soloLaQuePaga.own, true);
  assert.match(soloLaQuePaga.problem, /mezcla llaves del despliegue de muestra \(STELLAR_SPONSOR_SECRET\)/);
  assert.match(soloLaQuePaga.problem, /borrá de \.env\.local las cinco líneas STELLAR_\*_SECRET/);
  assert.match(soloLaQuePaga.problem, /restaurá su \.env\.local entero/);

  // La de muestra con otro emisor, o sin la puerta.
  assert.match(modo({ keys: { ...DE_MUESTRA, issuer: PROPIAS.issuer } }).problem, /\(STELLAR_SPONSOR_SECRET, STELLAR_GATE_SECRET, STELLAR_ORGANIZER_SECRET, STELLAR_TREASURY_SECRET\)/);
  assert.match(modo({ keys: { ...DE_MUESTRA, gate: null } }).problem, /\(STELLAR_SPONSOR_SECRET, STELLAR_ISSUER_SECRET, STELLAR_ORGANIZER_SECRET, STELLAR_TREASURY_SECRET\)/);
  // Cualquiera de las cinco alcanza para cortar, también una que solo recibe.
  for (const nombre of Object.keys(KEY_NAMES)) {
    if (nombre === "gate" || nombre === "issuer") continue;
    assert.match(modo({ keys: { ...PROPIAS, [nombre]: DE_MUESTRA[nombre] } }).problem, new RegExp(`\\(${KEY_NAMES[nombre]}\\)`), nombre);
  }
  // Una llave de muestra puesta en otro lugar (la que paga usada como puerta) también es de muestra.
  assert.match(modo({ keys: { ...PROPIAS, gate: DE_MUESTRA.sponsor } }).problem, /\(STELLAR_GATE_SECRET\)/);
  // Con el despliegue propio ya en uso, lo mismo.
  assert.match(modo({ keys: { ...PROPIAS, sponsor: DE_MUESTRA.sponsor }, configured: LOCAL }).problem, /\(STELLAR_SPONSOR_SECRET\)/);
});

test("sin el despliegue de muestra a la vista no se arma nada, y la ruta se compara como la compara el sistema", () => {
  assert.deepEqual(modo({ sample: null, keys: PROPIAS }), { own: false, sampleServes: false, problem: null });
  assert.deepEqual(modo({ sample: null, keys: NINGUNA }), { own: false, sampleServes: false, problem: null });
  // En Windows la misma ruta puede venir con otras mayúsculas; en los demás, es otro archivo.
  const enWindows = { localPath: "C:\\repo\\app\\data\\despliegue-local.json", configured: "c:\\Repo\\app\\data\\despliegue-local.json" };
  assert.equal(modo({ ...enWindows, platform: "win32" }).own, true);
  assert.equal(modo({ ...enWindows, platform: "linux" }).own, false);
});

test("el guion decide con esa función y corta antes de generar una llave o de tocar la red", () => {
  const guion = readFileSync(join(APP_DIR, "scripts", "setup-dev.mjs"), "utf8");
  assert.match(guion, /const mode = deployMode\(\{/);
  assert.match(guion, /const own = mode\.own;/);
  const corte = guion.indexOf("if (mode.problem) throw new SetupError(mode.problem);");
  assert.ok(corte > 0, "el guion no corta cuando la decisión trae un problema");
  for (const despues of ["Keypair.random()", "fundWithFriendbot(", "deploySacWithSdk(asset)", "submitClassic(", "ownDeployment({"]) {
    const primera = guion.indexOf(despues, guion.indexOf("async function main()"));
    assert.ok(primera > corte, `${despues} corre antes del corte`);
  }
});
