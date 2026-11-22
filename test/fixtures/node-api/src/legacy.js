const express = require('express');
const { slow } = require('./util.cjs');

module.exports = function legacy(app) {
  app.get('/legacy', (_req, res) => res.send(slow()));
};
