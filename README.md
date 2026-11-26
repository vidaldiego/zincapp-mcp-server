# ZincApp MCP

The ZincApp MCP server runs locally over stdio. Set `ZINCAPP_AGENT_TOKEN` for
the existing developer and operator tools.

## Cuadrantes de RR. HH.

Para gestionar cuadrantes, configura una instancia local del MCP para el
perfil de oficina de la empresa. El perfil ya debe estar configurado y
funcionar con la CLI de ZincApp. Usa una versión de `zincapi` con
`attendance roster`.

Variables de entorno del proceso MCP

- `ZINCAPP_ROSTER_CLI` con la ruta absoluta al binario `zincapi`.
- `ZINCAPP_ROSTER_PROFILE` con el nombre fijo del perfil de oficina. Usa una
  instancia por perfil de oficina. El asistente elige la semana y los empleados
  del cuadrante dentro de los permisos de ese perfil.

La API aplica los permisos de RR. HH. de la empresa. Las herramientas de
cuadrantes funcionan por sí solas con esas dos variables. Para combinar ambas
familias de herramientas en una instancia, configura también
`ZINCAPP_AGENT_TOKEN` explícitamente. Ese token solo se usa para las
herramientas de agente.

### Flujo de trabajo

1. Busca personas con `attendance_roster_people` y consulta los turnos aptos
   con `attendance_roster_models`. Puedes limitar la vigencia a días concretos.
2. Abre un borrador con `attendance_roster_init` y elige el intervalo. Usa
   `attendance_roster_edit` para turnos, descansos, horarios habituales o
   secciones. `attendance_roster_copy` trae una semana publicada y enumera las
   excepciones. `attendance_roster_import` acepta filas estructuradas con IDs,
   días y decisiones verificadas.
3. Usa `attendance_roster_week` con `pendingOnly` para ver qué fechas faltan.
   Usa `attendance_roster_preview` para revisar los cambios y bloqueos.
4. `attendance_roster_save` deja el borrador visible a oficina.
   `attendance_roster_publish` publica la revisión exacta. Ambos muestran una
   confirmación humana si el cliente MCP admite formularios de confirmación.
   Para una propuesta que exceda el tamaño del formulario o cuando el cliente
   no lo admita, completa la revisión en la CLI con la misma cuenta.
5. Si el resultado queda sin verificar, consulta
   `attendance_roster_operation` con el UUID indicado antes de preparar otro
   envío.

Las propuestas del MCP se guardan con permisos privados en
`~/.local/state/zincapp-mcp/office-roster/<reviewId>.json`. Desde la CLI,
`zincapi --profile office attendance roster publish --review <archivo> --dry-run`
muestra todos los cambios. Quita `--dry-run` para usar la confirmación de la CLI.
Usa `save` para una revisión preparada para guardar. El ID del borrador y el ID
de la revisión son distintos.

La herramienta de importación recibe asignaciones verificadas, con la versión
exacta del turno. La carga directa de PDF y la autenticación de oficina para
un MCP remoto se tratan aparte.

## Presencia de RR. HH. (candidato B0–B5)

El candidato de laboratorio usa las mismas variables de oficina
`ZINCAPP_ROSTER_CLI` y `ZINCAPP_ROSTER_PROFILE`. Fija una versión de
`zincapi` con `attendance presencia` y configura una instancia local
por perfil. El perfil determina la empresa y los permisos vigentes.

1. `attendance_presencia_configuration_get` consulta las vigencias y la
   revisión de configuración del empleado indicado.
2. `attendance_presencia_configuration_preview` prepara el cambio para el
   empleado y la revisión seleccionados. Indica fecha de vigencia, modalidad,
   reglas y centros por sus IDs de cliente y centro.
3. `attendance_presencia_assist_preview` prepara un fichaje asistido. Indica
   empleado, acción, centro o remoto y motivo. La hora la fija el servidor
   al aplicar. Usa un UUID por intento y consérvalo para comprobar su resultado.
