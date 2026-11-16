# La inscripción y la credencial

Lo que pasa entre la página pública del evento y la credencial con QR. Las pantallas viven en `src/app/e/[slug]` (el afiche, el formulario y la confirmación) y `src/app/p/[passId]` (la credencial); los componentes en `src/components/evento`; los textos en `src/i18n/evento.ts`.

## El recorrido

1. `/e/<evento>` muestra el afiche (nombre, fecha, lugar, qué incluye) y una tarjeta por entrada, cada una con su único botón: "Inscribirme" si es gratis, "Comprar" si es paga (debajo, "o con el QR del banco" queda deshabilitado y marcado "pronto").
2. `/e/<evento>/inscripcion?entrada=<id>` pide el nombre y el correo. Una sola acción: "Confirmar inscripción" o "Pagar 10 USDC de prueba". Mientras la red confirma, el botón dice "Creando tu credencial".
3. La acción del formulario (`inscripcion/actions.ts`) llama a `publicRegistration` (`inscripcion.ts`), la puerta pública: mira si el evento entra solo por lista (abajo) y, si no, sigue con `registerForEvent`, que crea o busca a la persona, le pide su cuenta al `AccountProvider`, llama a `register` (gratis) o a `buy` (paga: la plata sale de la cuenta de la persona y el servidor paga la comisión de red), guarda el pase, le da los beneficios de su entrada, crea la clave de acceso y prepara el correo con el enlace personal (sale cuando el servicio de correo exista; mientras tanto, el enlace queda en la pantalla de confirmación).
4. `/e/<evento>/listo?pase=<id>&k=<clave>` dice "Inscripción lista" o "Entrada paga" y lleva a la credencial.
5. `/p/<id>?k=<clave>` es la credencial: el evento, el nombre, "Credencial N de M", el estado (inscripción lista, entrada paga o ya entró), el QR grande, que se renueva solo cada 20 segundos (lo arma el celular, sin red, con lo que la credencial recibe al abrirse: `QrRotante.tsx`), y lo que le toca a la persona con su chip. "Descargar en SVG" baja la versión para imprimir (100 por 150 milímetros), con un QR fijo marcado como "Credencial impresa".

## La clave de acceso

El enlace personal lleva `k=<clave>`: un secreto al azar por pase (dieciséis bytes en base64url) guardado en la tabla `pass_access` (migración `002-acceso-credencial.sql`). No es la llave del QR y no sirve para entrar ni para canjear: solo abre la página (y con ella el servidor entrega lo que el celular necesita para armar el QR de ese pase y de ningún otro). Sin la clave correcta la credencial responde 404 sin decir si el pase existe. A quien vuelve a inscribirse con un correo que ya tiene credencial se le reenvía el enlace por correo (cuando el servicio exista; hoy no sale nada), y la pantalla no se lo muestra: así nadie abre la credencial de otra persona escribiendo su correo.

## El estado en la credencial

`credencial.ts` arma la vista desde el espejo de la base (pases, check-ins, canjes). Cuando la base dice que algo todavía no pasó, lo confirma con `status()` en la cadena, con un tope de cuatro segundos: si la red no contesta, vale el espejo. Los estados de cada beneficio: pendiente, canjeado, pagada (para retirar), para retirar, en el sorteo, ganado y entregado.

## La API

| Ruta | Qué hace |
|---|---|
| `GET /api/evento/<slug>` | Lo público del evento, sus entradas con lo que incluye cada una y el catálogo de beneficios |
| `POST /api/evento/<slug>/inscripcion` | Inscribe o cobra, igual que el formulario. Cuerpo `{ ticketTypeId, name, email, lang? }`. Devuelve `201 { status: "created", passId, url, paid }` o `200 { status: "existing" }`; `400` campos, `402` sin pago, `404` evento o entrada, `403` el evento entra solo por lista, `409` sin lugares, `429` demasiados pedidos seguidos, `502` red |
| `GET /api/pase/<id>?k=<clave>` | La credencial como datos, con el QR fijo de la impresa (`qr`) y lo que el celular necesita para armar el que rota (`live`) |
| `GET /api/pase/<id>/svg?k=<clave>[&lang=es\|en][&ver=1]` | La credencial para imprimir. Por defecto se descarga; con `ver=1` se muestra |

