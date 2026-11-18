## Configuración de KOTAILOR

Este proyecto implementa acceso con Google, sesiones en PostgreSQL, talleres,
clientes, catálogo, órdenes, agenda y facturación administrativa.
No se deben utilizar datos reales de clientes hasta completar los controles de
seguridad, los procedimientos de recuperación y la revisión legal.

### Acceso con Google en desarrollo

1. Copia `.env.example` a `.env` en la raíz del backend. `.env` está excluido
   de Git; no compartas sus valores ni pegues secretos en archivos versionados.
2. En `.env`, configura `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` con los
   valores de un cliente OAuth de tipo aplicación web de Google Cloud.
3. En Google Cloud, registra como URI de redirección autorizada exactamente
   `http://localhost:3000/api/auth/google/callback` para desarrollo. Si la
   pantalla de consentimiento está en modo de prueba, agrega las cuentas
   autorizadas como usuarios de prueba.
4. Genera un valor secreto aleatorio para `SESSION_SECRET` (mínimo 32
   caracteres). Puedes generar uno localmente con
   `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
   y copiarlo directamente a `.env`, sin enviarlo a un chat.
5. Configura `DATABASE_URL` con una conexión PostgreSQL privada. Para el
   contenedor opcional incluido, configura también `POSTGRES_PASSWORD`,
   `POSTGRES_USER`, `POSTGRES_DB` y `POSTGRES_PORT` en `.env`; usa esos mismos
   valores en `DATABASE_URL`. El puerto 55432 es el valor sugerido para evitar
   conflictos con otras instalaciones. Codifica los caracteres reservados de
   usuario y contraseña al formar la URL.
6. Inicia Docker Desktop si utilizas el contenedor incluido y ejecuta:

   ```powershell
   docker compose -p kotailor-local up -d --wait
   npm run db:migrate
   npm run start:dev
   ```

7. En otra terminal, desde el frontend, ejecuta `npm start` y abre
   `http://localhost:4200`. El proxy de desarrollo envía `/api` al backend.
   Usa `localhost` de forma consistente; no mezcles `localhost` y `127.0.0.1`
   porque las cookies de sesión dependen del nombre de host.

El inicio de sesión lleva a `/inicio`. Con un taller seleccionado se
pueden listar, buscar y crear clientes desde `/clientes`; las operaciones
comprueban la membresía del taller y las escrituras verifican el origen.
Todos los roles actuales del taller tienen acceso a estos datos. La búsqueda
devuelve hasta 100 resultados; para encontrar otros se debe ajustar el filtro.
No se crean clientes de ejemplo automáticamente. La ficha permite guardar
versiones verificadas de medidas en centímetros para pantalón de damas, camisas,
chaquetas y vestidos. Cada versión registra al usuario verificador y conserva
las anteriores por prenda. Todos los miembros del taller pueden verificar.
El catálogo de `/prendas` permite buscar, crear y editar prendas o servicios para el
taller, con precio en centavos de DOP, clasificación tributaria y plantillas de
medidas. Todos los miembros pueden crear entradas. El sistema no determina la
clasificación fiscal, calcula impuestos ni emite comprobantes; el taller debe
confirmar el tratamiento aplicable. Los cambios concurrentes se rechazan para
evitar sobrescrituras.

