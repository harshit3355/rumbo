// Prepara el entorno de desarrollo en la red de prueba de Stellar:
//   1. genera en .env.local las llaves que falten (servidor, puerta, emisor del USDC de prueba, quien organiza, Rumbo),
//   2. fondea cada cuenta con friendbot,
//   3. despliega el USDC de prueba como contrato de activo (SAC) con stellar-cli, si no está,
//   4. deja con línea de confianza a quien organiza y a Rumbo, para que puedan recibir el pago,
//   5. y, si las llaves no son las del despliegue de muestra, arma un despliegue propio (abajo).
// Se puede correr las veces que haga falta: solo hace lo que falta. Nunca toca otra red que la de prueba.
//
// El despliegue de muestra (contracts/rumbo-pass/deploy/testnet.json) sirve solo con las llaves de quien lo desplegó:
// sus contratos aceptan esa puerta y cobran en el USDC de ese emisor. Con esas llaves en .env.local, este script usa
// su activo y sus cuentas, como siempre. Con otras (un clon nuevo), la entrada se rechazaría y el canje no tendría
// quien lo firme, así que arma un despliegue propio: escribe data/despliegue-local.json con la misma forma (el mismo
// código de contrato, que ya está subido a la red de prueba, el USDC de prueba y las cuentas de esta máquina),
// despliega un contrato gratis y uno pago con el mismo desplegador que usa la app al publicar un evento, y deja
// RUMBO_DEPLOY_JSON apuntando ahí. Todo queda en data/, que git ignora.
//
// Con despliegue propio, .env.local se escribe una sola vez y al final. Si la red de prueba o friendbot no contestan,
// queda como estaba y alcanza con correr de nuevo.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { KEY_NAMES, deployMode } from "./lib/despliegue.mjs";
import { APP_DIR, ENV_PATH, loadEnv, readEnvFile, upsertEnv } from "./lib/env.mjs";

process.chdir(APP_DIR);
const envExisted = existsSync(ENV_PATH);
loadEnv();

if ((process.env.STELLAR_NETWORK || "testnet") !== "testnet") {
  console.error(`Este script solo trabaja con la red de prueba (STELLAR_NETWORK=${process.env.STELLAR_NETWORK}).`);
  process.exit(1);
}

const { Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder, rpc, xdr } = await import("@stellar/stellar-sdk");
const stellar = await import("../src/server/stellar.ts");

const STELLAR_CLI = process.env.STELLAR_CLI || "C:\\Users\\ASUS\\AppData\\Local\\Programs\\stellar-cli\\stellar.exe";

const KEYS = [
  ["STELLAR_SPONSOR_SECRET", "El servidor (paga las comisiones de red)", "sponsor"],
  ["STELLAR_GATE_SECRET", "La puerta (firma check-ins y canjes)", "gate"],
  ["STELLAR_ISSUER_SECRET", "El emisor del USDC de prueba", null],
  ["STELLAR_ORGANIZER_SECRET", "Quien organiza el evento de muestra", "organizer"],
  ["STELLAR_TREASURY_SECRET", "Rumbo (recibe la comisión)", "treasury"],
];

// ---------- Qué despliegue le sirve a esta máquina ----------

const SAMPLE_PATH = join(APP_DIR, "..", "contracts", "rumbo-pass", "deploy", "testnet.json");
/** Lo que queda en RUMBO_DEPLOY_JSON: relativo a la carpeta app, que es desde donde corren la app y los scripts. */
const LOCAL_ENV_VALUE = "./data/despliegue-local.json";
const LOCAL_PATH = resolve(APP_DIR, LOCAL_ENV_VALUE);
/** El despliegue propio se arma acá y pasa a su lugar recién cuando está entero. */
const WORK_PATH = join(dirname(LOCAL_PATH), "despliegue-local.en-curso.json");
/** Los dos contratos de muestra, si el despliegue de muestra no dice cómo son. */
const SAMPLE_EVENTS = {
  paid: { label: "pago", price: 10, capacity: 1000, benefits: 2 },
  free: { label: "gratis", price: 0, capacity: 1000, benefits: 1 },
};

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
const publicOf = (name) => (process.env[name] ? Keypair.fromSecret(process.env[name]).publicKey() : null);

