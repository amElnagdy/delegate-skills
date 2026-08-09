const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = function (path, data, options) {
  if (!String(path).includes("result.json")) return writeFileSync.apply(this, arguments);
  const encoding = typeof options === "string" ? options : options?.encoding;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
  const split = Math.max(1, Math.floor(bytes.length / 2));
  writeFileSync(path, bytes.subarray(0, split));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  writeFileSync(path, bytes.subarray(split), { flag: "a" });
};
syncBuiltinESMExports();
