'use strict';

// Local server: `npm start`, or `npm run demo` for made-up data. On Vercel, api/ is used instead.

const http = require('http');
const { handle, DEMO, TIMEZONE } = require('./lib/dashboard');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

http.createServer(handle).listen(PORT, HOST, () => {
  const host = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Help Scout dashboard running at http://${host}:${PORT} (time zone ${TIMEZONE})${DEMO ? '  (DEMO DATA)' : ''}`);
});
