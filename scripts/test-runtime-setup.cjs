const Module = require("module");
const path = require("path");

// Some local dev/demo environments do not have the optional bigint-buffer
// native addon available. Those flows do not need the native fast path, so
// route the package to its pure-JS build to avoid noisy fallback warnings.
if (
  process.platform === "win32" ||
  process.env.RYVO_FORCE_BIGINT_BUFFER_BROWSER === "1"
) {
  const originalLoad = Module._load;
  const bigintBufferBrowserEntry = path.join(
    path.dirname(require.resolve("bigint-buffer/package.json")),
    "dist",
    "browser.js"
  );

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "bigint-buffer") {
      return originalLoad(bigintBufferBrowserEntry, parent, isMain);
    }
    return originalLoad(request, parent, isMain);
  };
}
