'use strict';
const { createServer, shutdownServices } = require('../server/server');
const server = createServer({ token: process.env.WORKBENCH_SESSION_TOKEN });
server.on('error', (error) => { console.error(error); process.exit(1); });
server.listen(Number(process.env.WORKBENCH_DESKTOP_PORT), '127.0.0.1', () => process.parentPort.postMessage({ type: 'ready', port: server.address().port }));
let stopping = false;
process.parentPort.on('message', async ({ data }) => {
  if (data !== 'stop' || stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(0), 4000);
  deadline.unref();
  server.closeAllConnections();
  server.close();
  await shutdownServices();
  process.exit(0);
});
