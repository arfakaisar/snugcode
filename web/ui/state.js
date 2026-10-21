// App state shared by all screens (formerly globals in app.js).
//   conn    : E2EE connection to the open PC (web/conn.js)
//   current : active screen context { m, info, session, renderer, procs, preview, ... }
//   me      : signed-in relay account { login }
//   permFromPush : permission answer from a notification button { pid, decision }, used by the renderer when that card appears
/** @type {{ conn: any, current: any, me: any, permFromPush?: { pid: string, decision: 'allow' | 'deny' } | null }} */
export const app = { conn: null, current: null, me: null, permFromPush: null };