4. `attendance_presencia_days_list` lista jornadas y totales por estado
   con filtros de fecha, búsqueda, centro administrativo, vista y estado.
   El centro se indica con `clientId` y `centerId`. Para otra página usa
   `nextCursor` como `cursor` con los mismos filtros.
5. `attendance_presencia_days_get` devuelve el detalle de un empleado
   en una fecha lógica ISO. Incluye revisión, movimientos efectivos y
   rectificados, etiquetas de centros, correcciones, solicitudes y permisos
   de la persona operadora.
6. `attendance_presencia_requests_list` consulta solicitudes de ajuste por
   fecha, empleado y estado. Admite el mismo mecanismo de paginación.
7. `attendance_presencia_correction_preview` prepara una corrección
   `ADD`, `REPLACE`, `VOID` o `REVERT`. Indica persona, fecha lógica,
   motivo, UUID de operación y la revisión del detalle. Los instantes de
   movimientos se expresan en UTC con precisión de hasta milisegundos. En
   una jornada omitida, `ADD` puede incluir `movement` con `ENTRY` y
   `exit` con `EXIT`, cada uno con su propio instante y lugar.
8. `attendance_presencia_resolution_preview` prepara la aprobación o el
   rechazo de una solicitud. Indica `solicitudId`, persona y fecha exactas,
   UUID de operación, revisión de la jornada y motivo. La aprobación
   incluye el cambio auditado.

La respuesta de cada vista previa muestra persona, empresa, cuenta, propuesta
normalizada, fecha, revisión, huella y vencimiento. El archivo
`~/.local/state/zincapp-mcp/office-presencia/review-*/proposal.json` es privado.
Contiene la prueba de revisión necesaria para la CLI, que queda fuera de la
respuesta MCP. Facilita a la persona el comando `terminalCommand`
que figura en la respuesta. La persona lo ejecuta en su terminal,
revisa el cambio exacto y lo confirma de forma interactiva. Si la revisión
caduca o el contexto cambia, obtén una nueva vista previa antes de aplicar.
Una vez aplicada o descartada la propuesta, la persona puede eliminar su
archivo y el directorio individual de revisión.

`attendance_presencia_operation` consulta el recibo por UUID después de una
respuesta ambigua. `NOT_OBSERVED` indica que aún no consta un resultado.
`CONFIRMED`, `REJECTED` y `CANCELLED` son resoluciones registradas. Un error
de permisos, conflicto o transporte se devuelve como error. La consulta
es explícita y nunca reenvía la operación.

### Cuadrante semanal

1. Abre el lunes con `attendance_roster_week_get`. Devuelve el personal
   vigente autorizado, las celdas de borrador y publicadas, la revisión de
   cada vista y la semana publicada disponible para copiar. Para otra
   página usa `nextAfterEmployeeId` como `afterEmployeeId` con los mismos
   filtros. `attendance_roster_week_people`, `attendance_roster_week_shifts`
   y `attendance_roster_week_pending` ofrecen consultas específicas. En
   pendientes, `view: published` usa la revisión publicada.
2. Usa `attendance_roster_week_preview` con un UUID, `draftRevision`,
   `publishedRevision`, y las parejas exactas persona y fecha. Para un
   turno indica `SHIFT` y el `shiftId` del catálogo. Puedes indicar centro
   planificado, sección y minutos de pausa. Usa `REST` para descanso,
   `DRAFT` para publicar una celda del borrador y `COPY` con
   `copyFromMonday` para revisar la copia. El sábado puede quedar `PENDING`.
3. Escoge `SAVE_DRAFT` para guardar en oficina o `PUBLISH` para publicar
   las celdas revisadas. La revisión indica los bloqueos, incluidas fechas
   laborables pendientes de las personas seleccionadas. Si se puede
   aplicar, entrega a la persona `terminalCommand`.
   La CLI muestra la empresa, la cuenta, los cambios y la huella que la
   persona debe confirmar en su terminal. Usa un UUID nuevo al cambiar el
   contenido de la propuesta.
