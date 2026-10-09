'use strict';

// Vercel function serving the dashboard page (vercel.json rewrites / here).
module.exports = require('../lib/dashboard').handlePage;