En `/ordenes` se pueden crear y consultar órdenes con un cliente, una entrada
del catálogo y una versión verificada por cada plantilla de medidas requerida.
Se conserva una copia de las medidas, del precio y de la tasa utilizada. El
propietario puede configurar la tasa de ITBIS del taller; los demás miembros
no pueden modificarla. Si no está configurada para una orden gravada, se
advierte y se guarda el impuesto y total como no calculados, no como cero.
Configurar o cambiar la tasa no modifica órdenes anteriores. El propietario puede
confirmar `POST /api/workshops/:workshopId/orders/apply-pending-itbis` con la tasa
guardada en `itbisBasisPoints`. Si la tasa coincide con la actual, se completan
las órdenes gravadas pendientes y sus borradores vinculados en una transacción.
Los borradores conservan su numeración y registran una nueva revisión. El ajuste
no cambia órdenes ya calculadas ni facturas emitidas. Las fechas y horas
de entrega corresponden a `America/Santo_Domingo`. Todos los miembros actuales
pueden crear y consultar órdenes. Propietarios y encargados pueden avanzar o
retroceder una etapa a la vez, incluso revertir una entrega a «Lista para
entregar». Cada cambio se guarda transaccionalmente con autor, fecha y estados;
los cambios concurrentes se rechazan. La ficha muestra los 100 cambios más
recientes. Los propietarios y encargados pueden registrar cobros parciales y
devoluciones en cada orden con total calculado. Se bloquean sobrepagos y
devoluciones superiores al cobro original, incluso con solicitudes concurrentes;
los movimientos conservan autor y motivo de devolución. El resumen de `/pagos`
se obtiene de los movimientos reales y presenta cobros del día y mes, cuentas
por cobrar y hasta 100 movimientos recientes; los cobros pueden guardar una
referencia opcional. No se procesan pagos en línea ni se emiten comprobantes fiscales. No hay edición de órdenes; la determinación de impuestos debe ser revisada por
el taller y sus asesores.
La vista `/produccion` consulta las órdenes sin entregar por etapa y muestra
hasta 20 por etapa, ordenadas por fecha de entrega, con sus totales reales. Para
localizar otras órdenes se utiliza la búsqueda; las tareas individuales todavía
no están disponibles. El filtro semanal comprende de lunes a
domingo en `America/Santo_Domingo` y no incluye entregas de semanas anteriores.
El filtro de responsable usa el identificador de la cuenta asignada; las
asignaciones antiguas que solo conservan un nombre se agrupan por separado y
no se atribuyen automáticamente a una cuenta.
El backend incluye una primera etapa de invitaciones de administradores:
un administrador de plataforma puede crear un taller e invitar a su primer
administrador, o autorizar a una persona a crear un taller; el propietario puede
invitar a otro administrador. Los enlaces vencen después de 168 horas, solo
puede aceptarlos la cuenta Google del correo indicado y el servidor almacena
únicamente el hash del token. La aceptación y la concesión del permiso se
registran transaccionalmente. La aplicación permite generar y aceptar estas
invitaciones y seleccionar un taller. El enlace debe compartirse manualmente
con la persona invitada.

Los administradores y encargados del taller también pueden invitar clientes.
Tras iniciar sesión con el correo verificado de la invitación, la persona puede
seleccionar una ficha del mismo taller con ese correo o crear una ficha nueva
con nombre y teléfono. Las fichas sin correo coincidente no se pueden vincular.
Una cuenta puede vincularse a distintos talleres, con una ficha por taller. La
invitación vence a las 168 horas y debe compartirse manualmente; no se envían
correos automáticamente. El acceso y el inicio del portal muestran los talleres
vinculados a la sesión y permiten consultar las últimas medidas verificadas de la
ficha vinculada en cada taller. La lista del portal requiere al menos un vínculo
como cliente; ser administrador no concede acceso a datos de otros clientes.
Una cuenta con ambos perfiles solo puede consultar sus propias fichas vinculadas.
Los borradores personales se guardan por ficha y
prenda, sin compartirlos con el taller ni alterar versiones verificadas. Un
borrador completo y guardado se puede enviar con confirmación explícita. Solo
puede existir un envío pendiente por ficha y prenda. El personal autorizado
puede revisarlo y crear una nueva versión verificada; el envío original y las
versiones anteriores se conservan, sin modificar las órdenes existentes. Al
revocar el vínculo se eliminan sus borradores y el cliente pierde acceso a sus
envíos. El portal permite gestionar las citas propias; las solicitudes de compra
del portal están pendientes.

### Facturación administrativa

Las migraciones `025_administrative_invoices.sql`,
`026_invoice_payment_links.sql` y `027_invoice_issued_total_constraint.sql`
crean los perfiles de facturación, secuencias internas por taller, facturas,
conceptos, revisiones y vínculos al ledger de cobros existente. Ejecuta
`npm run db:migrate` antes de iniciar el backend.