4. Si el resultado es incierto, compruébalo con
   `attendance_roster_week_operation` usando el lunes y el UUID. Para
   descargar la revisión publicada indicada por el recibo, usa
   `attendance_roster_week_pdf`. El PDF usa el ámbito vigente y se guarda
   como archivo privado. Para cambiar sólo el sábado, vuelve a revisar y
   publicar únicamente esas celdas. Los borradores de otras fechas quedan
   pendientes.

Los archivos de cuadrante se guardan en directorios privados bajo
`~/.local/state/zincapp-mcp/office-roster-week/`. La respuesta MCP omite
la prueba de confirmación y entrega la ruta local de la propuesta o del
PDF. Se pueden eliminar los archivos cuando dejen de ser necesarios.

Para la aceptación en laboratorio sintético, compila con `yarn build` y
ejecuta `node test/lab/roster-week.mjs MONDAY EMPLOYEE_ID` con un perfil
de CLI `b4-*` apuntando al laboratorio loopback. Usa una semana sin
publicar con un empleado y un turno autorizados. El recorrido modifica
el cuadrante sintético, comprueba cancelación y huella alterada, publica
la semana con sábado pendiente y comprueba el PDF de su revisión.

### Resumen y exportación XLSX

1. Usa `attendance_presencia_report_summary` con `from` y `until` en
   formato ISO. Las fechas se incluyen y el máximo son 366 días. Puedes
   acotar el resultado por `employeeIds` y `center`, con `clientId` y
   `centerId` dentro del mismo objeto. La API aplica los permisos vigentes.
2. Para pedir un XLSX, usa `attendance_presencia_export_preview` con el
   mismo filtro y un UUID de operación. Entrega a la persona el
   `terminalCommand` devuelto para que revise empresa, cuenta, periodo,
   ámbito y huella, y confirme la solicitud en su CLI interactiva.
3. Cuando la persona pida comprobar el resultado, usa
   `attendance_presencia_export_operation` con el UUID. `QUEUED` y
   `RUNNING` indican que la generación está en curso. `NOT_OBSERVED`
   indica que todavía no hay recibo. Conserva el UUID para resolver una
   respuesta ambigua. Cada consulta se hace una vez por acción explícita.
4. Cuando el estado sea `READY`, `attendance_presencia_export_xlsx`
   descarga el XLSX con los permisos vigentes. Devuelve `xlsxPath`, la
   ruta privada de un archivo local con el periodo en el nombre. Puedes
   retirar los archivos locales cuando dejen de ser necesarios.

Las propuestas y archivos XLSX quedan bajo
`~/.local/state/zincapp-mcp/office-presencia/`. La prueba de revisión sólo
está en la propuesta privada que lee la CLI. Usa un UUID distinto al
cambiar el contenido de una exportación.

### Actualización local desde MCP 1.13.0

Desde el repositorio del candidato, ejecuta `yarn build` y genera el
paquete de laboratorio con `yarn pack --filename /ruta/al/candidato.tgz`.
En el proyecto que aloja el servidor MCP, instala ese archivo con
`yarn add "file:/ruta/al/candidato.tgz"`. Conserva `ZINCAPP_ROSTER_PROFILE`
y usa en `ZINCAPP_ROSTER_CLI` el binario que incluye
`attendance presencia report`. Reinicia el servidor MCP y comprueba el
listado de herramientas. Se conservan los nombres y los argumentos de
los cuadrantes anteriores durante la transición. Las herramientas nuevas
de Presencia operan con la misma sesión de oficina.

La activación del candidato en oficina forma parte del corte coordinado.
La fixture de entrada de las pruebas se obtuvo de las secciones
`ConfigurationChange` y `AssistedPunch` del contrato de ZincAPI
`contracts/presencia/fixtures/b0-b2.json` en `4d68f5b7c`.
