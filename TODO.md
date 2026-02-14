# TODO

## Tareas Pendientes
- [x] Skills
- [x] Hacer intro de configuracion
- [x] Preview
- [ ] Log de depuracion
- [ ] Correr agente con pipeline.
- [ ] Vista movil
 
- [ ] Esta tenindo problemas para salir del plan mode y esta repitiendo las pregutnas
- [ ] Poder configurar diferentes puertos fácilmente en los diferentes worktree
- [ ] Conectar el profiler para que la AI pueda consultar la AI en caso de errores
- como hacer rollback a cierto momento y for de la converscion.
- could we use claude mem?
- Crear una gente que corrar la auditoria de seguriar y de arquitectura cada x cantidad de tiempo
- Crear aplicacion movil
- En la arquitectura pedir como se manejan los erresores, como se manejan los usuarios y los exponecial back off.
- Los estilos css deben compartirse los mas posible
To test de Intro, from the console
const settings = JSON.parse(localStorage.getItem('a-parallel-settings'));
settings.state.setupCompleted = false;
localStorage.setItem('a-parallel-settings', JSON.stringify(settings));
location.reload();