La migración `030_optional_invoice_tax.sql` registra el modo y la tasa histórica
sin recalcular facturas existentes. `PUT /api/workshops/:workshopId/invoice-tax-settings`
permite únicamente al propietario activar las facturas manuales sin ITBIS.
La creación y emisión validan el permiso; las emitidas no cambian cuando se
desactiva. Las facturas vinculadas conservan los importes y el tratamiento de la orden.
Reportes y el panel financiero agregan las facturas emitidas por modo de ITBIS.
La migración `028_payment_reference.sql` agrega la referencia opcional de pago
para recibos y transferencias. La migración `029_invoice_reissue_after_void.sql`
permite emitir una nueva factura de orden después de anular la anterior, siempre
que los cobros netos de la factura anulada hayan sido reembolsados.
Propietarios y encargados pueden crear borradores manuales o desde una orden,
editar borradores con control de versión, emitirlos o anularlos con motivo.
Los números anulados nunca se reutilizan y cada orden conserva como máximo una
factura activa.
La tasa se guarda como snapshot por línea; si no está configurada, el total
queda sin calcular y la emisión se bloquea. Los cobros anteriores se enlazan a
la factura de la orden en la misma transacción; los pagos posteriores usan ese
mismo ledger e idempotencia.

El perfil fiscal se consulta y guarda en `GET/PUT /api/workshops/:workshopId/billing-profile`.
Solo el propietario puede guardarlo. Un guardado admite los campos fiscales y
ambas imágenes (PNG/JPG/JPEG, hasta 60 KB cada una) en una sola operación atómica.
La ruta admite hasta 180 KB de JSON para las dos imágenes codificadas en base64.
Al emitir una factura, se copian el perfil, logo y sello vigentes dentro de la
misma transacción de emisión y su revisión. No se actualizan facturas ya emitidas
ni se sustituyen imágenes ausentes por recursos institucionales de la aplicación.

El nombre comercial es el nombre de la sastrería en todo el sistema. Se utiliza
`workshops.name` como nombre canónico y el guardado fiscal sincroniza su copia en
`workshop_billing_profiles.trade_name` en la misma operación atómica. La migración
`033_workshop_commercial_name.sql` adopta los nombres comerciales existentes sin
modificar snapshots de facturas. Si no había nombre comercial, conserva el nombre
actual de la sastrería. La razón social se mantiene como un dato fiscal diferente.
El detalle devuelve `fiscalDataMissing` con los datos ausentes en el snapshot,
no en el perfil actual. Esto permite advertir sobre facturas históricas
incompletas sin completarlas silenciosamente ni modificar documentos emitidos.

Los PDF conservan los datos históricos de la factura e incluyen la leyenda
“DOCUMENTO ADMINISTRATIVO - NO CONSTITUYE UN COMPROBANTE FISCAL AUTORIZADO POR
LA DGII”. No se emiten NCF/e-CF ni se realizan integraciones con DGII. El
perfil fiscal y la clasificación de ITBIS no constituyen asesoría ni validación
tributaria; deben ser confirmados por el taller con su asesor.

La edición y eliminación de clientes y los reportes fiscales siguen fuera del
alcance de esta fase. El resumen ejecutivo de taller está disponible en
`GET /api/workshops/:workshopId/reports/executive`; solo propietarios y
encargados pueden consultarlo. Requiere `from` y `to` en formato `YYYY-MM-DD`
(máximo 366 días) y acepta `customerId` y `status` opcionales. Calcula ventas
desde órdenes, facturación administrativa desde facturas emitidas, ingresos
desde cobros netos de devoluciones, clientes, órdenes y prendas solicitadas.
Los importes usan centavos y las fechas operativas usan `America/Santo_Domingo`.
No incluye informes fiscales ni se debe interpretar como información autorizada
por la DGII. El esquema actual no almacena cantidades disponibles ni mínimos de
inventario, por lo que ese indicador no se reporta como cero.
El campo de autorización de contacto solo registra una elección; aún no existe
un procedimiento de gestión o auditoría de consentimientos.

El acceso solicita únicamente los permisos `openid`, `email` y `profile`.
Google Calendar requiere autorización separada.
El intercambio con Google valida `state`, PKCE, `nonce`, firma, audiencia y correo
verificado; no conserva los tokens de acceso de inicio de sesión. Las sesiones se guardan en la base
de datos con cookie `HttpOnly`, `SameSite=Lax` y duración máxima de ocho horas.

