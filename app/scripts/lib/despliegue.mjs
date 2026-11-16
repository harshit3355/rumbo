// Lo que pnpm setup:dev decide antes de tocar la red, sin red ni archivos: qué despliegue le sirve a esta máquina
// (el de muestra o uno propio) y qué quiere decir un error al leer un contrato. Va aparte del guion para poder
// probarlo (tests/setup-dev-modo.test.mjs): de estas decisiones depende que la máquina que tiene las llaves del
// despliegue de muestra no arme nunca un despliegue propio pagando con esa cuenta, y que un tropiezo del nodo no
// termine en contratos desplegados de más.

/** Las cinco llaves de .env.local, con el nombre con el que se guardan sus claves públicas en un despliegue. */
export const KEY_NAMES = {
  sponsor: "STELLAR_SPONSOR_SECRET",
  gate: "STELLAR_GATE_SECRET",
  issuer: "STELLAR_ISSUER_SECRET",
  organizer: "STELLAR_ORGANIZER_SECRET",
  treasury: "STELLAR_TREASURY_SECRET",
};

const samePathOn = (platform) => (a, b) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Las claves públicas del despliegue de muestra: sus cuatro cuentas y el emisor de su USDC de prueba. */
function samplePublicKeys(sample) {
  return [sample?.accounts?.sponsor, sample?.accounts?.gate, sample?.accounts?.organizer, sample?.accounts?.treasury, sample?.asset?.issuer].filter((key) => typeof key === "string" && key);
}

/**
 * Qué despliegue le sirve a esta máquina.
 *
 *   sample      el despliegue de muestra (contracts/rumbo-pass/deploy/testnet.json), o null si no se pudo leer
 *   keys        las claves públicas de las llaves de .env.local: { sponsor, gate, issuer, organizer, treasury }, con
 *               null en la que falta (el guion la genera)
 *   configured  la ruta absoluta de RUMBO_DEPLOY_JSON, o null si no está definida
 *   localPath   la ruta absoluta del despliegue propio (data/despliegue-local.json)
 *
 * Devuelve:
 *   own           true si hay que armar (o revisar) un despliegue propio; false si se usa el de muestra o el que se
 *                 eligió a mano
 *   sampleServes  si el de muestra sirve con estas llaves: su puerta, que firma entradas y canjes, y su emisor, que
 *                 da el saldo de prueba. Las otras cuentas solo pagan o reciben
 *   problem       null, o por qué no se puede armar el despliegue propio con estas llaves: alguna es del despliegue
 *                 de muestra. Esas cuentas las usa otro servidor; dos máquinas mandando con la misma cuenta que paga
 *                 se pisan el número de secuencia. El guion corta ahí, antes de tocar la red
 */
export function deployMode({ sample, keys, configured, localPath, platform = process.platform }) {
  const sampleServes = Boolean(sample) && Boolean(keys.gate) && keys.gate === sample.accounts?.gate && Boolean(keys.issuer) && keys.issuer === sample.asset?.issuer;
  // Despliegue propio: si ya se usa el de data/, o si no hay otro elegido a mano y el de muestra no sirve con estas llaves.
  const own = configured ? samePathOn(platform)(configured, localPath) : Boolean(sample) && !sampleServes;
  if (!own) return { own, sampleServes, problem: null };

  const ofSample = new Set(samplePublicKeys(sample));
  const shared = Object.entries(KEY_NAMES)
    .filter(([name]) => keys[name] && ofSample.has(keys[name]))
    .map(([, envName]) => envName);
  if (shared.length === 0) return { own, sampleServes, problem: null };
  if (sampleServes) {
    return {
      own,
      sampleServes,
      problem:
        "las llaves de .env.local son las del despliegue de muestra y RUMBO_DEPLOY_JSON apunta al despliegue propio. Con estas llaves no se arma uno propio: sacá la línea RUMBO_DEPLOY_JSON de .env.local y corré de nuevo.",
    };
  }
  return {
    own,
    sampleServes,
    problem: `.env.local mezcla llaves del despliegue de muestra (${shared.join(", ")}) con otras que no lo son o que faltan, y con esa mezcla no se arma un despliegue propio. Si esta máquina es la del despliegue de muestra, restaurá su .env.local entero. Si no, borrá de .env.local las cinco líneas STELLAR_*_SECRET y corré de nuevo: se generan las cinco propias.`,
  };
}

/**
 * Si el error de leer un contrato dice que ese contrato no está en la red, o que no es un rumbo-pass (no tiene la
 * función que se le pidió). Cualquier otro error de simulación (el nodo que contesta mal un momento) no dice nada
 * del contrato: con uno de esos no se da el contrato por perdido ni se despliega otro en su lugar.
 */
export function saysNotOurContract(error) {
  const text = `${error?.message ?? ""} ${error?.detail ?? ""}`;
  return /Error\(Storage, MissingValue\)|non-existing value for contract instance|Error\(WasmVm, MissingValue\)|non-existent contract function|symbol not found in slice of strs/i.test(text);
}
