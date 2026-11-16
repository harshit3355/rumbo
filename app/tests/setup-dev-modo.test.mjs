// Qué despliegue arma pnpm setup:dev según las llaves de la máquina (scripts/lib/despliegue.mjs). Sin red y sin
// archivos: las claves públicas son de mentira. De esta decisión depende que la máquina que tiene las llaves del
// despliegue de muestra no arme nunca un despliegue propio, y que nadie arme uno pagando con una cuenta de muestra.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_DIR } from "./lib/entorno.mjs";

const { KEY_NAMES, deployMode, saysNotOurContract } = await import("../scripts/lib/despliegue.mjs");

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

test("un contrato se da por perdido solo si la red dice que no está o que no es un rumbo-pass", () => {
  // Los dos primeros son lo que contestó la red de prueba al leer info() el 16-nov-2026: un id que no existe y el
  // contrato del USDC de prueba. El tercero es el de un contrato de otro código que no tiene esa función.
  const noExiste = { message: "El contrato rechazó la operación: HostError: Error(Storage, MissingValue)", detail: 'null | "trying to get non-existing value for contract instance"' };
  const otroContrato = { message: "El contrato rechazó la operación: HostError: Error(Value, InvalidInput)", detail: 'null | ["symbol not found in slice of strs","info"]' };
  const sinEsaFuncion = { message: "El contrato rechazó la operación: HostError: Error(WasmVm, MissingValue)", detail: '"trying to invoke non-existent contract function" | "info"' };
  for (const error of [noExiste, otroContrato, sinEsaFuncion, { message: noExiste.message, detail: null }]) assert.equal(saysNotOurContract(error), true, error.message);

  // Un tropiezo del nodo, un límite, un error del propio contrato o algo que no es un error de simulación: no dicen nada del contrato.
  const noDicenNada = [
    { message: "El contrato rechazó la operación: HostError: Error(Budget, ExceededLimit)", detail: null },
    { message: "El contrato rechazó la operación: internal error", detail: null },
    { message: "El contrato rechazó la operación: HostError: Error(Contract, #3) [NotInitialized]", detail: null },
    { message: "El contrato rechazó la operación: HostError: Error(Value, InvalidInput)", detail: null },
    new Error("fetch failed"),
    new Error("Invalid contract ID: CNOESUNID"),
    null,
    undefined,
    "no existe",
  ];
  for (const error of noDicenNada) assert.equal(saysNotOurContract(error), false, String(error?.message ?? error));

  // El guion lo usa así: un id mal formado es un contrato que falta, y solo ese error lleva a desplegar otro.
  const guion = readFileSync(join(APP_DIR, "scripts", "setup-dev.mjs"), "utf8");
  assert.match(guion, /if \(!StrKey\.isValidContract\(contractId\)\) return null;/);
  assert.match(guion, /if \(stellar\.isContractError\(error\) && saysNotOurContract\(error\)\) return null;\s+throw error;/);
  assert.doesNotMatch(guion, /if \(stellar\.isContractError\(error\)\) return null;/);
});

test("el guion no toma el turno de la cuenta que paga en ninguna base: fija sqlite antes de cargar el servidor", async () => {
  const guion = readFileSync(join(APP_DIR, "scripts", "setup-dev.mjs"), "utf8");
  const fija = guion.indexOf('process.env.RUMBO_REPO = "sqlite";');
  assert.ok(fija > 0, "el guion no fija el motor de la base");
  assert.ok(fija > guion.indexOf("loadEnv();"), "se fija después de leer .env.local, que si no lo pisaría");
  const cargas = [...guion.matchAll(/import\("\.\.\/src\/server\/[^"]+"\)/g)];
  assert.ok(cargas.length >= 2, "el guion ya no carga el servidor como se esperaba");
  assert.ok(cargas.every((carga) => carga.index > fija), "algo de src/server se carga antes de fijar el motor");
  assert.doesNotMatch(guion, /^import .* from "\.\.\/src\/server\//m, "un import de arriba se carga antes que todo");
  assert.doesNotMatch(guion, /base\/index\.ts|closeDb|getDb\(/, "el guion no abre ni cierra ninguna base");

  // Y con sqlite, el turno de la cuenta que paga no toca la base: es la fila de este proceso.
  const anterior = { repo: process.env.RUMBO_REPO, url: process.env.DATABASE_URL };
  process.env.RUMBO_REPO = "sqlite";
  process.env.DATABASE_URL = "postgres://nadie:nada@127.0.0.1:9/no-existe";
  try {
    const { serialized, tryExclusive } = await import("../src/server/compartido.ts");
    assert.equal(await serialized("sponsor", async () => "sin base"), "sin base");
    assert.equal(await tryExclusive("sponsor", async () => "sin base"), "sin base");
  } finally {
    for (const [name, value] of [["RUMBO_REPO", anterior.repo], ["DATABASE_URL", anterior.url]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("ninguna llave sale del guion como argumento de otro programa, y no lleva rutas de una máquina", () => {
  const guion = readFileSync(join(APP_DIR, "scripts", "setup-dev.mjs"), "utf8");
  assert.doesNotMatch(guion, /child_process|spawn|exec(File)?Sync|--source-account/, "el guion le pasa algo a otro programa");
  assert.doesNotMatch(guion, /[A-Za-z]:\\\\|\/Users\/|\/home\//, "el guion lleva una ruta de una máquina");
  assert.match(guion, /await deploySacWithSdk\(asset\);/);
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