## Los eventos que entran solo por lista

Hay eventos cuya inscripción corre por fuera (otra plataforma, un formulario propio) y acá solo se importa la lista aprobada. Se anotan en `RUMBO_LIST_ONLY_EVENTS` (el final de su `/e/<evento>`, separados por coma; ver `.env.example`) y `por-lista.ts` los reconoce. Para esos eventos:

- No salen en el inicio, y su página muestra el afiche con una línea en lugar de las entradas: "La inscripción a este evento la lleva quien organiza". Se abre con su enlace y no se ofrece a los buscadores. `/e/<evento>/inscripcion` y `/e/<evento>/equipo` vuelven a esa página.
- Ninguna puerta pública inscribe: el formulario, el formulario con la cuenta propia y su paso de firma, el de equipos y la API (`403 { error: "list_only" }`, también en `.../inscripcion/firma`) contestan que no, sin guardar nada. Vale igual si se entra por una dirección vieja del evento: primero se resuelve el evento y después se mira su dirección de ahora.
- Lo que pide quien organiza sigue andando: importar la lista, "Agregar en la puerta", el panel, el escáner y las herramientas del asistente. Por eso el freno no vive en `registerForEvent`, que también usa la puerta, sino en `publicRegistration`, `publicCompletion` y `registerTeam`. Una ruta nueva que inscriba a pedido de la persona tiene que pasar por ahí (`tests/inscripcion-por-lista.test.mjs` lo comprueba).
- `GET /api/evento/<slug>` lo dice con `event.registration: "list_only"`.

Quien está en la lista y ya tiene su cuenta propia con ese correo no recibe la credencial por la importación (el servidor no firma por ella) y en estos eventos tampoco puede inscribirse sola: hay que importarla con otro correo.

## Los frenos

Cada inscripción nueva crea una cuenta, la fondea, le abre la línea de confianza, le da saldo y manda una transacción, todo pagado por el servidor; con correos inventados, además, se llenaría el cupo. Por eso (`src/server/limites.ts`):

- **Por quién pide:** sesenta pedidos por IP en diez minutos (generoso para una fila que se inscribe en la puerta con el wifi del evento), y seiscientos en total. La IP es la que pone la plataforma, no la que dice el pedido (ver `RUMBO_TRUSTED_IP_HEADER` en `.env.example`). Se cuentan todos los pedidos, con correo nuevo o conocido, y el freno responde igual para los dos: `429 { error: "too_many" }`.
- **Por correo:** a quien ya tenía su credencial el enlace se le reenvía una vez cada diez minutos por evento, se pida desde donde se pida. La respuesta es la misma, se mande o no.

## Probarlo

```bash
node scripts/inscribir-prueba.mjs           # inscripción gratis contra la red de prueba, con todas las comprobaciones
node scripts/inscribir-prueba.mjs --pago    # entrada paga: buy con el USDC de prueba de la cuenta de la persona
node scripts/inscribir-prueba.mjs --api http://localhost:3000   # lo mismo por la API de un servidor levantado
```

El script inscribe a una persona de prueba, lee `status()` en la cadena, verifica la firma de los dos QR (el impreso, y el del celular con su ventana de tiempo) y la clave de acceso, arma el SVG (queda en `data/`) y comprueba que inscribirse otra vez con el mismo correo no crea otro pase.

## Lo que falta

- El SVG se descarga; la versión en PDF (con `resvg`) todavía no está.
- Reabrir la credencial sin conexión: el QR se arma sin red mientras la página está abierta, pero si el navegador la descarta y se vuelve a abrir sin señal, la página no carga. Pide un service worker para `/p/`, como el del escáner.
- Un desafío contra bots en el formulario (Turnstile, hCaptcha o parecido): pide elegir el servicio.
- Que la respuesta no diga si el correo ya estaba inscripto: hoy una inscripción nueva muestra el enlace en pantalla y una conocida no (y tarda distinto, porque la nueva pasa por la red). Igualarlas pide decidir el recorrido, por ejemplo confirmar siempre por correo antes de mostrar la credencial.
