// CommonJS helper: named imports from it must not be reported as broken.
function slugify(s) {
  return s.toLowerCase().replace(/\s+/g, '-');
}
module.exports = { slugify };
