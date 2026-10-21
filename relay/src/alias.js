// snugcode — public address (snugcode.<account>.workers.dev). Site files are served straight from this
// worker's static assets; everything else (API, login, phone & PC WebSockets) is forwarded as-is to the
// relay worker through a service binding. The relay and its data (accounts, linked PCs) stay on the old
// worker, so there is no data migration; the original request host is kept so links & OAuth callbacks use this address.
export default {
  /** @param {Request} request @param {{ RELAY: { fetch: (r: Request) => Promise<Response> } }} env */
  fetch(request, env) {
    return env.RELAY.fetch(request);
  },
};