Propietarios y encargados pueden autorizar Calendar por separado, listar sus
calendarios con permisos de escritura y elegir uno. Los tokens de actualización
se almacenan cifrados. No hay sincronización de citas y no se permite cambiar
el calendario seleccionado hasta implementar el traslado seguro de eventos.
La desconexión invalida autorizaciones pendientes, elimina las credenciales
locales y conserva los eventos de Google. El usuario puede revocar el permiso
desde la configuración de seguridad de Google.

Su configuración es opcional y debe incluir ambas variables:
`GOOGLE_CALENDAR_REDIRECT_URI` y `CALENDAR_TOKEN_KEY`. Para desarrollo, la URI es
`http://localhost:3000/api/calendar/google/callback`; regístrala en el
cliente OAuth de Google. La clave debe ser
aleatoria, de 32 bytes en base64url; puede generarse localmente con
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
Guárdala en un gestor de secretos y respáldala de forma segura: perderla o
cambiarla impedirá descifrar tokens guardados con la clave anterior. Nunca la
compartas por chat ni la guardes en el repositorio. La autorización de Calendar
solicita permisos para listar calendarios y gestionar eventos; estos permisos
alcanzan todos los calendarios accesibles por la cuenta autorizada.

La agenda permite consultar, crear, reprogramar y cancelar citas. Las API
autorizan a propietarios y encargados, o a clientes vinculados para su propia
ficha; el portal permite a clientes vinculados consultar, agendar, reprogramar y
cancelar sus propias citas. PostgreSQL impide
solapamientos para un responsable, incluso entre sastrerías, mediante `btree_gist`.
Las citas canceladas no bloquean horarios. Solo se comprueban conflictos con
citas de KOTAILOR, no con eventos externos de Google.

Existen componentes y pruebas de sincronización, reconciliación y traslado,
pero el procesador no se inicia y la API rechaza cambios de calendario. Una
petición remota que termine tarde después de perder la conexión a PostgreSQL
puede producir eventos huérfanos incluso tras comprobar dos veces su ausencia;
no se debe activar la cola hasta resolver y validar este caso. Se probó
aisladamente la creación y eliminación de un evento sintético real; eso no
constituye una prueba integral de la cola ni del traslado.

En producción, usa HTTPS en el frontend y el callback, almacena los secretos en
un gestor seguro, enruta `/api` hacia el backend con el mismo host público y
configura `TRUST_PROXY` solo para proxies de confianza. El limitador de NestJS
actual usa memoria local y no es suficiente para múltiples instancias; se
requiere almacenamiento compartido antes de desplegar horizontalmente.
Configura TLS para PostgreSQL y backups con restauración comprobada.

Los términos y la política de privacidad disponibles en el frontend son
**borradores**, no documentos legales definitivos. Deben completarse y revisarse
por profesionales competentes en República Dominicana antes de operar.
La implementación actual no certifica el cumplimiento de DGII ni emite e-CF.

### Pruebas

```powershell
npm test
npm run test:e2e
npm run build
npm run lint
```

Las pruebas HTTP de acceso sustituyen Google y la base de datos por dobles de
prueba; no reemplazan la validación con PostgreSQL y credenciales reales. Para
ejecutar además la prueba de sesión contra la base de datos configurada:

```powershell
$env:RUN_DB_INTEGRATION = 'true'
npm run test:e2e
Remove-Item Env:\RUN_DB_INTEGRATION
```

La prueba crea un usuario de prueba identificado de forma única y lo elimina al
terminar. No prueba el intercambio real con Google.

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

This project is already instrumented. To connect it, run this and approve the code it prints at [observe.nestjs.com/link](https://observe.nestjs.com/link) - signing up for free if you have no account:

```bash
$ npx @nestjs/observe link
```

It writes the app key and secret into `.env` and makes every `nest start` script (`start`, `start:dev`, `start:debug`) load it. In production, set `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment instead.

Or do it by hand: create an application and an API key at [observe.nestjs.com](https://observe.nestjs.com), and set the pair as `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment the app runs in.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
