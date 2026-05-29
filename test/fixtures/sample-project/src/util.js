// Plain JS (CommonJS-ish) to confirm .js parsing works.
const path = require("path");

function joinAll(...parts) {
  return parts.reduce((acc, p) => path.join(acc, p), "");
}

export const VERSION = "1.0.0";

module.exports = { joinAll };
