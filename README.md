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