const sample = readJson(SAMPLE_PATH);
// El de muestra, si sirve con estas llaves; si no, uno propio. Y con qué llaves no se arma uno propio (lib/despliegue.mjs).
const mode = deployMode({
  sample,
  keys: Object.fromEntries(Object.entries(KEY_NAMES).map(([name, envName]) => [name, publicOf(envName)])),
  configured: process.env.RUMBO_DEPLOY_JSON ? resolve(APP_DIR, process.env.RUMBO_DEPLOY_JSON) : null,
  localPath: LOCAL_PATH,
});
const own = mode.own;

// ---------- Escribir .env.local, y qué pasa si algo falla ----------

/** Con despliegue propio, lo que va a .env.local se junta acá y se escribe al final, todo junto. */
const pendingEnv = {};
function saveEnv(values) {
  if (!own) return upsertEnv(values);
  Object.assign(pendingEnv, values);
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

/** Un problema que no se arregla reintentando: el mensaje dice qué hacer. */
class SetupError extends Error {}

function describe(error) {
  const parts = [];
  for (let e = error, depth = 0; e && depth < 3; e = e.cause, depth++) {
    const text = typeof e === "object" ? String(e.message ?? "") : String(e);
    const code = typeof e === "object" && e.code ? ` (${e.code})` : "";
    if (text || code) parts.push(`${text}${code}`.trim());
  }
  return parts.join(": ").slice(0, 400) || "sin más detalle";
}

/** En qué andaba el script, para decirlo si falla. */
let step = "preparaba las llaves";
/** Con despliegue propio: si .env.local ya se escribió, entero. */
let saved = false;

function fail(error) {
  clearTimeout(watchdog);
  rmSync(WORK_PATH, { force: true });
  if (own && !saved && !envExisted) rmSync(ENV_PATH, { force: true });
  if (error instanceof SetupError) {
    console.error(`\nNo pude terminar: ${error.message}`);
  } else {
    console.error(`\nNo pude terminar: algo falló mientras ${step}.`);
    console.error(`  ${describe(error)}`);
    console.error("Casi siempre es la red de prueba de Stellar o friendbot, que a veces no contestan. Esperá un minuto y corré de nuevo: pnpm setup:dev");
  }
  console.error(own && !saved ? "No cambié .env.local ni el despliegue que había: quedó todo como estaba." : "Lo que ya estaba hecho queda hecho: al correr de nuevo sigue desde ahí.");
  process.exit(1);
}

/** Si la red deja un pedido colgado, el script no espera para siempre. */
const MAX_MINUTES = 5;
const watchdog = setTimeout(() => fail(new Error(`pasaron ${MAX_MINUTES} minutos y la red no terminó de contestar`)), MAX_MINUTES * 60_000);
watchdog.unref();

// ---------- El USDC de prueba ----------

async function sacExists(sacId) {
  try {
    await stellar.getRpc().getContractData(sacId, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
    return true;
  } catch {
    return false;
  }
}

function deploySacWithCli(code, issuer) {
  if (!existsSync(STELLAR_CLI)) return false;
  const result = spawnSync(
    STELLAR_CLI,
    ["contract", "asset", "deploy", "--asset", `${code}:${issuer.publicKey()}`, "--source-account", process.env.STELLAR_SPONSOR_SECRET, "--network", "testnet"],
    { encoding: "utf8" },
  );
  if (result.status === 0) return true;
  if (/already|exist/i.test(result.stderr || "")) return true;
  console.warn(`stellar-cli no pudo desplegar el activo: ${(result.stderr || "").trim().slice(0, 300)}`);
  return false;
}

async function deploySacWithSdk(asset) {
  const server = stellar.getRpc();
  const sponsor = stellar.getSponsor();
  const account = await server.getAccount(sponsor.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(sponsor);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`La red no aceptó el despliegue del activo: ${sent.errorResult?.result.type}`);
  const final = await server.pollTransaction(sent.hash, { attempts: 40 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`El despliegue del activo no se confirmó (${final.status})`);
}

// ---------- El despliegue propio ----------

/**
 * Deja en data/despliegue-local.json un despliegue que sirve con las llaves de esta máquina, y lo devuelve.
 * Lo que ya había y sirve se queda: un contrato se vuelve a desplegar solo si falta, si es de otro código, si acepta
 * otra puerta u otro USDC, o si se llenó. `deployed` dice cuáles se desplegaron ahora.
 */
async function ownDeployment({ keypairs, code, sacId }) {
  step = "revisaba el despliegue propio";
  if (!sample || typeof sample.wasmHash !== "string") {
    throw new SetupError("para armar el despliegue propio hace falta contracts/rumbo-pass/deploy/testnet.json, que dice qué código de contrato está subido a la red de prueba.");
  }
  const accounts = {
    organizer: keypairs.STELLAR_ORGANIZER_SECRET.publicKey(),
    treasury: keypairs.STELLAR_TREASURY_SECRET.publicKey(),
    gate: keypairs.STELLAR_GATE_SECRET.publicKey(),
    sponsor: keypairs.STELLAR_SPONSOR_SECRET.publicKey(),
  };
  // Cómo es cada contrato de muestra: como en el despliegue de muestra, así el seed y las pruebas andan igual.
  const specs = {};
  for (const [name, fallback] of Object.entries(SAMPLE_EVENTS)) {
    const from = sample.events?.[name];
    specs[name] = from
      ? { label: fallback.label, price: stellar.fromStroops(from.price ?? "0"), capacity: Number(from.capacity) || fallback.capacity, benefits: Number(from.benefits ?? fallback.benefits) }
      : fallback;
  }

  /** Lo que dice el contrato en la red, si sirve con estas llaves; null si no existe o no sirve. */
  async function serving(contractId, spec) {
    let info;
    try {
      info = await stellar.rumboPass.info(contractId);
    } catch (error) {
      if (stellar.isContractError(error)) return null; // la red contestó: ese contrato no está, o no es un rumbo-pass
      throw error;
    }
    const fits =
      info.gate === accounts.gate &&
      info.organizer === accounts.organizer &&
      info.treasury === accounts.treasury &&
      info.asset === sacId &&
      info.price === stellar.toStroops(spec.price) &&
      info.capacity === spec.capacity &&
      info.benefits === spec.benefits &&
      info.issued < info.capacity;
    return fits ? info : null;
  }
  const entry = (contract, spec, info) => ({
    contract,
    price: stellar.toStroops(spec.price).toString(),
    feeBps: info.fee_bps,
    capacity: spec.capacity,
    benefits: spec.benefits,
    explorer: `https://stellar.expert/explorer/testnet/contract/${contract}`,
  });

  const previous = readJson(LOCAL_PATH);
  const local = {
    network: "testnet",
    networkPassphrase: Networks.TESTNET,
    rpcUrl: process.env.STELLAR_RPC_URL || sample.rpcUrl,
    horizonUrl: process.env.STELLAR_HORIZON_URL || sample.horizonUrl,
    friendbotUrl: process.env.STELLAR_FRIENDBOT_URL || sample.friendbotUrl,
    deployedAt: previous?.deployedAt ?? null,
    wasmHash: sample.wasmHash,
    wasmBytes: sample.wasmBytes,
    asset: { code, issuer: keypairs.STELLAR_ISSUER_SECRET.publicKey(), contract: sacId, decimals: stellar.ASSET_DECIMALS, name: sample.asset?.name },
    accounts,
    events: {},
  };

  // Lo que ya había y sirve
  const missing = [];
  for (const [name, spec] of Object.entries(specs)) {
    const before = previous?.wasmHash === sample.wasmHash ? previous?.events?.[name]?.contract : null;
    const info = typeof before === "string" ? await serving(before, spec) : null;
    if (info) local.events[name] = entry(before, spec, info);
    else missing.push(name);
  }

  if (missing.length > 0) {
    console.log(
      previous
        ? `\nAl despliegue propio (${LOCAL_ENV_VALUE}) le falta un contrato que sirva con estas llaves: despliego lo que falta`
        : `\nLas llaves de .env.local no son las del despliegue de muestra: armo un despliegue propio en ${LOCAL_ENV_VALUE}`,
    );
    step = "buscaba el código del contrato en la red de prueba";
    try {
      await stellar.getRpc().getContractWasmByHash(sample.wasmHash, "hex");
    } catch (error) {
      if (error?.code !== 404) throw error;
      throw new SetupError(
        `el código del contrato (${sample.wasmHash}) no está en la red de prueba. Pasa cuando la red se reinicia: hay que volver a subirlo como dice contracts/rumbo-pass/README.md y traer el testnet.json nuevo.`,
      );
    }

    // El desplegador de la app lee el despliegue de RUMBO_DEPLOY_JSON: mientras se arma, el de trabajo.
    mkdirSync(dirname(LOCAL_PATH), { recursive: true });
    const writeWork = () => writeFileSync(WORK_PATH, `${JSON.stringify(local, null, 2)}\n`, "utf8");
    writeWork();
    process.env.RUMBO_DEPLOY_JSON = WORK_PATH;
    const { networkProvisioner } = await import("../src/server/kit/publicar.ts");
    for (const name of missing) {
      const spec = specs[name];
      step = `desplegaba el contrato ${spec.label} de muestra`;
      const contract = await networkProvisioner.deploy({ price: spec.price, capacity: spec.capacity, benefits: spec.benefits, organizerAccount: null });
      const info = await serving(contract, spec);
      if (!info) throw new Error(`el contrato ${spec.label} recién desplegado (${contract}) no quedó con la puerta y el USDC de esta máquina`);
      local.events[name] = entry(contract, spec, info);
      writeWork();
      console.log(`Desplegado  El contrato ${spec.label} de muestra: ${contract}`);
    }
    local.deployedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    // En el orden del despliegue de muestra, para que los dos archivos se lean igual.
    local.events = Object.fromEntries(Object.keys(specs).map((name) => [name, local.events[name]]));
  }

  step = "guardaba el despliegue propio";
  if (JSON.stringify(local) !== JSON.stringify(previous)) {
    mkdirSync(dirname(LOCAL_PATH), { recursive: true });
    writeFileSync(WORK_PATH, `${JSON.stringify(local, null, 2)}\n`, "utf8");
    renameSync(WORK_PATH, LOCAL_PATH);
  }
  process.env.RUMBO_DEPLOY_JSON = LOCAL_ENV_VALUE;
  if (missing.length === 0) console.log(`Ya existía  El despliegue propio: ${LOCAL_ENV_VALUE}`);
  return { local, deployed: missing };
}

// ---------- Los pasos ----------

async function main() {
  // Si el evento de muestra ya se sembró, sus entradas apuntan a los contratos de antes.
  const seeded = process.env.RUMBO_REPO === "postgres" || existsSync(resolve(APP_DIR, process.env.RUMBO_DATA_DIR || "./data", "rumbo.db"));

  // Antes de generar una llave o de tocar la red: un despliegue propio no se arma con llaves del de muestra.
  if (mode.problem) throw new SetupError(mode.problem);

  // 1. Las llaves que falten
  const generated = {};
  for (const [name] of KEYS) {
    if (!process.env[name]) generated[name] = Keypair.random().secret();
  }
  if (Object.keys(generated).length > 0) {
    saveEnv(generated);
    if (!own) console.log(`Generé ${Object.keys(generated).join(", ")} en .env.local`);
  }
  const keypairs = Object.fromEntries(KEYS.map(([name]) => [name, Keypair.fromSecret(process.env[name])]));

  // Si el contrato ya se desplegó con otras cuentas, conviene saberlo: la app firma con las de .env.local.
  // Con despliegue propio no hay nada que avisar: se arma con las de .env.local.
  const deploy = own ? null : stellar.readDeployInfo();
  for (const [name, description, deployKey] of KEYS) {
    const expected = deployKey ? deploy?.accounts?.[deployKey] : deploy?.asset?.issuer;
    if (expected && expected !== keypairs[name].publicKey()) {
      console.warn(`Ojo: ${description} en .env.local es ${keypairs[name].publicKey()} y el despliegue del contrato usa ${expected}.`);
    }
  }

  // 2. Fondear con friendbot
  step = "fondeaba las cuentas con friendbot";
  for (const [name, description] of KEYS) {
    const keypair = keypairs[name];
    const funded = await stellar.fundWithFriendbot(keypair.publicKey());
    console.log(`${funded ? "Fondeada  " : "Ya existía"}  ${description}: ${keypair.publicKey()}`);
  }

  // 3. El USDC de prueba como contrato de activo
  step = "desplegaba el USDC de prueba";
  const code = deploy?.asset?.code || process.env.STELLAR_ASSET_CODE || "USDC";
  const issuer = keypairs.STELLAR_ISSUER_SECRET;
  const asset = new Asset(code, issuer.publicKey());
  const sacId = asset.contractId(Networks.TESTNET);
  saveEnv({ STELLAR_ASSET_CODE: code, STELLAR_ASSET_ISSUER: issuer.publicKey(), STELLAR_ASSET_CONTRACT: sacId });

  if (await sacExists(sacId)) {
    console.log(`Ya existía  El contrato del USDC de prueba: ${sacId}`);
  } else {
    if (!deploySacWithCli(code, issuer)) await deploySacWithSdk(asset);
    console.log(`Desplegado  El contrato del USDC de prueba: ${sacId}`);
  }

  // 4. Líneas de confianza de quien recibe pagos
  step = "agregaba las líneas de confianza al USDC de prueba";
  const receivers = [keypairs.STELLAR_ORGANIZER_SECRET, keypairs.STELLAR_TREASURY_SECRET];
  const withoutTrustline = [];
  for (const keypair of receivers) {
    if (!(await stellar.hasTrustline(keypair.publicKey(), asset))) withoutTrustline.push(keypair);
  }
  if (withoutTrustline.length > 0) {
    await stellar.submitClassic(
      withoutTrustline.map((keypair) => Operation.changeTrust({ asset, source: keypair.publicKey() })),
      withoutTrustline,
    );
    console.log(`Agregada    La línea de confianza al ${code} de prueba para ${withoutTrustline.length} cuenta(s)`);
  } else {
    console.log(`Ya tenían   La línea de confianza al ${code} de prueba: quien organiza y Rumbo`);
  }

  // 5. El despliegue propio, y recién ahí .env.local
  let ownResult = null;
  if (own) {
    ownResult = await ownDeployment({ keypairs, code, sacId });
    step = "escribía .env.local";
    pendingEnv.RUMBO_DEPLOY_JSON = LOCAL_ENV_VALUE;
    const current = readEnvFile();
    const changed = Object.entries(pendingEnv).filter(([name, value]) => current[name] !== value);
    if (changed.length > 0) upsertEnv(Object.fromEntries(changed));
    saved = true;
    if (Object.keys(generated).length > 0) console.log(`Generé ${Object.keys(generated).join(", ")} en .env.local`);
  }

  // Resumen
  const events = Object.entries((own ? ownResult.local.events : deploy?.events) ?? {});
  console.log(`
Listo. Lo que hay en .env.local (las llaves secretas no salen de ahí):

  Servidor (sponsor):         ${keypairs.STELLAR_SPONSOR_SECRET.publicKey()}
  Puerta (gate):              ${keypairs.STELLAR_GATE_SECRET.publicKey()}
  Quien organiza (organizer): ${keypairs.STELLAR_ORGANIZER_SECRET.publicKey()}
  Rumbo (treasury):           ${keypairs.STELLAR_TREASURY_SECRET.publicKey()}
  USDC de prueba:             ${code}:${issuer.publicKey()}
  Su contrato (SAC):          ${sacId}
  Contratos rumbo-pass:       ${events.length ? events.map(([name, e]) => `${name} ${e.contract}`).join("\n                              ") : "todavía no (contracts/rumbo-pass/deploy/testnet.json)"}${
    own ? `\n  Despliegue propio:          ${LOCAL_ENV_VALUE} (RUMBO_DEPLOY_JSON apunta ahí, y git lo ignora)` : ""
  }

Después: pnpm seed (el evento de muestra) y pnpm dev.
`);
  if (ownResult?.deployed.length && seeded) {
    console.log("Los contratos de muestra son nuevos. Si ya tenías sembrado el evento de muestra: pnpm seed -- --refresh, para que sus entradas apunten a estos.\n");
  }

  if (own) {
    // Con Postgres el pool deja las conexiones abiertas un rato: se cierra, así el script termina enseguida.
    const { closeDb } = await import("../src/server/base/index.ts");
    await closeDb().catch(() => undefined);
  }
}

try {
  await main();
  clearTimeout(watchdog);
} catch (error) {
  fail(error);
}
